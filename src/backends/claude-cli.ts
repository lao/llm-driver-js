import type { Config, Request, Response } from "../types.js";
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
  type StreamingCommandRunner,
  spawnRunner,
  spawnStreamRunner,
  streamCli,
} from "./cli.js";

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

  const buildCommand = (request: Request, mode: string[]): Command => {
    const args = [...mode, "--permission-mode", "default", "--model", config.model];
    if (request.system) {
      args.push("--append-system-prompt", request.system);
    }
    if (request.reasoning) {
      args.push("--effort", request.reasoning.effort);
    }
    args.push(...extraArgs);
    return { executable, args, stdin: renderTranscript(request.messages) };
  };

  return {
    async generate(request, signal) {
      const command = buildCommand(request, JSON_MODE);
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
      );
    },

    async *generateStream(request, signal) {
      const command = buildCommand(request, STREAM_MODE);
      let result: Record<string, unknown> | undefined;
      let index = 0;

      for await (const line of streamCli(
        "claude",
        command,
        streamRunner,
        signal,
        config.timeoutMs,
      )) {
        index += 1;
        if (line.trim() === "") continue;
        const event = parseJsonObject("claude", `decode Claude CLI event ${index}`, line);
        if (readString(event, "type") === "result") {
          result = event;
          continue;
        }
        const text = partialText(event);
        if (text !== "") yield { type: "text", text };
      }

      if (result === undefined) {
        throw cliError("claude", "parse_failed", "Claude CLI output contained no result event", {
          providerCode: "missing_result",
        });
      }
      yield { type: "done", response: toResponse(result, config.model) };
    },
  };
}

/** Text carried by a `--include-partial-messages` chunk; `""` for anything else. */
function partialText(event: Record<string, unknown>): string {
  if (readString(event, "type") !== "stream_event") return "";
  const inner = asRecord(event.event);
  if (readString(inner, "type") !== "content_block_delta") return "";
  const delta = asRecord(inner.delta);
  return readString(delta, "type") === "text_delta" ? readString(delta, "text") : "";
}

function toResponse(result: Record<string, unknown>, model: string): Response {
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
  return {
    id: readString(result, "session_id"),
    model,
    text: readString(result, "result"),
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
  };
}

function unsuccessfulCode(type: string, subtype: string, isError: boolean): string {
  if (subtype !== "" && subtype !== "success") return subtype;
  if (isError) return "error";
  if (type !== "" && type !== "result") return type;
  return "unsuccessful_result";
}
