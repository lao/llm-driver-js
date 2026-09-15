import { LLMDriverError } from "../errors.js";
import type {
  CompletionReason,
  Config,
  Request,
  Response,
  StreamEvent,
  ToolCallRecord,
  Usage,
} from "../types.js";
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
  stageImages,
  streamCli,
} from "./cli.js";
import { type McpBridge, start as startBridge } from "./mcp-bridge.js";

/** Non-interactive `opencode run`, raw JSON events on stdout. */
const BASE_ARGS = ["run", "--format", "json"];

/**
 * Local `opencode run` process backend (`opencode`/`cli`).
 *
 * opencode is a multi-provider harness: `--model` takes any `provider/model` id
 * the local install can reach (enumerate them with {@link listOpencodeModels}).
 * Its raw JSON event stream is the transport contract; a reasoning request adds
 * `--thinking` (surfaces reasoning parts) and `--variant` (the effort knob).
 * Caller tools ride in as a remote MCP server through `OPENCODE_CONFIG_CONTENT`,
 * and image blocks through `-f` temp files.
 * `runner`/`streamRunner` are internal seams, never public API.
 */
export function createOpencodeCliBackend(
  config: Config,
  runner: CommandRunner = spawnRunner,
  streamRunner: StreamingCommandRunner = spawnStreamRunner,
): Backend {
  const executable = config.cliPath ?? "opencode";
  const extraArgs = config.cliArgs ?? [];

  const buildCommand = (
    request: Request,
    bridge?: McpBridge,
    imageArgs: string[] = [],
  ): Command => {
    const args = [...BASE_ARGS, "--model", config.model];
    if (request.reasoning) {
      // `--thinking` surfaces reasoning parts and `--variant` is opencode's
      // provider-specific reasoning-effort knob. Neutral levels pass through and
      // an unknown level surfaces opencode's error.
      args.push("--thinking", "--variant", request.reasoning.effort);
    }
    args.push(...imageArgs, ...extraArgs);
    const command: Command = { executable, args, stdin: renderPrompt(request) };
    if (bridge) command.env = { OPENCODE_CONFIG_CONTENT: bridgeConfig(bridge) };
    return command;
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
      let cleanupImages: (() => Promise<void>) | undefined;
      try {
        const staged = await stageImages(request, "opencode", "-f");
        cleanupImages = staged.cleanup;
        const command = buildCommand(request, bridge, staged.imageArgs);
        const { stdout, failure } = await executeCli(
          "opencode",
          command,
          runner,
          signal,
          config.timeoutMs,
        );
        // The CLI can exit while a tool-call response is still in flight; wait for
        // the bridge's handlers to settle before snapshotting records (and before
        // the finally closes the server).
        await bridge?.idle();
        if (failure) throw preferReportedFailure(failure, stdout, config.model);
        return parseOpencodeOutput(stdout, config.model, bridge?.records ?? []);
      } finally {
        await cleanupImages?.();
        await bridge?.close();
      }
    },

    async *generateStream(request, signal) {
      // The bridge's onCall fires from the HTTP handler concurrently with stdout
      // reads, so buffer its events and flush them into the generator's own yield
      // stream (tool_call before its tool_result, both before `done`).
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
      let cleanupImages: (() => Promise<void>) | undefined;

      try {
        const staged = await stageImages(request, "opencode", "-f");
        cleanupImages = staged.cleanup;
        const command = buildCommand(request, bridge, staged.imageArgs);
        const run = newRun();
        let index = 0;

        for await (const line of streamCli(
          "opencode",
          command,
          streamRunner,
          signal,
          config.timeoutMs,
        )) {
          while (pending.length > 0) yield pending.shift() as StreamEvent;
          index += 1;
          if (line.trim() === "") continue;
          const event = parseJsonObject("opencode", `decode OpenCode CLI event ${index}`, line);
          const emitted = parseEvent(run, event);
          if (emitted !== undefined) yield emitted;
        }

        // The CLI can exit while a tool-call response is still in flight; wait for
        // the bridge's handlers to settle so their events are queued before the flush.
        await bridge?.idle();
        while (pending.length > 0) yield pending.shift() as StreamEvent;
        if (!run.finished) {
          throw cliError(
            "opencode",
            "parse_failed",
            "OpenCode CLI output did not complete a step",
            {
              providerCode: "missing_step_finish",
            },
          );
        }
        yield { type: "done", response: toResponse(run, config.model, bridge?.records ?? []) };
      } finally {
        await cleanupImages?.();
        await bridge?.close();
      }
    },
  };
}

/**
 * opencode has no system-prompt flag, so a system instruction rides at the head
 * of the stdin transcript. A lone user message keeps its v1 verbatim form when
 * no system is set.
 */
function renderPrompt(request: Request): string {
  const transcript = renderTranscript(request.messages);
  return request.system ? `System: ${request.system}\n\n${transcript}` : transcript;
}

