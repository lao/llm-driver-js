import { LLMWrapperError } from "../errors.js";
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
 * Local `codex exec` process backend (`openai`/`cli`).
 *
 * The flags target the non-interactive `codex exec` contract: JSONL events, a
 * read-only sandbox, no git-repo check, and a trailing `-` so the prompt is
 * read from stdin. Default tests inject a fake runner and cannot catch a
 * renamed flag, so the opt-in integration test exercises the real binary.
 * `runner` is an internal seam and is never part of the public API.
 */
export function createCodexCliBackend(
  config: Config,
  runner: CommandRunner = spawnRunner,
): Backend {
  const executable = config.cliPath ?? "codex";
  const extraArgs = [...(config.cliArgs ?? [])];

  return {
    async generate(request, signal) {
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
      args.push(...extraArgs, "-");

      const command = { executable, args, stdin: renderTranscript(request.messages) };
      const { stdout, failure } = await executeCli("openai", command, runner, signal);
      if (failure) throw preferReportedFailure(failure, stdout, config.model);
      return parseCodexOutput(stdout, config.model);
    },
  };
}

/**
 * A crashed `codex exec` usually still streams why it failed, so a reported
 * turn failure beats the bare exit code — keeping the exit code as the status.
 */
function preferReportedFailure(
  failure: LLMWrapperError,
  stdout: string,
  model: string,
): LLMWrapperError {
  if (failure.status === undefined) return failure;
  try {
    parseCodexOutput(stdout, model);
  } catch (diagnostic) {
    if (
      diagnostic instanceof LLMWrapperError &&
      (diagnostic.providerCode === "turn_failed" || diagnostic.providerCode === "error")
    ) {
      return cliError("openai", diagnostic.code, diagnostic.message, {
        status: failure.status,
        providerCode: diagnostic.providerCode,
      });
    }
  }
  return failure;
}

function parseCodexOutput(stdout: string, model: string): Response {
  const response: Response = {
    id: "",
    model,
    text: "",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
    },
    completionReason: "",
    provider: "openai",
    flavor: "cli",
  };
  let completed = false;
  let hasFinalMessage = false;

  for (const [index, line] of stdout.split("\n").entries()) {
    if (line.trim() === "") continue;
    const event = parseJsonObject("openai", `decode Codex CLI event ${index + 1}`, line);

    switch (readString(event, "type")) {
      case "thread.started":
        response.id = readString(event, "thread_id");
        break;
      case "item.completed": {
        const item = asRecord(event.item);
        if (readString(item, "type") === "agent_message") {
          response.text = readString(item, "text");
          hasFinalMessage = true;
        }
        break;
      }
      case "turn.completed": {
        const usage = asRecord(event.usage);
        completed = true;
        response.usage = {
          inputTokens: readCount(usage, "input_tokens"),
          outputTokens: readCount(usage, "output_tokens"),
          cachedInputTokens: readCount(usage, "cached_input_tokens"),
          cacheCreationInputTokens: readCount(usage, "cache_write_input_tokens"),
          reasoningTokens: readCount(usage, "reasoning_output_tokens"),
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
      default:
        break;
    }
  }

  if (!completed) {
    throw cliError("openai", "parse_failed", "Codex CLI output did not complete a turn", {
      providerCode: "missing_turn_completion",
    });
  }
  if (!hasFinalMessage) {
    throw cliError(
      "openai",
      "parse_failed",
      "Codex CLI output did not contain a completed agent message",
      { providerCode: "missing_final_message" },
    );
  }
  return response;
}

function reportedFailure(providerCode: string, message: string, fallback: string): LLMWrapperError {
  return cliError("openai", "api_error", message.trim() || fallback, { providerCode });
}
