import Anthropic, { AnthropicError, APIError } from "@anthropic-ai/sdk";
import { LLMWrapperError } from "../errors.js";
import type { CompletionReason, Config, Request, Response } from "../types.js";
import type { Backend } from "./backend.js";

const CONTEXT = { provider: "claude", flavor: "api", operation: "generate" } as const;

/** Anthropic Messages API backend (`claude`/`api`). */
export function createAnthropicApiBackend(config: Config): Backend {
  // Built on first use so credential resolution fails from generate() rather
  // than from createClient().
  let client: Anthropic | undefined;

  return {
    async generate(request, signal) {
      try {
        client ??= new Anthropic({
          apiKey: config.apiKey,
          baseURL: config.baseUrl,
          fetch: config.fetch,
          maxRetries: 0, // retries are out of scope: one request per generate()
        });
        return toResponse(
          await client.messages.create(toParams(config.model, request), { signal }),
        );
      } catch (error) {
        throw normalizeError(error);
      }
    },
  };
}

function toParams(model: string, request: Request): Anthropic.MessageCreateParamsNonStreaming {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: request.maxTokens,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: [{ type: "text", text: message.text }],
    })),
  };
  if (request.system) {
    params.system = [{ type: "text", text: request.system }];
  }
  return params;
}

function toResponse(message: Anthropic.Message): Response {
  if (!Array.isArray(message?.content)) {
    throw new LLMWrapperError(
      "parse_failed",
      "Anthropic response contained no content blocks",
      CONTEXT,
    );
  }
  const usage = message.usage;
  return {
    id: message.id ?? "",
    model: message.model ?? "",
    text: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
    completionReason: toCompletionReason(message.stop_reason),
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
      reasoningTokens: 0,
    },
    provider: "claude",
    flavor: "api",
  };
}

function toCompletionReason(reason: Anthropic.StopReason | null): CompletionReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "";
  }
}

function normalizeError(error: unknown): LLMWrapperError {
  if (error instanceof LLMWrapperError) {
    return error;
  }
  const options = { ...CONTEXT, cause: error };
  if (error instanceof APIError) {
    if (typeof error.status !== "number") {
      return new LLMWrapperError("transport_failed", error.message, options);
    }
    return new LLMWrapperError("api_error", apiErrorMessage(error), {
      ...options,
      status: error.status,
      providerCode: error.type ?? undefined,
    });
  }
  if (error instanceof AnthropicError) {
    return new LLMWrapperError("invalid_config", error.message, options);
  }
  return new LLMWrapperError(
    "transport_failed",
    error instanceof Error ? error.message : String(error),
    options,
  );
}

/** Anthropic reports the human-readable message inside `error.error.message`. */
function apiErrorMessage(error: APIError): string {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  return typeof message === "string" && message !== "" ? message : error.message;
}
