import { createAnthropicApiBackend } from "./backends/anthropic-api.js";
import type { Backend } from "./backends/backend.js";
import { createClaudeCliBackend } from "./backends/claude-cli.js";
import { createCodexCliBackend } from "./backends/codex-cli.js";
import { createOpenAiApiBackend } from "./backends/openai-api.js";
import { validateConfig } from "./config.js";
import { LLMWrapperError } from "./errors.js";
import type { Client, Config, Request, Response } from "./types.js";

/** Constructs a client for one provider, flavor, and model. */
export function createClient(config: Config): Client {
  validateConfig(config);
  // The caller's object is snapshotted, so mutating it later cannot change how
  // an already-built client behaves.
  const snapshot: Config = Object.freeze({
    provider: config.provider,
    flavor: config.flavor,
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    fetch: config.fetch,
    cliPath: config.cliPath,
    cliArgs: config.cliArgs?.slice(),
  });
  return createClientWithBackend(snapshot, selectBackend(snapshot));
}

/**
 * Internal seam: wraps an already-selected backend. Tests inject fakes through
 * it; it is never re-exported from the package barrel.
 */
export function createClientWithBackend(config: Config, backend: Backend): Client {
  return {
    async generate(request, options) {
      validateRequest(request, config);
      return stamp(await backend.generate(request, options?.signal), config);
    },

    async *generateStream(request, options) {
      // Async-generator semantics: this throws from the first next(), not here.
      validateRequest(request, config);
      for await (const event of backend.generateStream(request, options?.signal)) {
        yield event.type === "done"
          ? { type: "done", response: stamp(event.response, config) }
          : event;
      }
    },
  };
}

/** Applies the target's identity, keeping any model the backend reported. */
function stamp(response: Response, config: Config): Response {
  return {
    ...response,
    model: response.model || config.model,
    provider: config.provider,
    flavor: config.flavor,
  };
}

function selectBackend(config: Config): Backend {
  switch (`${config.provider}/${config.flavor}` as const) {
    case "claude/api":
      return createAnthropicApiBackend(config);
    case "claude/cli":
      return createClaudeCliBackend(config);
    case "openai/api":
      return createOpenAiApiBackend(config);
    case "openai/cli":
      return createCodexCliBackend(config);
  }
}

/** Validates a request, throwing `invalid_request` on any violation. */
export function validateRequest(request: Request, config: Config): void {
  if (typeof request !== "object" || request === null) {
    throw invalid(config, "request is required");
  }
  const { maxTokens, messages, system } = request;
  if (system !== undefined && typeof system !== "string") {
    throw invalid(config, "system must be a string");
  }
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw invalid(config, "maxTokens must be a positive integer");
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw invalid(config, "at least one message is required");
  }
  for (const [index, message] of messages.entries()) {
    if (message?.role !== "user" && message?.role !== "assistant") {
      throw invalid(config, `message ${index} has invalid role "${message?.role}"`);
    }
    if (typeof message.text !== "string" || message.text.trim() === "") {
      throw invalid(config, `message ${index} text is required`);
    }
  }
}

function invalid(config: Config, message: string): LLMWrapperError {
  return new LLMWrapperError("invalid_request", message, {
    provider: config.provider,
    flavor: config.flavor,
    operation: "generate",
  });
}
