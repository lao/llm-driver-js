import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client.js";
import { LLMDriverError } from "../src/errors.js";
import {
  assistant,
  type Request as GenerateRequest,
  type StreamEvent,
  user,
} from "../src/types.js";

const BASE_URL = "https://openai.test";

const RESPONSE = {
  id: "resp_123",
  object: "response",
  status: "completed",
  model: "gpt-test",
  output: [
    {
      id: "msg_123",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        { type: "output_text", text: "Hello, ", annotations: [] },
        { type: "output_text", text: "world", annotations: [] },
      ],
    },
  ],
  usage: {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 3, cache_write_tokens: 4 },
    output_tokens: 7,
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 17,
  },
};

const PROMPT: GenerateRequest = {
  system: "Be concise.",
  maxTokens: 64,
  messages: [user("hello"), assistant("hi"), user("continue")],
};

/** Captures outgoing requests and replies with a canned payload. Never hits the network. */
function stubFetch(status: number, body: unknown) {
  const calls: Request[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push(new Request(input, init));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, impl };
}

function clientWith(fetchImpl: typeof fetch) {
  return createClient({
    provider: "openai",
    flavor: "api",
    model: "gpt-test",
    apiKey: "test-key",
    baseUrl: BASE_URL,
    fetch: fetchImpl,
  });
}

async function rejection(promise: Promise<unknown>): Promise<LLMDriverError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LLMDriverError);
    return error as LLMDriverError;
  }
  throw new Error("expected generate() to reject");
}

