import Anthropic, { AnthropicError, APIConnectionError, APIError } from "@anthropic-ai/sdk";
import { LLMDriverError } from "../errors.js";
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
  const ensureClient = (): Anthropic =>
    (client ??= new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      fetch: fetchImpl,
      // Default 0 keeps v1's one-request-per-generate() behavior; a caller opts in.
      maxRetries: config.maxRetries ?? 0,
      timeout: config.timeoutMs, // undefined leaves the SDK default in place
    }));

  return {
    async generate(request, signal) {
      try {
        return toResponse(
          await ensureClient().messages.create(toParams(config.model, request), { signal }),
        );
      } catch (error) {
        // An abort surfaces the signal's own reason, like the CLI flavors —
        // never the SDK's APIUserAbortError stand-in.
        if (signal?.aborted) throw signal.reason;
        throw normalizeError(error, reachedTransport);
      }
    },

    async *generateStream(request, signal) {
      // Aborted in the generator's cleanup so an early consumer break tears the
      // HTTP stream down instead of leaking it.
      const controller = new AbortController();
      try {
        const stream = await ensureClient().messages.create(
          { ...toParams(config.model, request), stream: true },
          { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal },
        );

        let message: Anthropic.Message | undefined;
        let text = "";
        for await (const event of stream) {
          if (event.type === "message_start") {
            message = event.message;
          } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            text += event.delta.text;
            yield { type: "text", text: event.delta.text };
          } else if (event.type === "message_delta" && message) {
            // Rebuilt rather than mutated: the SDK's own event object is not ours.
            message = {
              ...message,
              stop_reason: event.delta.stop_reason,
              usage: mergeUsage(message.usage, event.usage),
            };
          }
        }

        // The SDK ends the iteration silently on abort, so the check has to be
        // here rather than only in the catch.
        if (signal?.aborted) throw signal.reason;
        if (!message) {
          throw new LLMDriverError(
            "parse_failed",
            "Anthropic stream ended without a message",
            CONTEXT,
          );
        }
        yield {
          type: "done",
          response: toResponse({ ...message, content: [{ type: "text", text, citations: null }] }),
        };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw normalizeError(error, reachedTransport);
      } finally {
        controller.abort();
      }
    },
  };
}

/** message_delta reports cumulative counters, but only the ones it knows. */
function mergeUsage(usage: Anthropic.Usage, delta: Anthropic.MessageDeltaUsage): Anthropic.Usage {
  return {
    ...usage,
    input_tokens: delta.input_tokens ?? usage.input_tokens,
    output_tokens: delta.output_tokens,
    cache_read_input_tokens: delta.cache_read_input_tokens ?? usage.cache_read_input_tokens,
    cache_creation_input_tokens:
      delta.cache_creation_input_tokens ?? usage.cache_creation_input_tokens,
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
  if (request.temperature !== undefined) {
    params.temperature = request.temperature;
  }
  if (request.topP !== undefined) {
    params.top_p = request.topP;
  }
  if (request.topK !== undefined) {
    params.top_k = request.topK;
  }
  if (request.stopSequences !== undefined) {
    params.stop_sequences = request.stopSequences;
  }
  if (request.metadata?.userId !== undefined) {
    params.metadata = { user_id: request.metadata.userId };
  }
  if (request.reasoning !== undefined) {
    // Neutral enum passes through verbatim; the SDK's effort type omits some
    // neutral levels ("minimal"), so we cast rather than gate — the provider
    // validates the value (SPEC "Reasoning").
    params.output_config = {
      effort: request.reasoning.effort as Anthropic.OutputConfig["effort"],
    };
  }
  return params;
}

function toResponse(message: Anthropic.Message): Response {
  if (!Array.isArray(message?.content)) {
    throw new LLMDriverError(
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

function normalizeError(error: unknown, reachedTransport: boolean): LLMDriverError {
  if (error instanceof LLMDriverError) {
    return error;
  }
  const options = { ...CONTEXT, cause: error };
  if (error instanceof APIError) {
    // A mid-stream `error` event also arrives as an APIError, without a status;
    // only a connection failure is a transport problem.
    if (error instanceof APIConnectionError) {
      return new LLMDriverError("transport_failed", error.message, options);
    }
    return new LLMDriverError("api_error", apiErrorMessage(error), {
      ...options,
      status: error.status,
      providerCode: error.type ?? undefined,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  // An SDK error, or anything raised before a request ever left the process, is
  // a setup problem — unresolvable credentials above all — not a transport one.
  if (error instanceof AnthropicError || !reachedTransport) {
    return new LLMDriverError("invalid_config", message, options);
  }
  return new LLMDriverError("transport_failed", message, options);
}

/** Anthropic reports the human-readable message inside `error.error.message`. */
function apiErrorMessage(error: APIError): string {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  return typeof message === "string" && message !== "" ? message : error.message;
}
