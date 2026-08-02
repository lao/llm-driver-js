import { LLMWrapperError } from "./errors.js";
import type { Config, Flavor, Provider } from "./types.js";

const PROVIDERS: Provider[] = ["claude", "openai"];
const FLAVORS: Flavor[] = ["api", "cli"];

/** Options that only make sense for one flavor, rejected for the other. */
const API_ONLY = ["apiKey", "baseUrl", "fetch"] as const;
const CLI_ONLY = ["cliPath", "cliArgs"] as const;

/**
 * Validates a public config, throwing `invalid_config` on any violation.
 * The model is never defaulted and flavor-inappropriate options are rejected
 * rather than silently ignored.
 */
export function validateConfig(config: Config): void {
  if (!PROVIDERS.includes(config?.provider)) {
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

  if (config.flavor === "api" && config.baseUrl !== undefined && !isHttpUrl(config.baseUrl)) {
    throw invalid(config, "baseUrl must be an absolute HTTP(S) URL");
  }
  if (config.flavor === "cli" && config.cliPath !== undefined && config.cliPath.trim() === "") {
    throw invalid(config, "cliPath cannot be blank");
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

function invalid(config: Config, message: string): LLMWrapperError {
  return new LLMWrapperError("invalid_config", message, {
    provider: config?.provider,
    flavor: config?.flavor,
    operation: "createClient",
  });
}
