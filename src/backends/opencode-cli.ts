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
  withTempFile,
} from "./cli.js";
import { type McpBridge, start as startBridge } from "./mcp-bridge.js";

/** Non-interactive `opencode run`, raw JSON events on stdout. */
const BASE_ARGS = ["run", "--format", "json"];
// ponytail: usage recovery is best-effort; raise only if real exports regularly exceed 1 s.
const USAGE_RECOVERY_TIMEOUT_MS = 1_000;

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

  const requestDeadline = (caller: AbortSignal | undefined) => {
    const deadline =
      config.timeoutMs === undefined ? undefined : performance.now() + config.timeoutMs;
    const timeoutSignal =
      config.timeoutMs === undefined ? undefined : AbortSignal.timeout(config.timeoutMs);
    const signal =
      caller && timeoutSignal
        ? AbortSignal.any([caller, timeoutSignal])
        : (caller ?? timeoutSignal);
    return {
      signal,
      deadline,
      error: () =>
        caller?.aborted
          ? caller.reason
          : timeoutSignal?.aborted
            ? cliError(
                "opencode",
                "process_failed",
                `CLI command timed out after ${config.timeoutMs} ms`,
                { providerCode: "timeout" },
              )
            : signal?.reason,
    };
  };

  const buildCommand = (
    request: Request,
    bridge?: McpBridge,
    imageArgs: string[] = [],
    instructionPath?: string,
  ): Command => {
    const args = [...BASE_ARGS, "--model", config.model];
    if (request.reasoning) {
      // `--thinking` surfaces reasoning parts and `--variant` is opencode's
      // provider-specific reasoning-effort knob. Neutral levels pass through and
      // an unknown level surfaces opencode's error.
      args.push("--thinking", "--variant", request.reasoning.effort);
    }
    args.push(...imageArgs, ...extraArgs);
    // opencode has no system-prompt flag, so `system` rides as an instruction
    // file through the inline config — a true system-level input, not prompt text.
    // The transcript goes on stdin (opencode reads piped non-TTY stdin), keeping
    // the conversation out of argv where process inspection or command logging
    // could capture it.
    const command: Command = { executable, args, stdin: renderTranscript(request.messages) };
    const env = opencodeConfig(bridge, instructionPath);
    if (env) command.env = { OPENCODE_CONFIG_CONTENT: env };
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
      const requestTimer = requestDeadline(signal);
      const bridge = await openBridge(request, requestTimer.signal);
      let cleanupImages: (() => Promise<void>) | undefined;
      let cleanupInstruction: (() => Promise<void>) | undefined;
      try {
        const staged = await stageImages(request, "opencode", "-f");
        cleanupImages = staged.cleanup;
        const instruction = request.system
          ? await withTempFile("system.md", request.system)
          : undefined;
        cleanupInstruction = instruction?.cleanup;
        const command = buildCommand(request, bridge, staged.imageArgs, instruction?.path);
        const deadline = requestTimer.deadline;
        let stdout: string;
        let failure: LLMDriverError | undefined;
        try {
          ({ stdout, failure } = await executeCli(
            "opencode",
            command,
            runner,
            requestTimer.signal,
          ));
        } catch (error) {
          if (requestTimer.signal?.aborted) throw requestTimer.error();
          throw error;
        }
        if (requestTimer.signal?.aborted) throw requestTimer.error();
        // Surface a failed or aborted run before draining the bridge: an MCP
        // handler that ignores cancellation would otherwise hold `idle()` open
        // past the configured deadline (which killed only the CLI process).
        if (failure) throw preferReportedFailure(failure, stdout, config.model);
        // The CLI can exit while a tool-call response is still in flight; wait for
        // the bridge's handlers to settle before snapshotting records (and before
        // the finally closes the server).
        await drainBridge(bridge, requestTimer.signal, requestTimer.error);
        const run = foldEvents(stdout);
        await recoverUsage(run, async () => {
          if (signal?.aborted) throw signal.reason;
          const timeoutMs = recoveryTimeout(deadline);
          return timeoutMs === undefined
            ? undefined
            : exportSession(run.id, executable, runner, signal, timeoutMs);
        });
        return toResponse(run, config.model, bridge?.records ?? []);
      } finally {
        await cleanupImages?.();
        await cleanupInstruction?.();
        await bridge?.close();
      }
    },

    async *generateStream(request, signal) {
      // The bridge's onCall fires from the HTTP handler concurrently with stdout
      // reads, so buffer its events and flush them into the generator's own yield
      // stream (tool_call before its tool_result, both before `done`).
      const pending: StreamEvent[] = [];
      const requestTimer = requestDeadline(signal);
      const bridge = await openBridge(request, requestTimer.signal, (record) => {
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
      let cleanupInstruction: (() => Promise<void>) | undefined;

      try {
        const staged = await stageImages(request, "opencode", "-f");
        cleanupImages = staged.cleanup;
        const instruction = request.system
          ? await withTempFile("system.md", request.system)
          : undefined;
        cleanupInstruction = instruction?.cleanup;
        const command = buildCommand(request, bridge, staged.imageArgs, instruction?.path);
        const run = newRun();
        let index = 0;
        const deadline = requestTimer.deadline;

        try {
          for await (const line of streamCli(
            "opencode",
            command,
            streamRunner,
            requestTimer.signal,
          )) {
            while (pending.length > 0) yield pending.shift() as StreamEvent;
            index += 1;
            if (line.trim() === "") continue;
            const event = parseJsonObject("opencode", `decode OpenCode CLI event ${index}`, line);
            const emitted = parseEvent(run, event);
            if (emitted !== undefined) yield emitted;
          }
        } catch (error) {
          if (requestTimer.signal?.aborted) throw requestTimer.error();
          throw error;
        }
        if (requestTimer.signal?.aborted) throw requestTimer.error();

        // The CLI can exit while a tool-call response is still in flight; wait for
        // the bridge's handlers to settle so their events are queued before the flush.
        await drainBridge(bridge, requestTimer.signal, requestTimer.error);
        while (pending.length > 0) yield pending.shift() as StreamEvent;
        finalizeStep(run);
        await recoverUsage(run, async () => {
          if (signal?.aborted) throw signal.reason;
          const timeoutMs = recoveryTimeout(deadline);
          return timeoutMs === undefined
            ? undefined
            : exportSessionStream(run.id, executable, streamRunner, signal, timeoutMs);
        });
        yield { type: "done", response: toResponse(run, config.model, bridge?.records ?? []) };
      } finally {
        await cleanupImages?.();
        await cleanupInstruction?.();
        await bridge?.close();
      }
    },
  };
}

