import { LLMDriverError } from "../errors.js";
import type { Config, Request, Response, Usage } from "../types.js";
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

  const buildCommand = (request: Request): Command => {
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
    args.push(...extraArgs, "-");
    return { executable, args, stdin: renderTranscript(request.messages) };
  };

  const run = async (
    request: Request,
    signal?: AbortSignal,
  ): Promise<{ response: Response; reasoning: string[] }> => {
    const command = buildCommand(request);
    const { stdout, failure } = await executeCli(
      "openai",
      command,
      runner,
      signal,
      config.timeoutMs,
    );
    if (failure) throw preferReportedFailure(failure, stdout, config.model);
    return parseCodexOutput(stdout, config.model);
  };

  return {
    generate: async (request, signal) => (await run(request, signal)).response,

    /**
     * Coarse by design: `codex exec --json` reports completed items only — no
     * text deltas — so text arrives as one event after the turn ends. Reasoning
     * items, when the JSONL exposes them, are surfaced (in source order, before
     * the final text) and never fold into `response.text`; codex reports none on
     * many turns, in which case none are emitted (matrix ⚠️).
     * TODO: switch to real deltas if `codex exec --json` ever documents them.
     */
    async *generateStream(request, signal) {
      const { response, reasoning } = await run(request, signal);
      for (const text of reasoning) yield { type: "reasoning", text };
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
    toolCalls: [],
  };
  return { response, reasoning };
}

function reportedFailure(providerCode: string, message: string, fallback: string): LLMDriverError {
  return cliError("openai", "api_error", message.trim() || fallback, { providerCode });
}
