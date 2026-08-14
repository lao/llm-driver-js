import OpenAI, { APIConnectionError, APIError, OpenAIError } from "openai";
import { LLMDriverError } from "../errors.js";
import type { CompletionReason, Config, JsonSchema, Request, Response } from "../types.js";
import type { Backend } from "./backend.js";

const CONTEXT = { provider: "openai", flavor: "api", operation: "generate" } as const;

/** OpenAI Responses API backend (`openai`/`api`). */
export function createOpenAiApiBackend(config: Config): Backend {
  // Built on first use so credential resolution fails from generate() rather
  // than from createClient().
  let client: OpenAI | undefined;
  const ensureClient = (): OpenAI =>
    (client ??= new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      fetch: config.fetch,
      // Default 0 keeps v1's one-request-per-generate() behavior; a caller opts in.
      maxRetries: config.maxRetries ?? 0,
      timeout: config.timeoutMs, // undefined leaves the SDK default in place
    }));

  return {
    async generate(request, signal) {
      try {
        return toResponse(
          await ensureClient().responses.create(toParams(config.model, request), { signal }),
          request.outputSchema,
        );
      } catch (error) {
        // An abort surfaces the signal's own reason, like the CLI flavors —
        // never the SDK's APIUserAbortError stand-in.
        if (signal?.aborted) throw signal.reason;
        throw normalizeError(error);
      }
    },

    async *generateStream(request, signal) {
      // Aborted in the generator's cleanup so an early consumer break tears the
      // HTTP stream down instead of leaking it.
      const controller = new AbortController();
      try {
        const stream = await ensureClient().responses.create(
          { ...toParams(config.model, request), stream: true },
          { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal },
        );

        let final: OpenAI.Responses.Response | undefined;
        for await (const event of stream) {
          // Refusal text lands in the final response's text, so it has to be
          // streamed too for the deltas to add up to it.
          if (
            event.type === "response.output_text.delta" ||
            event.type === "response.refusal.delta"
          ) {
            yield { type: "text", text: event.delta };
          } else if (event.type === "response.reasoning_summary_text.delta") {
            // Reasoning is surfaced but never folded into `text`.
            yield { type: "reasoning", text: event.delta };
          } else if (event.type === "error") {
            throw new LLMDriverError("api_error", event.message, {
              ...CONTEXT,
              providerCode: event.code ?? undefined,
            });
          } else if (
            event.type === "response.completed" ||
            event.type === "response.incomplete" ||
            event.type === "response.failed"
          ) {
            final = event.response;
          }
        }

        // The SDK ends the iteration silently on abort, so the check has to be
        // here rather than only in the catch.
        if (signal?.aborted) throw signal.reason;
        if (!final) {
          throw new LLMDriverError(
            "parse_failed",
            "OpenAI stream ended without a final response",
            CONTEXT,
          );
        }
        yield { type: "done", response: toResponse(final, request.outputSchema) };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw normalizeError(error);
      } finally {
        controller.abort();
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
  if (request.temperature !== undefined) {
    params.temperature = request.temperature;
  }
  if (request.topP !== undefined) {
    params.top_p = request.topP;
  }
  if (request.metadata?.userId !== undefined) {
    params.safety_identifier = request.metadata.userId;
  }
  if (request.reasoning !== undefined) {
    params.reasoning = { effort: request.reasoning.effort };
  }
  if (request.outputSchema) {
    params.text = {
      format: { type: "json_schema", name: "output", schema: request.outputSchema, strict: true },
    };
  }
  return params;
}

function toResponse(response: OpenAI.Responses.Response, outputSchema?: JsonSchema): Response {
  if (!Array.isArray(response?.output)) {
    throw new LLMDriverError("parse_failed", "OpenAI response contained no output items", CONTEXT);
  }
  assertTerminalStatus(response);
  const usage = response.usage;
  const text = outputText(response);
  const result: Response = {
    id: response.id ?? "",
    model: response.model ?? "",
    text,
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
    toolCalls: [],
  };
  if (outputSchema !== undefined) {
    result.structured = parseStructured(text);
  }
  return result;
}

/** Parses structured-output text as JSON; unparseable output is `parse_failed`. */
function parseStructured(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new LLMDriverError("parse_failed", "OpenAI structured output was not valid JSON", {
      ...CONTEXT,
      cause: error,
    });
  }
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
  throw new LLMDriverError("api_error", message, {
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

function normalizeError(error: unknown): LLMDriverError {
  if (error instanceof LLMDriverError) {
    return error;
  }
  const options = { ...CONTEXT, cause: error };
  if (error instanceof APIError) {
    // A mid-stream error payload also arrives as an APIError, without a status;
    // only a connection failure is a transport problem.
    if (error instanceof APIConnectionError) {
      return new LLMDriverError("transport_failed", error.message, options);
    }
    return new LLMDriverError("api_error", apiErrorMessage(error), {
      ...options,
      status: error.status,
      providerCode: error.code || error.type || undefined,
    });
  }
  if (error instanceof OpenAIError) {
    return new LLMDriverError("invalid_config", error.message, options);
  }
  return new LLMDriverError(
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
