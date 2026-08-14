import type {
  Config,
  JsonSchema,
  Request,
  Response,
  StreamEvent,
  ToolCallRecord,
} from "../types.js";
import type { Backend } from "./backend.js";
import {
  asRecord,
  type Command,
  type CommandRunner,
  cliError,
  executeCli,
  hasContentBlocks,
  parseJsonObject,
  parseStructuredText,
  readCount,
  readString,
  renderStreamJson,
  renderTranscript,
  type StreamingCommandRunner,
  spawnRunner,
  spawnStreamRunner,
  streamCli,
} from "./cli.js";
import { type McpBridge, start as startBridge } from "./mcp-bridge.js";

/** Print-mode output selection: one JSON result, or the partial-message stream. */
const JSON_MODE = ["-p", "--output-format", "json"];
// `claude` refuses stream-json in print mode without --verbose.
const STREAM_MODE = [
  "-p",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
];

/**
 * Local `claude -p` process backend (`claude`/`cli`).
 *
 * The flags target the non-interactive print-mode contract: print mode is
 * single-shot, and the default permission mode keeps a headless run from
 * approving agent tool actions. Default tests inject a fake runner and cannot
 * catch a renamed flag, so the opt-in integration test exercises the real
 * binary. `runner`/`streamRunner` are internal seams, never public API.
 */
