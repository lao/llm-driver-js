import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { type ErrorCode, LLMWrapperError } from "../errors.js";
import type { Message, Provider } from "../types.js";

/** Hard cap on captured stdout and stderr, matching the Go reference. */
const MAX_OUTPUT_BYTES = 16 << 20;
/** Grace period between SIGTERM and SIGKILL once a run is aborted. */
const KILL_GRACE_MS = 250;
/** Cap on the stderr excerpt quoted in a `process_failed` message. */
const MAX_STDERR_MESSAGE_CHARS = 4 << 10;

/** One CLI invocation: argv is built directly and the prompt goes on stdin. */
export interface Command {
  executable: string;
  args: string[];
  stdin: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Internal seam that lets tests drive the CLI backends without a real process.
 * Rejects on launch failures (`ENOENT` and friends) and on abort; a non-zero
 * exit is a normal result.
 */
export type CommandRunner = (command: Command, signal?: AbortSignal) => Promise<CommandResult>;

/** One piece of a streaming run: a stdout line, then a single terminal exit. */
export type CommandChunk =
  | { type: "line"; line: string }
  | { type: "exit"; exitCode: number; stderr: string };

/**
 * Streaming counterpart of {@link CommandRunner}, and the seam CLI streaming
 * tests drive. Throws on launch failures and on abort; a non-zero exit arrives
 * as the terminal chunk. Abandoning the iterator kills the process group.
 */
export type StreamingCommandRunner = (
  command: Command,
  signal?: AbortSignal,
) => AsyncIterable<CommandChunk>;

/** Outcome of a run; stdout stays readable when the process failed. */
export interface CliOutcome {
  stdout: string;
  failure?: LLMWrapperError;
}

/**
 * Renders the transcript written to a CLI's stdin. A lone user message is sent
 * verbatim; anything else becomes labelled blocks separated by a blank line.
 */
export function renderTranscript(messages: Message[]): string {
  const [first] = messages;
  if (messages.length === 1 && first?.role === "user") {
    return first.text;
  }
  return messages
    .map((message) => `${message.role === "assistant" ? "Assistant: " : "User: "}${message.text}`)
    .join("\n\n");
}

/**
 * Runs a CLI command and normalizes process-level failures. Rejects only when
 * the caller aborts — every other failure is returned as {@link CliOutcome}
 * `failure` so a backend can still mine stdout for a provider diagnostic.
 */
export async function executeCli(
  provider: Provider,
  command: Command,
  runner: CommandRunner,
  signal?: AbortSignal,
): Promise<CliOutcome> {
  let result: CommandResult;
  try {
    result = await runner(command, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return { stdout: "", failure: launchFailure(provider, command, error) };
  }

  if (result.exitCode !== 0) {
    return { stdout: result.stdout, failure: exitFailure(provider, result) };
  }
  return { stdout: result.stdout };
}

/**
 * Streaming counterpart of {@link executeCli}: yields stdout lines as they
 * arrive and throws the same normalized failures — except an abort, which is
 * rethrown untouched. A consumer that stops iterating tears the process down.
 */
export async function* streamCli(
  provider: Provider,
  command: Command,
  runner: StreamingCommandRunner,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  let exit: { exitCode: number; stderr: string } | undefined;
  try {
    for await (const chunk of runner(command, signal)) {
      if (chunk.type === "line") yield chunk.line;
      else exit = chunk;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    throw launchFailure(provider, command, error);
  }
  if (exit !== undefined && exit.exitCode !== 0) throw exitFailure(provider, exit);
}

function exitFailure(
  provider: Provider,
  result: { exitCode: number; stderr: string },
): LLMWrapperError {
  return cliError(
    provider,
    "process_failed",
    truncate(result.stderr.trim()) || "CLI command failed",
    {
      status: result.exitCode,
    },
  );
}

/** Builds an error already stamped with the CLI target and operation. */
export function cliError(
  provider: Provider,
  code: ErrorCode,
  message: string,
  options: { status?: number; providerCode?: string; cause?: unknown } = {},
): LLMWrapperError {
  return new LLMWrapperError(code, message, {
    ...options,
    provider,
    flavor: "cli",
    operation: "generate",
  });
}

/** Parses one JSON object from CLI output, normalizing every failure mode. */
export function parseJsonObject(
  provider: Provider,
  description: string,
  source: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw cliError(provider, "parse_failed", `${description}: ${describe(cause)}`, { cause });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw cliError(provider, "parse_failed", `${description}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Reads a nested object, treating anything else as absent. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Reads a string field, defaulting to `""`. */
export function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

/** Reads a token count field; anything but a non-negative integer counts as `0`. */
export function readCount(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Collects output up to `limit` bytes, then flags the overflow. */
export function createBoundedCapture(limit = MAX_OUTPUT_BYTES) {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;

  return {
    /** Appends a chunk, returning `false` once the limit is exceeded. */
    push(chunk: Buffer): boolean {
      const remaining = limit - size;
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        size += chunk.length;
        return true;
      }
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
        size += remaining;
      }
      overflow = true;
      return false;
    },
    overflowed: (): boolean => overflow,
    text: (): string => Buffer.concat(chunks).toString("utf8"),
  };
}

const POSIX = process.platform !== "win32";

/** Detached children still running, so host exit does not orphan them. */
const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

/**
 * Registers a child for cleanup if the host process exits mid-run. The handler
 * is installed on first spawn and only does synchronous work, which is all an
 * `exit` listener can do — `process.kill` qualifies.
 */
function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const live of liveChildren) killGroup(live, "SIGKILL");
  });
}

/**
 * Spawns the executable directly — never a shell — inheriting cwd and env so the
 * CLI's own login is used, and leading its own process group on POSIX. The child
 * may exit before reading the prompt, so a broken stdin pipe is not fatal.
 */
function launchChild(command: Command): ChildProcessWithoutNullStreams {
  const child = spawn(command.executable, command.args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: POSIX,
  });
  trackChild(child);
  child.stdin.on("error", () => {});
  child.stdin.end(command.stdin);
  return child;
}

/**
 * Signals the child's whole process group, so the helper processes `claude` and
 * `codex` spawn die with it. Falls back to the direct child when the group is
 * already gone (`ESRCH`) or on Windows, which has no process groups.
 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  // Once the child is reaped its pid can be recycled, and `-pid` would then
  // signal an unrelated group; only the direct-child kill stays safe.
  const alive = child.exitCode === null && child.signalCode === null;
  if (POSIX && alive && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group already reaped, or we lost the right to signal it.
    }
  }
  child.kill(signal);
}

/**
 * Ends a run: SIGTERM to the group, escalating to SIGKILL after a short grace
 * period. The escalation is unref'd, so it never keeps the host process alive.
 */
function terminateGroup(child: ChildProcess): NodeJS.Timeout {
  killGroup(child, "SIGTERM");
  return setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS).unref();
}

/** Default runner: buffers the whole run, aborting via {@link terminateGroup}. */
export const spawnRunner: CommandRunner = (command, signal) =>
  new Promise<CommandResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const child = launchChild(command);
    const stdout = createBoundedCapture();
    const stderr = createBoundedCapture();
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const onAbort = () => {
      killTimer = terminateGroup(child);
    };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      liveChildren.delete(child);
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(killTimer);
      finish();
    };
    const finishRun = (code: number | null) =>
      settle(() => {
        if (signal?.aborted) {
          reject(signal.reason);
        } else if (stdout.overflowed() || stderr.overflowed()) {
          reject(new Error(`CLI output exceeds ${MAX_OUTPUT_BYTES} bytes`));
        } else {
          resolve({ stdout: stdout.text(), stderr: stderr.text(), exitCode: code ?? -1 });
        }
      });

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (!stdout.push(chunk)) killGroup(child, "SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!stderr.push(chunk)) killGroup(child, "SIGKILL");
    });
    child.on("error", (error) => settle(() => reject(error)));
    // A stdio stream can error independently of the process (e.g. EIO after a
    // kill); without a listener that event crashes the host.
    child.stdout.on("error", (error) => settle(() => reject(error)));
    child.stderr.on("error", (error) => settle(() => reject(error)));
    child.on("close", finishRun);
    // A grandchild that escaped the process group can hold the stdout pipe open
    // forever, so an aborted run settles on the child's own exit instead.
    child.on("exit", (code) => {
      if (signal?.aborted) finishRun(code);
    });
  });

/**
 * Streaming default runner: same spawn, group-kill, and bounded-capture rules as
 * {@link spawnRunner}, but stdout is split into lines and handed over as it
 * arrives while stderr stays buffered for the `process_failed` message. Aborting
 * — or simply abandoning the iterator — terminates the whole process group.
 */
export const spawnStreamRunner: StreamingCommandRunner = async function* (command, signal) {
  if (signal?.aborted) throw signal.reason;

  const child = launchChild(command);
  const decoder = new StringDecoder("utf8");
  const stderr = createBoundedCapture();
  const lines: string[] = [];
  let cursor = 0;
  let partial = "";
  // Retained stdout, not throughput: a line handed to the consumer is subtracted
  // again, so a long agentic run is bounded by its backlog rather than its total.
  let stdoutBytes = 0;
  let failure: unknown;
  let exitCode: number | undefined;
  let wake: (() => void) | undefined;

  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const terminate = () => {
    if (child.exitCode === null && child.signalCode === null) terminateGroup(child);
  };
  const overflow = () => {
    failure ??= new Error(`CLI output exceeds ${MAX_OUTPUT_BYTES} bytes`);
    killGroup(child, "SIGKILL");
    notify();
  };
  const onAbort = () => {
    failure ??= signal?.reason;
    terminate();
    notify();
  };

  signal?.addEventListener("abort", onAbort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_OUTPUT_BYTES) return overflow();
    const parts = (partial + decoder.write(chunk)).split("\n");
    partial = parts.pop() ?? "";
    // Not `push(...parts)`: spreading a newline-dense chunk blows the arg limit.
    for (const part of parts) lines.push(part);
    notify();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (!stderr.push(chunk)) overflow();
  });
  child.on("error", (error) => {
    failure ??= error;
    notify();
  });
  // A stdio stream can error independently of the process (e.g. EIO after the
  // overflow SIGKILL); route it into the normal failure path instead of letting
  // an unhandled stream error crash the host.
  const onStreamError = (error: Error) => {
    failure ??= error;
    notify();
  };
  child.stdout.on("error", onStreamError);
  child.stderr.on("error", onStreamError);
  // No `exit` companion listener here, unlike the buffered runner: an abort sets
  // `failure` and wakes the loop itself, so a grandchild holding stdout open can
  // never stall it.
  child.on("close", (code) => {
    // Only now is the child confirmed dead: deleting it any earlier would let a
    // host exit during the SIGTERM→SIGKILL grace period orphan the group.
    liveChildren.delete(child);
    exitCode ??= code ?? -1;
    notify();
  });

  try {
    for (;;) {
      // An abort or a launch error wins over any output already buffered.
      if (failure !== undefined) throw failure;
      if (cursor < lines.length) {
        const line = lines[cursor++] as string;
        // Byte-exact for ASCII, an under-count for multi-byte text — which only
        // makes the bound stricter, never looser.
        stdoutBytes -= line.length + 1;
        yield { type: "line", line };
        continue;
      }
      // Drained: reclaim the consumed prefix instead of growing the array forever.
      lines.length = 0;
      cursor = 0;
      if (exitCode !== undefined) break;
      // Nothing buffered and nothing terminal: park until a listener wakes us.
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    // A last line without a trailing newline is still a line.
    if (partial !== "") yield { type: "line", line: partial };
    yield { type: "exit", exitCode: exitCode ?? -1, stderr: stderr.text() };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // Covers an abandoned iterator as well as an abort: no orphaned group.
    terminate();
  }
};

function launchFailure(provider: Provider, command: Command, error: unknown): LLMWrapperError {
  if (isErrno(error, "ENOENT")) {
    return cliError(
      provider,
      "executable_not_found",
      `executable not found: ${command.executable}`,
      {
        cause: error,
      },
    );
  }
  return cliError(provider, "process_failed", describe(error), { cause: error });
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code
  );
}

/** Keeps a runaway CLI's stderr from becoming an unbounded error message. */
function truncate(text: string): string {
  return text.length <= MAX_STDERR_MESSAGE_CHARS
    ? text
    : `${text.slice(0, MAX_STDERR_MESSAGE_CHARS)}… (truncated)`;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "CLI command failed";
}