/**
 * Inline config handing opencode the loopback MCP bridge as a remote server
 * (`OPENCODE_CONFIG_CONTENT` overrides for the run only; OAuth is off since the
 * endpoint is loopback).
 */
function bridgeConfig(bridge: McpBridge): string {
  return JSON.stringify({
    mcp: { llmdriver: { type: "remote", url: bridge.url, oauth: false } },
  });
}

/** Mutable state gathered from one run's JSON event stream. */
interface OpencodeRun {
  id: string;
  /** Text of the step in progress; reset at each `step_start`. */
  stepText: string;
  /** Text of the last completed step — the final assistant message. */
  text: string;
  completionReason: CompletionReason;
  finished: boolean;
  usage: Usage;
}

function newRun(): OpencodeRun {
  return {
    id: "",
    stepText: "",
    text: "",
    completionReason: "",
    finished: false,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
    },
  };
}

/**
 * Folds one opencode JSON event into `run`, returning the stream event it emits
 * (`text`/`reasoning`) or `undefined` for bookkeeping events. An `error` event
 * throws `api_error` immediately.
 */
function parseEvent(run: OpencodeRun, event: Record<string, unknown>): StreamEvent | undefined {
  const sessionId = readString(event, "sessionID");
  if (sessionId !== "") run.id = sessionId;
  const part = asRecord(event.part);

  switch (readString(event, "type")) {
    case "step_start":
      run.stepText = "";
      run.finished = false;
      return undefined;
    case "text": {
      const text = readString(part, "text");
      if (text === "") return undefined;
      run.stepText += text;
      return { type: "text", text };
    }
    case "reasoning": {
      const text = readString(part, "text");
      return text === "" ? undefined : { type: "reasoning", text };
    }
    case "step_finish":
      // Each step is one model turn; the last step's text is the final message,
      // and usage sums across steps (opencode bills every turn of its own loop).
      run.text = run.stepText;
      run.completionReason = completionReason(readString(part, "reason"));
      run.finished = true;
      addUsage(run.usage, asRecord(part.tokens));
      return undefined;
    case "error":
      throw opencodeFailure(asRecord(event.error));
    default:
      return undefined;
  }
}

function completionReason(reason: string): CompletionReason {
  if (reason === "stop") return "stop";
  if (reason === "length") return "max_tokens";
  return "";
}

function addUsage(usage: Usage, tokens: Record<string, unknown>): void {
  usage.inputTokens += readCount(tokens, "input");
  usage.outputTokens += readCount(tokens, "output");
  usage.reasoningTokens += readCount(tokens, "reasoning");
  const cache = asRecord(tokens.cache);
  usage.cachedInputTokens += readCount(cache, "read");
  usage.cacheCreationInputTokens += readCount(cache, "write");
}

function opencodeFailure(error: Record<string, unknown>): LLMDriverError {
  const message = readString(error, "message").trim();
  // opencode's transport errors carry a bare `_tag` (e.g. "BadRequest").
  const tag = readString(error, "_tag") || readString(error, "name");
  return cliError("opencode", "api_error", message || "OpenCode run failed", {
    providerCode: tag || "error",
  });
}

function parseOpencodeOutput(stdout: string, model: string, toolCalls: ToolCallRecord[]): Response {
  const run = newRun();
  for (const [index, line] of stdout.split("\n").entries()) {
    if (line.trim() === "") continue;
    // parseEvent folds the event into `run`; its returned delta is stream-only.
    parseEvent(run, parseJsonObject("opencode", `decode OpenCode CLI event ${index + 1}`, line));
  }
  if (!run.finished) {
    throw cliError("opencode", "parse_failed", "OpenCode CLI output did not complete a step", {
      providerCode: "missing_step_finish",
    });
  }
  return toResponse(run, model, toolCalls);
}

function toResponse(run: OpencodeRun, model: string, toolCalls: ToolCallRecord[]): Response {
  return {
    id: run.id,
    model,
    text: run.text,
    usage: run.usage,
    completionReason: run.completionReason,
    provider: "opencode",
    flavor: "cli",
    toolCalls,
  };
}

/**
 * A crashed `opencode run` usually still streams the failing event, so a reported
 * error beats the bare exit code — keeping the exit code as the status.
 */
function preferReportedFailure(
  failure: LLMDriverError,
  stdout: string,
  model: string,
): LLMDriverError {
  if (failure.status === undefined) return failure;
  try {
    parseOpencodeOutput(stdout, model, []);
  } catch (diagnostic) {
    if (diagnostic instanceof LLMDriverError && diagnostic.code === "api_error") {
      return cliError("opencode", diagnostic.code, diagnostic.message, {
        status: failure.status,
        providerCode: diagnostic.providerCode,
        cause: diagnostic.cause,
      });
    }
  }
  return failure;
}