async function drainBridge(
  bridge: McpBridge | undefined,
  signal: AbortSignal | undefined,
  abortError: () => unknown,
): Promise<void> {
  if (!bridge) return;
  if (!signal) return bridge.idle();
  if (signal.aborted) throw abortError();
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(abortError());
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([bridge.idle(), aborted]);
    if (signal.aborted) throw abortError();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Inline config carrying the loopback MCP bridge (when tools are present) and/or
 * the request's system instruction (`OPENCODE_CONFIG_CONTENT` overrides for the
 * run only; OAuth is off since the endpoint is loopback). `instructions` are
 * added to opencode's system prompt — a privileged channel — unlike prefixing
 * the text to the user transcript. The launcher layers `command.env` over
 * `process.env`, so an inherited inline config is merged rather than replaced —
 * the caller's provider settings, other MCP servers, and instructions survive.
 * Returns `undefined` when there is nothing to inject, leaving env untouched.
 */
function opencodeConfig(
  bridge: McpBridge | undefined,
  instructionPath: string | undefined,
): string | undefined {
  if (!bridge && !instructionPath) return undefined;
  const existing = parseEnvConfig(process.env.OPENCODE_CONFIG_CONTENT);
  const merged: Record<string, unknown> = { ...existing };
  if (bridge) {
    const existingMcp = asRecord(existing.mcp);
    merged.mcp = {
      ...existingMcp,
      [bridgeServerName(existingMcp)]: { type: "remote", url: bridge.url, oauth: false },
    };
  }
  if (instructionPath) {
    const existingInstructions = Array.isArray(existing.instructions)
      ? existing.instructions.filter((entry): entry is string => typeof entry === "string")
      : [];
    merged.instructions = [...existingInstructions, instructionPath];
  }
  return JSON.stringify(merged);
}

/**
 * A server name the caller's inherited `mcp` map does not already define, so
 * injecting the bridge can never overwrite a caller-configured server (it is
 * plain `llmdriver` unless that name is taken, then `llmdriver-2`, …).
 */
function bridgeServerName(mcp: Record<string, unknown>): string {
  let name = "llmdriver";
  for (let suffix = 2; name in mcp; suffix += 1) name = `llmdriver-${suffix}`;
  return name;
}