export function createClaudeCliBackend(
  config: Config,
  runner: CommandRunner = spawnRunner,
  streamRunner: StreamingCommandRunner = spawnStreamRunner,
): Backend {
  const executable = config.cliPath ?? "claude";
  const extraArgs = config.cliArgs ?? [];

  const buildCommand = (request: Request, mode: string[], bridge?: McpBridge): Command => {
    // Content blocks (images) can only ride in over stream-json stdin. Text-only
    // requests keep the v1 plain-stdin path byte-for-byte — no extra flag, same
    // transcript bytes (regression-asserted in the suite).
    const blocks = hasContentBlocks(request.messages);
    const args = [...mode];
    if (blocks) args.push("--input-format", "stream-json");
    args.push("--permission-mode", "default", "--model", config.model);
    if (request.system) {
      args.push("--append-system-prompt", request.system);
    }
    if (request.reasoning) {
      args.push("--effort", request.reasoning.effort);
    }
    if (bridge) {
      // Inject the caller's tools into the CLI's own agentic loop as an MCP
      // server, and pre-allow each so a headless run never blocks on a
      // permission prompt. Built-in tools keep their v1 defaults.
      const mcpConfig = { mcpServers: { llmdriver: { type: "http", url: bridge.url } } };
      args.push("--mcp-config", JSON.stringify(mcpConfig), "--strict-mcp-config");
      for (const tool of request.tools ?? []) {
        args.push("--allowedTools", `mcp__llmdriver__${tool.name}`);
      }
    }
    if (request.outputSchema) {
      args.push("--json-schema", JSON.stringify(request.outputSchema));
    }
    args.push(...extraArgs);
    const stdin = blocks ? renderStreamJson(request.messages) : renderTranscript(request.messages);
    return { executable, args, stdin };
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

  return {
    async generate(request, signal) {
      const bridge = await openBridge(request, signal);
      try {
        const command = buildCommand(request, JSON_MODE, bridge);
        const { stdout, failure } = await executeCli(
          "claude",
          command,
          runner,
          signal,
          config.timeoutMs,
        );
        if (failure) throw failure;
        return toResponse(
          parseJsonObject("claude", "decode Claude CLI output", stdout),
          config.model,
          bridge?.records ?? [],
          request.outputSchema,
        );
      } finally {
        await bridge?.close();
      }
    },

    async *generateStream(request, signal) {
      // The bridge's onCall fires from the HTTP handler concurrently with stdout
      // reads, so buffer its events and flush them into the generator's own
      // yield stream (tool_call before its tool_result, both before `done`).
      const pending: StreamEvent[] = [];
      const bridge = await openBridge(request, signal, (record) => {
        pending.push({ type: "tool_call", id: record.id, name: record.name, input: record.input });
        pending.push({
          type: "tool_result",
          id: record.id,
          name: record.name,
          output: record.output,
          isError: record.isError,
        });
      });

      try {
        const command = buildCommand(request, STREAM_MODE, bridge);
        let result: Record<string, unknown> | undefined;
        let index = 0;

        for await (const line of streamCli(
          "claude",
          command,
          streamRunner,
          signal,
          config.timeoutMs,
        )) {
          while (pending.length > 0) yield pending.shift() as StreamEvent;
          index += 1;
          if (line.trim() === "") continue;
          const event = parseJsonObject("claude", `decode Claude CLI event ${index}`, line);
          if (readString(event, "type") === "result") {
            result = event;
            continue;
          }
          const reasoning = partialDelta(event, "thinking_delta", "thinking");
          if (reasoning !== "") {
            // Reasoning is surfaced but never folded into `text`.
            yield { type: "reasoning", text: reasoning };
            continue;
          }
          const text = partialDelta(event, "text_delta", "text");
          if (text !== "") yield { type: "text", text };
        }

        while (pending.length > 0) yield pending.shift() as StreamEvent;
        if (result === undefined) {
          throw cliError("claude", "parse_failed", "Claude CLI output contained no result event", {
            providerCode: "missing_result",
          });
        }
        yield {
          type: "done",
          response: toResponse(result, config.model, bridge?.records ?? [], request.outputSchema),
        };
      } finally {
        await bridge?.close();
      }
    },
  };
}

/**
 * Text carried by a `--include-partial-messages` content_block_delta chunk of
 * the given delta type (`text_delta`/`thinking_delta`), reading its `field`
 * (`text`/`thinking`); `""` for anything else.
 */
function partialDelta(event: Record<string, unknown>, deltaType: string, field: string): string {
  if (readString(event, "type") !== "stream_event") return "";
  const inner = asRecord(event.event);
  if (readString(inner, "type") !== "content_block_delta") return "";
  const delta = asRecord(inner.delta);
  return readString(delta, "type") === deltaType ? readString(delta, field) : "";
}

function toResponse(
  result: Record<string, unknown>,
  model: string,
  toolCalls: ToolCallRecord[],
  outputSchema?: JsonSchema,
): Response {
  const type = readString(result, "type");
  const subtype = readString(result, "subtype");
  const isError = result.is_error === true;

  if (type !== "result" || subtype !== "success" || isError) {
    const reported = readString(result, "result");
    throw cliError(
      "claude",
      "api_error",
      reported.trim() === "" ? "Claude CLI returned an unsuccessful result" : reported,
      { providerCode: unsuccessfulCode(type, subtype, isError) },
    );
  }

  const usage = asRecord(result.usage);
  // `--json-schema` makes the model emit JSON; best knowledge is that it lands in
  // the same `result` text field as plain output, so parse it exactly like the
  // api flavors. Characterized by the opt-in integration test.
  const text = readString(result, "result");
  const response: Response = {
    id: readString(result, "session_id"),
    model,
    text,
    usage: {
      inputTokens: readCount(usage, "input_tokens"),
      outputTokens: readCount(usage, "output_tokens"),
      cachedInputTokens: readCount(usage, "cache_read_input_tokens"),
      cacheCreationInputTokens: readCount(usage, "cache_creation_input_tokens"),
      reasoningTokens: 0,
    },
    completionReason: "",
    provider: "claude",
    flavor: "cli",
    toolCalls,
  };
  if (outputSchema !== undefined) {
    response.structured = parseStructuredText("claude", text);
  }
  return response;
}

function unsuccessfulCode(type: string, subtype: string, isError: boolean): string {
  if (subtype !== "" && subtype !== "success") return subtype;
  if (isError) return "error";
  if (type !== "" && type !== "result") return type;
  return "unsuccessful_result";
}