describe("openai api backend", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes a missing api key into invalid_config", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    // Unresolvable host: if a key ever did resolve, the test fails loudly
    // instead of reaching a real API.
    const client = createClient({
      provider: "openai",
      flavor: "api",
      model: "gpt-test",
      baseUrl: BASE_URL,
    });

    const error = await rejection(client.generate(PROMPT));

    expect(error.code).toBe("invalid_config");
    expect(error.provider).toBe("openai");
    expect(error.flavor).toBe("api");
    expect(error.operation).toBe("generate");
  });

  it("maps the request onto the Responses API", async () => {
    const stub = stubFetch(200, RESPONSE);
    await clientWith(stub.impl).generate(PROMPT);

    expect(stub.calls).toHaveLength(1);
    const request = stub.calls[0] as Request;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/responses");
    expect(request.headers.get("authorization")).toBe("Bearer test-key");

    const body = (await request.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-test",
      max_output_tokens: 64,
      instructions: "Be concise.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "input_text", text: "hi" }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    });
    expect((body.input as Record<string, unknown>[])[0]).not.toHaveProperty("phase");
  });

  it("maps reasoning.effort onto reasoning", async () => {
    const stub = stubFetch(200, RESPONSE);
    await clientWith(stub.impl).generate({ ...PROMPT, reasoning: { effort: "minimal" } });

    expect(await (stub.calls[0] as Request).json()).toMatchObject({
      reasoning: { effort: "minimal" },
    });
  });

  it("omits reasoning when the request has none", async () => {
    const stub = stubFetch(200, RESPONSE);
    await clientWith(stub.impl).generate(PROMPT);

    expect(await (stub.calls[0] as Request).json()).not.toHaveProperty("reasoning");
  });

  it("omits instructions when the request has no system prompt", async () => {
    const stub = stubFetch(200, RESPONSE);
    await clientWith(stub.impl).generate({ maxTokens: 8, messages: [user("hello")] });

    const body = (await (stub.calls[0] as Request).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("instructions");
  });

  it("maps topP and metadata.userId onto the Responses API", async () => {
    const stub = stubFetch(200, RESPONSE);
    await clientWith(stub.impl).generate({
      maxTokens: 8,
      messages: [user("hello")],
      topP: 0.9,
      metadata: { userId: "user-42" },
    });

    expect(await (stub.calls[0] as Request).json()).toMatchObject({
      top_p: 0.9,
      safety_identifier: "user-42",
    });
  });

  it("omits topP and safety_identifier when the request has none", async () => {
    const stub = stubFetch(200, RESPONSE);
    await clientWith(stub.impl).generate({ maxTokens: 8, messages: [user("hello")] });

    const body = (await (stub.calls[0] as Request).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("safety_identifier");
  });

  it("maps the response and usage", async () => {
    const stub = stubFetch(200, RESPONSE);
    const response = await clientWith(stub.impl).generate(PROMPT);

    expect(response).toEqual({
      id: "resp_123",
      model: "gpt-test",
      text: "Hello, world",
      completionReason: "stop",
      provider: "openai",
      flavor: "api",
      usage: {
        inputTokens: 10,
        outputTokens: 7,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 4,
        reasoningTokens: 2,
      },
    });
  });

  it("keeps truncated text and reports max_tokens", async () => {
    const stub = stubFetch(200, {
      ...RESPONSE,
      id: "resp_incomplete",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [
        {
          id: "msg_incomplete",
          type: "message",
          status: "incomplete",
          role: "assistant",
          content: [{ type: "output_text", text: "partial answer", annotations: [] }],
        },
      ],
    });
    const response = await clientWith(stub.impl).generate(PROMPT);

    expect(response.text).toBe("partial answer");
    expect(response.completionReason).toBe("max_tokens");
    expect(response.usage.inputTokens).toBe(10);
  });

  it("keeps refusal text and reports refusal", async () => {
    const stub = stubFetch(200, {
      ...RESPONSE,
      id: "resp_refusal",
      output: [
        {
          id: "msg_refusal",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "refusal", refusal: "I cannot help with that." }],
        },
      ],
      usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
    });
    const response = await clientWith(stub.impl).generate(PROMPT);

    expect(response.text).toBe("I cannot help with that.");
    expect(response.completionReason).toBe("refusal");
    expect(response.usage).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it("rejects a failed terminal response", async () => {
    const stub = stubFetch(200, {
      ...RESPONSE,
      id: "resp_failed",
      status: "failed",
      output: [],
      error: { code: "server_error", message: "generation failed" },
    });
    const error = await rejection(clientWith(stub.impl).generate(PROMPT));

    expect(error.code).toBe("api_error");
    expect(error.providerCode).toBe("server_error");
    expect(error.message).toBe("generation failed");
    expect(error.provider).toBe("openai");
    expect(error.flavor).toBe("api");
    expect(error.operation).toBe("generate");
  });

  it("rejects an incomplete response with a non-truncation reason", async () => {
    const stub = stubFetch(200, {
      ...RESPONSE,
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
    });
    const error = await rejection(clientWith(stub.impl).generate(PROMPT));

    expect(error.code).toBe("api_error");
    expect(error.providerCode).toBe("content_filter");
  });

  it.each([
    [400, "invalid_model", "invalid_request_error", "bad request"],
    [401, "invalid_api_key", "invalid_request_error", "incorrect api key"],
    [429, "rate_limit_exceeded", "requests", "slow down"],
    [500, "", "server_error", "internal failure"],
  ])("normalizes HTTP %i into an api_error", async (status, code, type, message) => {
    const stub = stubFetch(status, { error: { message, type, param: null, code: code || null } });
    const error = await rejection(clientWith(stub.impl).generate(PROMPT));

    expect(error.code).toBe("api_error");
    expect(error.status).toBe(status);
    expect(error.providerCode).toBe(code || type);
    expect(error.message).toBe(message);
    expect(error.provider).toBe("openai");
    expect(error.flavor).toBe("api");
    expect(error.operation).toBe("generate");
    expect(stub.calls).toHaveLength(1); // no retries
  });

  it("normalizes a transport failure", async () => {
    const cause = new TypeError("fetch failed");
    const error = await rejection(clientWith(() => Promise.reject(cause)).generate(PROMPT));

    expect(error.code).toBe("transport_failed");
    expect(error.status).toBeUndefined();
    expect(error.provider).toBe("openai");
  });

  it("normalizes an unexpected payload shape", async () => {
    const stub = stubFetch(200, { id: "resp_123", status: "completed" });
    const error = await rejection(clientWith(stub.impl).generate(PROMPT));

    expect(error.code).toBe("parse_failed");
    expect(error.provider).toBe("openai");
    expect(error.operation).toBe("generate");
  });

  it("aborts an in-flight request and surfaces the abort reason itself", async () => {
    const controller = new AbortController();
    const reason = new Error("my-timeout");
    const client = clientWith(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const pending = client.generate(PROMPT, { signal: controller.signal });
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });
});

function outputTextDelta(delta: string) {
  return {
    type: "response.output_text.delta",
    delta,
    item_id: "msg_123",
    output_index: 0,
    content_index: 0,
    sequence_number: 1,
  };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Serves a canned SSE body. `keepOpen` leaves the stream unfinished so abort and
 * early-break tests can observe the transport being torn down.
 */
function stubSse(chunks: string[], options: { keepOpen?: boolean } = {}) {
  const requests: Request[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const impl: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init));
    const signal = init?.signal ?? undefined;
    signals.push(signal);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        if (options.keepOpen) {
          signal?.addEventListener("abort", () => controller.error(signal.reason));
        } else {
          controller.close();
        }
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { impl, requests, signals };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("openai api backend streaming", () => {
  it("streams text deltas and ends with a done event", async () => {
    const stub = stubSse([
      sse("response.created", { type: "response.created", response: { ...RESPONSE, output: [] } }),
      sse("response.output_text.delta", outputTextDelta("Hello, ")),
      sse("response.output_text.delta", outputTextDelta("world")),
      sse("response.completed", { type: "response.completed", response: RESPONSE }),
    ]);

    const events = await collect(clientWith(stub.impl).generateStream(PROMPT));

    expect(await (stub.requests[0] as Request).json()).toMatchObject({
      stream: true,
      model: "gpt-test",
      max_output_tokens: 64,
    });
    expect(events).toEqual([
      { type: "text", text: "Hello, " },
      { type: "text", text: "world" },
      {
        type: "done",
        response: {
          id: "resp_123",
          model: "gpt-test",
          text: "Hello, world",
          completionReason: "stop",
          provider: "openai",
          flavor: "api",
          usage: {
            inputTokens: 10,
            outputTokens: 7,
            cachedInputTokens: 3,
            cacheCreationInputTokens: 4,
            reasoningTokens: 2,
          },
        },
      },
    ]);
  });

  it("yields only a done event when the stream carries no text", async () => {
    const stub = stubSse([
      sse("response.completed", {
        type: "response.completed",
        response: { ...RESPONSE, output: [] },
      }),
    ]);

    const events = await collect(clientWith(stub.impl).generateStream(PROMPT));

    expect(events).toEqual([
      { type: "done", response: expect.objectContaining({ text: "", completionReason: "stop" }) },
    ]);
  });

  it("keeps truncated text and reports max_tokens", async () => {
    const stub = stubSse([
      sse("response.output_text.delta", outputTextDelta("partial answer")),
      sse("response.incomplete", {
        type: "response.incomplete",
        response: {
          ...RESPONSE,
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [
            {
              id: "msg_incomplete",
              type: "message",
              status: "incomplete",
              role: "assistant",
              content: [{ type: "output_text", text: "partial answer", annotations: [] }],
            },
          ],
        },
      }),
    ]);

    const events = await collect(clientWith(stub.impl).generateStream(PROMPT));

    expect(events[0]).toEqual({ type: "text", text: "partial answer" });
    expect(events[1]).toEqual({
      type: "done",
      response: expect.objectContaining({ text: "partial answer", completionReason: "max_tokens" }),
    });
  });

  it("streams refusal deltas so the concatenation still matches the done text", async () => {
    const stub = stubSse([
      sse("response.refusal.delta", {
        type: "response.refusal.delta",
        delta: "I cannot help with that.",
        item_id: "msg_refusal",
        output_index: 0,
        content_index: 0,
        sequence_number: 1,
      }),
      sse("response.completed", {
        type: "response.completed",
        response: {
          ...RESPONSE,
          output: [
            {
              id: "msg_refusal",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "refusal", refusal: "I cannot help with that." }],
            },
          ],
        },
      }),
    ]);

    const events = await collect(clientWith(stub.impl).generateStream(PROMPT));

    expect(events[0]).toEqual({ type: "text", text: "I cannot help with that." });
    expect(events[1]).toEqual({
      type: "done",
      response: expect.objectContaining({
        text: "I cannot help with that.",
        completionReason: "refusal",
      }),
    });
  });

  it("normalizes a mid-stream error event into an api_error", async () => {
    const stub = stubSse([
      sse("response.output_text.delta", outputTextDelta("Hello")),
      sse("error", {
        type: "error",
        code: "server_error",
        message: "an internal error occurred",
        param: null,
        sequence_number: 2,
      }),
    ]);

    const error = await rejection(collect(clientWith(stub.impl).generateStream(PROMPT)));

    expect(error.code).toBe("api_error");
    expect(error.providerCode).toBe("server_error");
    expect(error.message).toBe("an internal error occurred");
    expect(error.provider).toBe("openai");
    expect(error.flavor).toBe("api");
  });

  it("normalizes a failed final response into an api_error", async () => {
    const stub = stubSse([
      sse("response.failed", {
        type: "response.failed",
        response: {
          ...RESPONSE,
          status: "failed",
          output: [],
          error: { code: "server_error", message: "generation failed" },
        },
      }),
    ]);

    const error = await rejection(collect(clientWith(stub.impl).generateStream(PROMPT)));

    expect(error.code).toBe("api_error");
    expect(error.providerCode).toBe("server_error");
    expect(error.message).toBe("generation failed");
  });

  it("normalizes a stream that never reports a final response", async () => {
    const stub = stubSse([sse("response.output_text.delta", outputTextDelta("orphan"))]);

    const error = await rejection(collect(clientWith(stub.impl).generateStream(PROMPT)));

    expect(error.code).toBe("parse_failed");
    expect(error.provider).toBe("openai");
  });

  it("normalizes a malformed SSE event instead of leaking a SyntaxError", async () => {
    const stub = stubSse([
      sse("response.output_text.delta", outputTextDelta("Hello")),
      "event: response.completed\ndata: {not json\n\n",
    ]);

    const error = await rejection(collect(clientWith(stub.impl).generateStream(PROMPT)));

    // The SDK raises the parse failure as a plain SyntaxError mid-iteration.
    expect(error.code).toBe("transport_failed");
    expect(error.cause).toBeInstanceOf(SyntaxError);
    expect(error.provider).toBe("openai");
    expect(error.flavor).toBe("api");
  });

  it("aborts mid-stream and surfaces the abort reason itself", async () => {
    const stub = stubSse([sse("response.output_text.delta", outputTextDelta("Hello"))], {
      keepOpen: true,
    });
    const controller = new AbortController();
    const reason = new Error("my-timeout");
    const stream = clientWith(stub.impl).generateStream(PROMPT, { signal: controller.signal });

    const drain = (async () => {
      for await (const event of stream) {
        expect(event).toEqual({ type: "text", text: "Hello" });
        controller.abort(reason);
      }
    })();

    await expect(drain).rejects.toBe(reason);
  });

  it("aborts the http stream when the consumer breaks early", async () => {
    const stub = stubSse([sse("response.output_text.delta", outputTextDelta("Hello"))], {
      keepOpen: true,
    });

    for await (const event of clientWith(stub.impl).generateStream(PROMPT)) {
      expect(event).toEqual({ type: "text", text: "Hello" });
      break;
    }

    expect(stub.signals[0]?.aborted).toBe(true);
  });
});