/** Parses an inherited `OPENCODE_CONFIG_CONTENT`; anything unusable is ignored. */
function parseEnvConfig(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Mutable state gathered from one run's JSON event stream. */
interface OpencodeRun {
  id: string;
  /** Text of the step in progress; reset at each `step_start`. */
  stepText: string;
  /** Text of the last completed (or, if the stream cut out early, open) step. */
  text: string;
  completionReason: CompletionReason;
  finished: boolean;
  /** True once any text or `step_finish` event is seen; guards empty output. */
  sawOutput: boolean;
  usage: Usage;
}

function newRun(): OpencodeRun {
  return {
    id: "",
    stepText: "",
    text: "",
    completionReason: "",
    finished: false,
    sawOutput: false,
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
      run.sawOutput = true;
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
      run.sawOutput = true;
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
  if (reason === "content-filter") return "refusal";
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
  const message =
    readString(error, "message").trim() || readString(asRecord(error.data), "message").trim();
  // opencode's transport errors carry a bare `_tag` (e.g. "BadRequest").
  const tag = readString(error, "_tag") || readString(error, "name");
  return cliError("opencode", "api_error", message || "OpenCode run failed", {
    providerCode: tag || "error",
  });
}

function parseOpencodeOutput(stdout: string, model: string, toolCalls: ToolCallRecord[]): Response {
  return toResponse(foldEvents(stdout), model, toolCalls);
}

function recoveryTimeout(deadline: number | undefined): number | undefined {
  if (deadline === undefined) return USAGE_RECOVERY_TIMEOUT_MS;
  const remaining = Math.floor(deadline - performance.now());
  return remaining > 0 ? Math.min(remaining, USAGE_RECOVERY_TIMEOUT_MS) : undefined;
}

/** Folds a whole stdout JSONL stream into one run, committing any open step. */
function foldEvents(stdout: string): OpencodeRun {
  const run = newRun();
  for (const [index, line] of stdout.split("\n").entries()) {
    if (line.trim() === "") continue;
    // parseEvent folds the event into `run`; its returned delta is stream-only.
    parseEvent(run, parseJsonObject("opencode", `decode OpenCode CLI event ${index + 1}`, line));
  }
  finalizeStep(run);
  return run;
}

/**
 * The upstream event-loop race can exit `opencode run --format json` after
 * streaming text but before the terminal `step_finish` — the only in-stream
 * source of token counts. Recover the completed session's terminal step from
 * `opencode export <id>` so a successful run is not reported with zeroed usage.
 * Best-effort: if the export or its parse fails, usage keeps the stream's value.
 */
async function recoverUsage(
  run: OpencodeRun,
  readExport: () => Promise<string | undefined>,
): Promise<void> {
  if (run.finished || run.id === "") return;
  const stdout = await readExport();
  if (stdout === undefined) return;
  const terminal = terminalUsage(stdout);
  if (terminal === undefined) return;
  run.usage.inputTokens += terminal.inputTokens;
  run.usage.outputTokens += terminal.outputTokens;
  run.usage.cachedInputTokens += terminal.cachedInputTokens;
  run.usage.cacheCreationInputTokens += terminal.cacheCreationInputTokens;
  run.usage.reasoningTokens += terminal.reasoningTokens;
}

/** Token counts of the last assistant message in an `opencode export` payload. */
function terminalUsage(stdout: string): Usage | undefined {
  let exported: Record<string, unknown>;
  try {
    exported = parseJsonObject("opencode", "decode OpenCode session export", stdout);
  } catch {
    return undefined;
  }
  const messages = Array.isArray(exported.messages) ? exported.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = asRecord(asRecord(messages[index]).info);
    if (readString(info, "role") !== "assistant") continue;
    const tokens = asRecord(info.tokens);
    if (Object.keys(tokens).length === 0) return undefined;
    const usage: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
    };
    addUsage(usage, tokens);
    return usage;
  }
  return undefined;
}

/** Reads a session's export JSON through the buffered runner; `undefined` on failure. */
async function exportSession(
  sessionId: string,
  executable: string,
  runner: CommandRunner,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<string | undefined> {
  const command: Command = { executable, args: ["export", sessionId], stdin: "" };
  const { stdout, failure } = await executeCli("opencode", command, runner, signal, timeoutMs);
  return failure ? undefined : stdout;
}

/** Streaming counterpart of {@link exportSession}. */
async function exportSessionStream(
  sessionId: string,
  executable: string,
  streamRunner: StreamingCommandRunner,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<string | undefined> {
  const command: Command = { executable, args: ["export", sessionId], stdin: "" };
  let stdout = "";
  try {
    for await (const line of streamCli("opencode", command, streamRunner, signal, timeoutMs)) {
      stdout += `${line}\n`;
    }
  } catch {
    // Export is best-effort — a broken export must not fail the run — but a
    // caller abort is not an export failure: rethrow it so the documented abort
    // contract holds and generateStream() cannot emit a successful `done`.
    if (signal?.aborted) throw signal.reason;
    return undefined;
  }
  return stdout;
}

/**
 * Commits a step the stream left open. `opencode run --format json` can exit 0
 * after streaming text but before the terminal `step_finish` (a known upstream
 * event-loop race), so the open step's text becomes the answer while its
 * completion reason stays unreported rather than failing the whole run.
 */
function finalizeStep(run: OpencodeRun): void {
  if (run.finished) return;
  run.text = run.stepText;
  run.completionReason = "";
}

function toResponse(run: OpencodeRun, model: string, toolCalls: ToolCallRecord[]): Response {
  // An exit-0 process that emitted neither text nor a completed step produced no
  // usable output: treat it as malformed rather than a successful empty answer.
  // The upstream race that drops only the terminal step_finish still saw text.
  if (!run.sawOutput) {
    throw cliError("opencode", "parse_failed", "OpenCode run produced no usable output", {
      providerCode: "missing_result",
    });
  }
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
