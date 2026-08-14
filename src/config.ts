import { LLMDriverError } from "./errors.js";
import type { Config, Flavor, Provider } from "./types.js";

const PROVIDERS: Provider[] = ["claude", "openai"];
const FLAVORS: Flavor[] = ["api", "cli"];

/** Options that only make sense for one flavor, rejected for the other. */
const API_ONLY = ["apiKey", "baseUrl", "fetch", "maxRetries"] as const;
const CLI_ONLY = ["cliPath", "cliArgs"] as const;

/**
 * Validates a public config, throwing `invalid_config` on any violation.
 * The model is never defaulted and flavor-inappropriate options are rejected
 * rather than silently ignored.
 */
export function validateConfig(config: Config): void {
  if (typeof config !== "object" || config === null) {
    throw new LLMDriverError("invalid_config", "config is required", {
      operation: "createClient",
    });
  }
  if (!PROVIDERS.includes(config.provider)) {
    throw invalid(config, `provider must be one of ${quoted(PROVIDERS)}`);
  }
  if (!FLAVORS.includes(config.flavor)) {
    throw invalid(config, `flavor must be one of ${quoted(FLAVORS)}`);
  }
  if (typeof config.model !== "string" || config.model.trim() === "") {
    throw invalid(config, "model is required");
  }

  const forbidden = config.flavor === "api" ? CLI_ONLY : API_ONLY;
  for (const key of forbidden) {
    if (config[key] !== undefined) {
      throw invalid(config, `${key} is not supported for the ${config.flavor} flavor`);
    }
  }

  if (config.baseUrl !== undefined && !isHttpUrl(config.baseUrl)) {
    throw invalid(config, "baseUrl must be an absolute HTTP(S) URL");
  }
  if (
    config.cliPath !== undefined &&
    (typeof config.cliPath !== "string" || !config.cliPath.trim())
  ) {
    throw invalid(config, "cliPath must be a non-blank string");
  }
  // A JS caller passing a bare string would otherwise be spread into argv one
  // character at a time, and a non-string element would crash spawn().
  if (
    config.cliArgs !== undefined &&
    (!Array.isArray(config.cliArgs) || config.cliArgs.some((arg) => typeof arg !== "string"))
  ) {
    throw invalid(config, "cliArgs must be an array of strings");
  }
  if (
    config.timeoutMs !== undefined &&
    (typeof config.timeoutMs !== "number" ||
      !Number.isFinite(config.timeoutMs) ||
      config.timeoutMs <= 0)
  ) {
    throw invalid(config, "timeoutMs must be a positive number");
  }
  // maxRetries on a cli flavor already failed the API_ONLY check above.
  if (
    config.maxRetries !== undefined &&
    (!Number.isInteger(config.maxRetries) || config.maxRetries < 0)
  ) {
    throw invalid(config, "maxRetries must be a non-negative integer");
  }
}

function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.host !== "";
}

function quoted(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(" or ");
}

function invalid(config: Config, message: string): LLMDriverError {
  return new LLMDriverError("invalid_config", message, {
    provider: config.provider,
    flavor: config.flavor,
    operation: "createClient",
  });
}
