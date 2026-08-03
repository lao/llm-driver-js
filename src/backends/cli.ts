import { type ChildProcess, spawn } from "node:child_process";
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
 * Default runner: spawns the executable directly — never through a shell — and
 * inherits cwd and env so the CLI's own login is used. The child leads its own
 * process group; an abort sends SIGTERM to the group and escalates to SIGKILL
 * after a short grace period.
 */
export const spawnRunner: CommandRunner = (command, signal) =>
  new Promise<CommandResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const child = spawn(command.executable, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: POSIX,
    });
    trackChild(child);
    const stdout = createBoundedCapture();
    const stderr = createBoundedCapture();
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const onAbort = () => {
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
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
    child.on("close", finishRun);
    // A grandchild that escaped the process group can hold the stdout pipe open
    // forever, so an aborted run settles on the child's own exit instead.
    child.on("exit", (code) => {
      if (signal?.aborted) finishRun(code);
    });
    // The child may exit before reading the prompt; a broken pipe is not fatal.
    child.stdin.on("error", () => {});
    child.stdin.end(command.stdin);
  });

/**
 * Streaming default runner: same spawn, group-kill, and bounded-capture rules as
 * {@link spawnRunner}, but stdout is split into lines and handed over as it
 * arrives while stderr stays buffered for the `process_failed` message. Aborting
 * — or simply abandoning the iterator — terminates the whole process group.
 */
export const spawnStreamRunner: StreamingCommandRunner = async function* (command, signal) {
  if (signal?.aborted) throw signal.reason;

  const child = spawn(command.executable, command.args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: POSIX,
  });
  trackChild(child);

  const decoder = new StringDecoder("utf8");
  const stderr = createBoundedCapture();
  const lines: string[] = [];
  let partial = "";
  let stdoutBytes = 0;
  let failure: unknown;
  let exitCode: number | undefined;
  let wake: (() => void) | undefined;

  const notify = () => {
    wake?.();
    wake = undefined;
  };
  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    killGroup(child, "SIGTERM");
    // Unref'd, so a pending escalation never keeps the host process alive.
    setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS).unref();
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
    lines.push(...parts);
    notify();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (!stderr.push(chunk)) overflow();
  });
  child.on("error", (error) => {
    failure ??= error;
    notify();
  });
  child.on("close", (code) => {
    exitCode ??= code ?? -1;
    notify();
  });
  // The child may exit before reading the prompt; a broken pipe is not fatal.
  child.stdin.on("error", () => {});
  child.stdin.end(command.stdin);

  try {
    for (;;) {
      // An abort or a launch error wins over any output already buffered.
      if (failure !== undefined) throw failure;
      const line = lines.shift();
      if (line !== undefined) {
        yield { type: "line", line };
        continue;
      }
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
    liveChildren.delete(child);
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
