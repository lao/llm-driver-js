import type { Config, Response } from "../types.js";
import type { Backend } from "./backend.js";
import {
  asRecord,
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
 * Local `claude -p` process backend (`claude`/`cli`).
 *
 * The flags target the non-interactive print-mode contract: print mode is
 * single-shot, and the default permission mode keeps a headless run from
 * approving agent tool actions. Default tests inject a fake runner and cannot
 * catch a renamed flag, so the opt-in integration test exercises the real
 * binary. `runner` is an internal seam and is never part of the public API.
 */
export function createClaudeCliBackend(
  config: Config,
  runner: CommandRunner = spawnRunner,
): Backend {
  const executable = config.cliPath ?? "claude";
  const extraArgs = config.cliArgs ?? [];

  return {
    async generate(request, signal) {
      const args = [
        "-p",
        "--output-format",
        "json",
        "--permission-mode",
        "default",
        "--model",
        config.model,
      ];
      if (request.system) {
        args.push("--append-system-prompt", request.system);
      }
      args.push(...extraArgs);

      const command = { executable, args, stdin: renderTranscript(request.messages) };
      const { stdout, failure } = await executeCli("claude", command, runner, signal);
      if (failure) throw failure;
      return parseClaudeOutput(stdout, config.model);
    },
  };
}

function parseClaudeOutput(stdout: string, model: string): Response {
  const result = parseJsonObject("claude", "decode Claude CLI output", stdout);
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
