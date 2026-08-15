import { LLMDriverError } from "../errors.js";
import type { Config, Request, Response, StreamEvent, ToolCallRecord, Usage } from "../types.js";
import type { Backend } from "./backend.js";
import {
  asRecord,
  type Command,
  type CommandRunner,
  cliError,
  executeCli,
  parseJsonObject,
  readCount,
  readString,
  renderTranscript,
  spawnRunner,
} from "./cli.js";
import { type McpBridge, start as startBridge } from "./mcp-bridge.js";

/**
 * Local `codex exec` process backend (`openai`/`cli`).
 *
 * The flags target the non-interactive `codex exec` contract: JSONL events, a
 * read-only sandbox, no git-repo check, and a trailing `-` so the prompt is
 * read from stdin. Default tests inject a fake runner and cannot catch a
 * renamed flag, so the opt-in integration test exercises the real binary.
 * `runner` is an internal seam, never public API.
 */
export function createCodexCliBackend(
  config: Config,
  runner: CommandRunner = spawnRunner,
): Backend {
  const executable = config.cliPath ?? "codex";
  const extraArgs = config.cliArgs ?? [];

  const buildCommand = (request: Request, bridge?: McpBridge): Command => {
    const args = [
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--model",
      config.model,
    ];
    if (request.system) {
      args.push("--config", `developer_instructions=${JSON.stringify(request.system)}`);
    }
    if (request.reasoning) {
      // TOML string value, so the level is quoted (matches the developer_instructions form).
      args.push("-c", `model_reasoning_effort=${JSON.stringify(request.reasoning.effort)}`);
    }
    if (bridge) {
      // Inject the caller's tools into codex's own agentic loop as a
      // streamable-HTTP MCP server (codex 0.147). Codex has no `--strict-mcp-config`
      // equivalent, and read-only sandbox needs no per-tool pre-allow.
      //
      // FLAG (SPEC-v2 open question 4): the exact `-c mcp_servers.*` dotted-key
      // syntax for a streamable-HTTP transport is only truly confirmable against
      // the real binary — encoded here per SPEC as best knowledge and
      // characterized by the env-gated integration test.
      args.push("-c", `mcp_servers.llmdriver.url=${JSON.stringify(bridge.url)}`);
    }
    args.push(...extraArgs, "-");
    return { executable, args, stdin: renderTranscript(request.messages) };
  };

  /** Starts the tool bridge when the request has tools, else nothing to run. */
  const openBridge = (
    request: Request,
    signal: AbortSignal | undefined,
    onCall?: (record: ToolCallRecord) => void,
  ): Promise<McpBridge> | undefined => {
    const tools = request.tools ?? [];
    return tools.length > 0 ? startBridge(tools, { signal, onCall }) : undefined;
  };

  /** Runs the subprocess with the bridge open, tearing it down on every exit. */
  const run = async (
    request: Request,
    signal?: AbortSignal,
    onCall?: (record: ToolCallRecord) => void,
  ): Promise<{ response: Response; reasoning: string[] }> => {
    const bridge = await openBridge(request, signal, onCall);
    try {
      const command = buildCommand(request, bridge);
      const { stdout, failure } = await executeCli(
        "openai",
        command,
        runner,
        signal,
        config.timeoutMs,
      );
      if (failure) throw preferReportedFailure(failure, stdout, config.model);
      return parseCodexOutput(stdout, config.model, bridge?.records ?? []);
    } finally {
      await bridge?.close();
    }
  };

  return {
    generate: async (request, signal) => (await run(request, signal)).response,

    /**
     * Coarse by design: `codex exec --json` reports completed items only — no
     * text deltas — so the whole turn arrives at once. Reasoning items, when the
     * JSONL exposes them, are surfaced (in source order, before the final text)
     * and never fold into `response.text`; codex reports none on many turns, in
     * which case none are emitted (matrix ⚠️). Any tool calls made mid-turn are
     * buffered via the bridge's `onCall` and flushed as `tool_call`/`tool_result`
     * events (all before `done`), then the final text.
     * TODO: switch to real deltas if `codex exec --json` ever documents them.
     */
    async *generateStream(request, signal) {
      const pending: StreamEvent[] = [];
      const { response, reasoning } = await run(request, signal, (record) => {
        pending.push({ type: "tool_call", id: record.id, name: record.name, input: record.input });
        pending.push({
          type: "tool_result",
          id: record.id,
          name: record.name,
          output: record.output,
          isError: record.isError,
        });
      });
      for (const text of reasoning) yield { type: "reasoning", text };
      for (const event of pending) yield event;
      if (response.text !== "") yield { type: "text", text: response.text };
      yield { type: "done", response };
    },
  };
}

