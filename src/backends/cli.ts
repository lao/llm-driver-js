import { type ChildProcess, spawn } from "node:child_process";
import { type ErrorCode, LLMWrapperError } from "../errors.js";
import type { Message, Provider } from "../types.js";

/** Hard cap on captured stdout and stderr, matching the Go reference. */
const MAX_OUTPUT_BYTES = 16 << 20;
/** Grace period between SIGTERM and SIGKILL once a run is aborted. */
const KILL_GRACE_MS = 250;

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
    return {
      stdout: result.stdout,
      failure: cliError(provider, "process_failed", result.stderr.trim() || "CLI command failed", {
        status: result.exitCode,
      }),
    };
  }
  return { stdout: result.stdout };
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

/**
 * Signals the child's whole process group, so the helper processes `claude` and
 * `codex` spawn die with it. Falls back to the direct child when the group is
 * already gone (`ESRCH`) or on Windows, which has no process groups.
 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (POSIX && child.pid !== undefined) {
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
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(killTimer);
      finish();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (!stdout.push(chunk)) killGroup(child, "SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!stderr.push(chunk)) killGroup(child, "SIGKILL");
    });
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code) =>
      settle(() => {
        if (signal?.aborted) {
          reject(signal.reason);
        } else if (stdout.overflowed() || stderr.overflowed()) {
          reject(new Error(`CLI output exceeds ${MAX_OUTPUT_BYTES} bytes`));
        } else {
          resolve({ stdout: stdout.text(), stderr: stderr.text(), exitCode: code ?? -1 });
        }
      }),
    );
    // The child may exit before reading the prompt; a broken pipe is not fatal.
    child.stdin.on("error", () => {});
    child.stdin.end(command.stdin);
  });

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

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "CLI command failed";
}
