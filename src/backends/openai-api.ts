import OpenAI, { APIError, OpenAIError } from "openai";
import { LLMWrapperError } from "../errors.js";
import type { CompletionReason, Config, Request, Response } from "../types.js";
import type { Backend } from "./backend.js";

const CONTEXT = { provider: "openai", flavor: "api", operation: "generate" } as const;

/** OpenAI Responses API backend (`openai`/`api`). */
export function createOpenAiApiBackend(config: Config): Backend {
  // Built on first use so credential resolution fails from generate() rather
  // than from createClient().
  let client: OpenAI | undefined;

  return {
    async generate(request, signal) {
      try {
        client ??= new OpenAI({
          apiKey: config.apiKey,
          baseURL: config.baseUrl,
          fetch: config.fetch,
          maxRetries: 0, // retries are out of scope: one request per generate()
        });
        return toResponse(
          await client.responses.create(toParams(config.model, request), { signal }),
        );
      } catch (error) {
        // An abort surfaces its own reason untouched, like the CLI flavors.
        if (signal?.aborted) throw error;
        throw normalizeError(error);
      }
    },
  };
}

function toParams(
  model: string,
  request: Request,
): OpenAI.Responses.ResponseCreateParamsNonStreaming {
  const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
    model,
    max_output_tokens: request.maxTokens,
    input: request.messages.map(
      (message): OpenAI.Responses.EasyInputMessage => ({
        type: "message",
        role: message.role,
        content: [{ type: "input_text", text: message.text }],
        // Preserve the completed-answer phase so current models keep full
        // follow-up quality on prior assistant turns.
        phase: message.role === "assistant" ? "final_answer" : undefined,
      }),
    ),
  };
  if (request.system) {
    params.instructions = request.system;
  }
  return params;
}

function toResponse(response: OpenAI.Responses.Response): Response {
  if (!Array.isArray(response?.output)) {
    throw new LLMWrapperError("parse_failed", "OpenAI response contained no output items", CONTEXT);
  }
  assertTerminalStatus(response);
  const usage = response.usage;
  return {
    id: response.id ?? "",
    model: response.model ?? "",
    text: outputText(response),
    completionReason: toCompletionReason(response),
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
      cacheCreationInputTokens: usage?.input_tokens_details?.cache_write_tokens ?? 0,
      reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
    },
    provider: "openai",
    flavor: "api",
  };
}

/** A truncated response still carries usable text; any other non-completed status is an error. */
function assertTerminalStatus(response: OpenAI.Responses.Response): void {
  const incompleteReason = response.incomplete_details?.reason ?? "";
  const errorCode = response.error?.code ?? "";
  const truncated = response.status === "incomplete" && incompleteReason === "max_output_tokens";
  if (response.status === "completed" || (truncated && errorCode === "")) {
    return;
  }

  let code: string = response.status ?? "";
  let message = "OpenAI response did not complete";
  if (errorCode !== "") {
    code = errorCode;
    message = response.error?.message ?? message;
  } else if (incompleteReason !== "") {
    code = incompleteReason;
    message = `OpenAI response was incomplete: ${incompleteReason}`;
  }
  throw new LLMWrapperError("api_error", message, {
    ...CONTEXT,
    providerCode: code || "unknown_status",
  });
}

/** Yields the content blocks of every well-formed message item, skipping the rest. */
function* messageContents(
  response: OpenAI.Responses.Response,
): Generator<OpenAI.Responses.ResponseOutputText | OpenAI.Responses.ResponseOutputRefusal> {
  for (const item of response.output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      yield* item.content;
    }
  }
}

function outputText(response: OpenAI.Responses.Response): string {
  let text = "";
  for (const content of messageContents(response)) {
    if (content.type === "output_text") {
      text += content.text;
    } else if (content.type === "refusal") {
      text += content.refusal;
    }
  }
  return text;
}

function toCompletionReason(response: OpenAI.Responses.Response): CompletionReason {
  if (
    response.status === "incomplete" &&
    response.incomplete_details?.reason === "max_output_tokens"
  ) {
    return "max_tokens";
  }
  for (const content of messageContents(response)) {
    if (content.type === "refusal") {
      return "refusal";
    }
  }
  return "stop";
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
      providerCode: error.code || error.type || undefined,
    });
  }
  if (error instanceof OpenAIError) {
    return new LLMWrapperError("invalid_config", error.message, options);
  }
  return new LLMWrapperError(
    "transport_failed",
    error instanceof Error ? error.message : String(error),
    options,
  );
}

/** The SDK prefixes `message` with the status code; the raw body message is cleaner. */
function apiErrorMessage(error: APIError): string {
  const body = error.error as { message?: unknown } | undefined;
  return typeof body?.message === "string" && body.message !== "" ? body.message : error.message;
}
