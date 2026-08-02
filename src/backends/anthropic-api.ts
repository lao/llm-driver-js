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
  // The SDK raises unresolvable credentials as a plain Error while building the
  // request, so the class alone cannot tell a config problem from a transport
  // one. Reaching the transport even once proves the credentials resolved.
  let reachedTransport = false;
  const fetchImpl: typeof fetch = (input, init) => {
    reachedTransport = true;
    return (config.fetch ?? globalThis.fetch)(input, init);
  };

  return {
    async generate(request, signal) {
      try {
        client ??= new Anthropic({
          apiKey: config.apiKey,
          baseURL: config.baseUrl,
          fetch: fetchImpl,
          maxRetries: 0, // retries are out of scope: one request per generate()
        });
        return toResponse(
          await client.messages.create(toParams(config.model, request), { signal }),
        );
      } catch (error) {
        // An abort surfaces the signal's own reason, like the CLI flavors —
        // never the SDK's APIUserAbortError stand-in.
        if (signal?.aborted) throw signal.reason;
        throw normalizeError(error, reachedTransport);
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

function normalizeError(error: unknown, reachedTransport: boolean): LLMWrapperError {
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
  const message = error instanceof Error ? error.message : String(error);
  // An SDK error, or anything raised before a request ever left the process, is
  // a setup problem — unresolvable credentials above all — not a transport one.
  if (error instanceof AnthropicError || !reachedTransport) {
    return new LLMWrapperError("invalid_config", message, options);
  }
  return new LLMWrapperError("transport_failed", message, options);
}

/** Anthropic reports the human-readable message inside `error.error.message`. */
function apiErrorMessage(error: APIError): string {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  return typeof message === "string" && message !== "" ? message : error.message;
}