/**
 * A crashed `codex exec` usually still streams why it failed, so a reported
 * turn failure beats the bare exit code — keeping the exit code as the status.
 */
function preferReportedFailure(
  failure: LLMDriverError,
  stdout: string,
  model: string,
): LLMDriverError {
  if (failure.status === undefined) return failure;
  try {
    parseCodexOutput(stdout, model);
  } catch (diagnostic) {
    if (
      diagnostic instanceof LLMDriverError &&
      (diagnostic.providerCode === "turn_failed" || diagnostic.providerCode === "error")
    ) {
      return cliError("openai", diagnostic.code, diagnostic.message, {
        status: failure.status,
        providerCode: diagnostic.providerCode,
        cause: diagnostic.cause,
      });
    }
  }
  return failure;
}

function parseCodexOutput(
  stdout: string,
  model: string,
  toolCalls: ToolCallRecord[] = [],
): { response: Response; reasoning: string[] } {
  let id = "";
  let text: string | undefined;
  const reasoning: string[] = [];
  // Set by `turn.completed`, so its presence is what marks the turn complete.
  let usage: Usage | undefined;

  for (const [index, line] of stdout.split("\n").entries()) {
    if (line.trim() === "") continue;
    const event = parseJsonObject("openai", `decode Codex CLI event ${index + 1}`, line);

    switch (readString(event, "type")) {
      case "thread.started":
        id = readString(event, "thread_id");
        break;
      case "item.completed": {
        const item = asRecord(event.item);
        if (readString(item, "type") === "agent_message") {
          text = readString(item, "text");
        } else if (readString(item, "type") === "reasoning") {
          const reasoningText = readString(item, "text");
          if (reasoningText !== "") reasoning.push(reasoningText);
        }
        break;
      }
      case "turn.completed": {
        const reported = asRecord(event.usage);
        usage = {
          inputTokens: readCount(reported, "input_tokens"),
          outputTokens: readCount(reported, "output_tokens"),
          cachedInputTokens: readCount(reported, "cached_input_tokens"),
          cacheCreationInputTokens: readCount(reported, "cache_write_input_tokens"),
          reasoningTokens: readCount(reported, "reasoning_output_tokens"),
        };
        break;
      }
      case "turn.failed":
        throw reportedFailure(
          "turn_failed",
          readString(asRecord(event.error), "message"),
          "Codex CLI turn failed",
        );
      case "error":
        throw reportedFailure("error", readString(event, "message"), "Codex CLI stream failed");
    }
  }

  if (usage === undefined) {
    throw cliError("openai", "parse_failed", "Codex CLI output did not complete a turn", {
      providerCode: "missing_turn_completion",
    });
  }
  if (text === undefined) {
    throw cliError(
      "openai",
      "parse_failed",
      "Codex CLI output did not contain a completed agent message",
      { providerCode: "missing_final_message" },
    );
  }
  const response: Response = {
    id,
    model,
    text,
    usage,
    completionReason: "",
    provider: "openai",
    flavor: "cli",
    toolCalls,
  };
  return { response, reasoning };
}

function reportedFailure(providerCode: string, message: string, fallback: string): LLMDriverError {
  return cliError("openai", "api_error", message.trim() || fallback, { providerCode });
}
