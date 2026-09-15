import { type Command, executeCli, spawnRunner } from "./backends/cli.js";
import { LLMDriverError } from "./errors.js";

/** `opencode models` runs a Bun process and may hit the network on a cold cache. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Options for {@link listOpencodeModels}; every field has a working default. */
export interface ListOpencodeModelsOptions {
  /** Overrides the default `opencode` executable. */
  cliPath?: string;
  /** Aborts the discovery process group. */
  signal?: AbortSignal;
  /** Discovery time budget in milliseconds; defaults to 10 s. */
  timeoutMs?: number;
}

/**
 * Enumerates every model the local opencode can actually use, by shelling out to
 * `opencode models`. opencode merges `auth.json` credentials, provider env vars,
 * and `opencode.json` config itself, so this is the only source that reflects
 * real provider availability. Each entry is a `provider/model` id accepted
 * verbatim by `Config.model`.
 *
 * Throws the normalized `LLMDriverError` (`executable_not_found`,
 * `process_failed`, ...) when opencode is missing or fails; unlike a UI, a
 * library caller decides how to degrade.
 */
export async function listOpencodeModels(
  options: ListOpencodeModelsOptions = {},
): Promise<string[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // This API bypasses `validateConfig`, so normalize the timeout here: a bad
  // value would otherwise reach `AbortSignal.timeout` as an immediate timeout or
  // a platform `RangeError` instead of a documented `LLMDriverError`.
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new LLMDriverError("invalid_config", "timeoutMs must be a positive number", {
      provider: "opencode",
      operation: "listOpencodeModels",
    });
  }
  const command: Command = {
    executable: options.cliPath ?? "opencode",
    args: ["models"],
    stdin: "",
  };
  const { stdout, failure } = await executeCli(
    "opencode",
    command,
    spawnRunner,
    options.signal,
    timeoutMs,
  );
  if (failure) throw failure;
  return parseOpencodeModels(stdout);
}

/**
 * Keeps the `provider/model` ids from `opencode models` stdout. Blank lines,
 * error text, and anything that isn't a launchable id are dropped; `#variant`
 * suffixes and nested `provider/a/b` ids are preserved verbatim (`--model` takes
 * the id as-is).
 */
export function parseOpencodeModels(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(isModelId);
}

/** Whether a line is one `provider/model` id safe to pass to `--model`. */
function isModelId(line: string): boolean {
  if (line === "" || line.startsWith("-") || /\s/.test(line)) return false;
  // Nested `provider/a/b` ids are valid, but every segment must be non-empty so
  // malformed output like `provider//model` never reaches `--model`.
  const segments = line.split("/");
  return segments.length >= 2 && segments.every((segment) => segment !== "");
}
