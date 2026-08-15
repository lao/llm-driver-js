import { createAnthropicApiBackend } from "./backends/anthropic-api.js";
import type { Backend } from "./backends/backend.js";
import { createClaudeCliBackend } from "./backends/claude-cli.js";
import { createCodexCliBackend } from "./backends/codex-cli.js";
import { createOpenAiApiBackend } from "./backends/openai-api.js";
import { assertSupported } from "./capabilities.js";
import { validateConfig } from "./config.js";
import { LLMDriverError } from "./errors.js";
import type { Client, Config, Message, ReasoningEffort, Request, Response } from "./types.js";

/** Neutral reasoning-effort levels; validated here, mapped per target in adapters. */
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high"];

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
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
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
  if (request.temperature !== undefined && !Number.isFinite(request.temperature)) {
    throw invalid(config, "temperature must be a finite number");
  }
  if (request.topP !== undefined && !Number.isFinite(request.topP)) {
    throw invalid(config, "topP must be a finite number");
  }
  if (request.topK !== undefined && !Number.isInteger(request.topK)) {
    throw invalid(config, "topK must be an integer");
  }
  if (request.stopSequences !== undefined) {
    if (
      !Array.isArray(request.stopSequences) ||
      request.stopSequences.some((s) => typeof s !== "string")
    ) {
      throw invalid(config, "stopSequences must be an array of strings");
    }
  }
  if (request.metadata?.userId !== undefined && typeof request.metadata.userId !== "string") {
    throw invalid(config, "metadata.userId must be a string");
  }
  if (
    request.reasoning !== undefined &&
    !REASONING_EFFORTS.includes(request.reasoning?.effort as ReasoningEffort)
  ) {
    throw invalid(config, `reasoning.effort must be one of ${REASONING_EFFORTS.join(", ")}`);
  }
  validateTools(request, config);
  if (!Array.isArray(messages) || messages.length === 0) {
    throw invalid(config, "at least one message is required");
  }
  for (const [index, message] of messages.entries()) {
    if (message?.role !== "user" && message?.role !== "assistant") {
      throw invalid(config, `message ${index} has invalid role "${message?.role}"`);
    }
    validateContent(message, index, config);
  }
  // Strict portability gate: reject any feature this target cannot honor.
  assertSupported(request, config);
}

const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Enforces the `text` XOR `content` invariant and every block's well-formedness. */
function validateContent(message: Message, index: number, config: Config): void {
  const hasText = message.text !== undefined;
  const hasContent = message.content !== undefined;
  if (hasText === hasContent) {
    throw invalid(config, `message ${index} must have exactly one of text or content`);
  }
  if (hasText) {
    if (typeof message.text !== "string" || message.text.trim() === "") {
      throw invalid(config, `message ${index} text is required`);
    }
    return;
  }
  if (!Array.isArray(message.content) || message.content.length === 0) {
    throw invalid(config, `message ${index} content must be a non-empty array`);
  }
  for (const [blockIndex, block] of message.content.entries()) {
    validateBlock(block, index, blockIndex, config);
  }
}

/** Rejects a malformed content block, naming the message and block index. */
function validateBlock(block: unknown, index: number, blockIndex: number, config: Config): void {
  const bad = (why: string): never => {
    throw invalid(config, `message ${index} content block ${blockIndex} ${why}`);
  };
  if (typeof block !== "object" || block === null) bad("must be an object");
  const { type, text, source } = block as {
    type?: unknown;
    text?: unknown;
    source?: Record<string, unknown>;
  };
  if (type === "text") {
    if (typeof text !== "string" || text === "") bad("text must be a non-empty string");
    return;
  }
  if (type === "image") {
    if (typeof source !== "object" || source === null) bad("image source must be an object");
    const s = source as Record<string, unknown>;
    if (typeof s.url === "string") return;
    if (typeof s.base64 !== "string" || s.base64 === "") bad("image source needs base64 or url");
    if (!IMAGE_MEDIA_TYPES.includes(s.mediaType as string)) bad("image mediaType is invalid");
    return;
  }
  if (type === "document") {
    if (typeof source !== "object" || source === null) bad("document source must be an object");
    const s = source as Record<string, unknown>;
    if (typeof s.base64 !== "string" || s.base64 === "") bad("document source needs base64");
    if (s.mediaType !== "application/pdf") bad("document mediaType must be application/pdf");
    return;
  }
  bad(`has unknown type "${String(type)}"`);
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Validates `tools`/`toolChoice` shape; the target gate runs separately. */
function validateTools(request: Request, config: Config): void {
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools)) {
      throw invalid(config, "tools must be an array");
    }
    for (const [index, tool] of request.tools.entries()) {
      if (typeof tool?.name !== "string" || !TOOL_NAME.test(tool.name)) {
        throw invalid(config, `tool ${index} name must match ${TOOL_NAME.source}`);
      }
      if (typeof tool.description !== "string") {
        throw invalid(config, `tool ${index} description must be a string`);
      }
      if (typeof tool.inputSchema !== "object" || tool.inputSchema === null) {
        throw invalid(config, `tool ${index} inputSchema must be an object`);
      }
      if (typeof tool.execute !== "function") {
        throw invalid(config, `tool ${index} execute must be a function`);
      }
    }
  }
  if (request.toolChoice !== undefined) {
    if (!isValidToolChoice(request.toolChoice)) {
      throw invalid(config, 'toolChoice must be "auto", "none", "required", or { name }');
    }
    if (!request.tools || request.tools.length === 0) {
      throw invalid(config, "toolChoice requires tools");
    }
  }
}

function isValidToolChoice(choice: unknown): boolean {
  if (choice === "auto" || choice === "none" || choice === "required") {
    return true;
  }
  return (
    typeof choice === "object" &&
    choice !== null &&
    typeof (choice as { name?: unknown }).name === "string"
  );
}

function invalid(config: Config, message: string): LLMDriverError {
  return new LLMDriverError("invalid_request", message, {
    provider: config.provider,
    flavor: config.flavor,
    operation: "generate",
  });
}
