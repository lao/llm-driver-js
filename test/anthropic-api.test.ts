import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client.js";
import { LLMDriverError } from "../src/errors.js";
import {
  assistant,
  type Request as GenerateRequest,
  type StreamEvent,
  user,
} from "../src/types.js";

const BASE_URL = "https://anthropic.test";

const MESSAGE = {
  id: "msg_123",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content: [
    { type: "text", text: "Hello, " },
    { type: "text", text: "world" },
  ],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
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
    provider: "claude",
    flavor: "api",
    model: "claude-test",
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

describe("anthropic api backend", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes unresolvable credentials into invalid_config", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
    // Keeps the SDK's credential chain off any config file this machine has.
    vi.stubEnv("ANTHROPIC_CONFIG_DIR", join(tmpdir(), "llmwrapper-absent-config"));
    // Unresolvable host: if credentials ever did resolve, the test fails loudly
    // instead of reaching a real API.
    const client = createClient({
      provider: "claude",
      flavor: "api",
      model: "claude-test",
      baseUrl: BASE_URL,
    });

    const error = await rejection(client.generate(PROMPT));

    expect(error.code).toBe("invalid_config");
    expect(error.provider).toBe("claude");
    expect(error.flavor).toBe("api");
    expect(error.operation).toBe("generate");
  });

  it("maps the request onto the Messages API", async () => {
    const stub = stubFetch(200, MESSAGE);
    await clientWith(stub.impl).generate(PROMPT);

    expect(stub.calls).toHaveLength(1);
    const request = stub.calls[0] as Request;
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe("/v1/messages");
    expect(request.headers.get("x-api-key")).toBe("test-key");
    expect(request.headers.get("anthropic-version")).toBeTruthy();

    expect(await request.json()).toMatchObject({
      model: "claude-test",
      max_tokens: 64,
      system: [{ type: "text", text: "Be concise." }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    });
  });

  it("maps reasoning.effort onto output_config", async () => {
    const stub = stubFetch(200, MESSAGE);
    await clientWith(stub.impl).generate({ ...PROMPT, reasoning: { effort: "high" } });

    expect(await (stub.calls[0] as Request).json()).toMatchObject({
      output_config: { effort: "high" },
    });
  });

  it("omits output_config when the request has no reasoning", async () => {
    const stub = stubFetch(200, MESSAGE);
    await clientWith(stub.impl).generate(PROMPT);

    expect(await (stub.calls[0] as Request).json()).not.toHaveProperty("output_config");
  });

  it("omits system when the request has none", async () => {
    const stub = stubFetch(200, MESSAGE);
    await clientWith(stub.impl).generate({ maxTokens: 8, messages: [user("hello")] });

    const body = (await (stub.calls[0] as Request).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("system");
  });

  it("maps sampling params and metadata onto the Messages API", async () => {
    const stub = stubFetch(200, MESSAGE);
    await clientWith(stub.impl).generate({
      maxTokens: 8,
      messages: [user("hello")],
      topP: 0.9,
      topK: 40,
      stopSequences: ["STOP", "END"],
      metadata: { userId: "user-42" },
    });

    expect(await (stub.calls[0] as Request).json()).toMatchObject({
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ["STOP", "END"],
      metadata: { user_id: "user-42" },
    });
  });

  it("omits sampling params and metadata when the request has none", async () => {
    const stub = stubFetch(200, MESSAGE);
    await clientWith(stub.impl).generate({ maxTokens: 8, messages: [user("hello")] });

    const body = (await (stub.calls[0] as Request).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
    expect(body).not.toHaveProperty("stop_sequences");
    expect(body).not.toHaveProperty("metadata");
  });

  it("maps the response and usage", async () => {
    const stub = stubFetch(200, MESSAGE);
    const response = await clientWith(stub.impl).generate(PROMPT);

    expect(response).toEqual({
      id: "msg_123",
      model: "claude-test",
      text: "Hello, world",
      completionReason: "stop",
      provider: "claude",
      flavor: "api",
      toolCalls: [],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 2,
        reasoningTokens: 0,
      },
    });
  });

  it("maps outputSchema onto output_config.format and parses the result", async () => {
    const schema = { type: "object", properties: { answer: { type: "number" } } };
    const stub = stubFetch(200, {
      ...MESSAGE,
      content: [{ type: "text", text: '{"answer":42}' }],
    });

    const response = await clientWith(stub.impl).generate({ ...PROMPT, outputSchema: schema });

    const body = (await (stub.calls[0] as Request).json()) as Record<string, unknown>;
    expect(body.output_config).toEqual({ format: { type: "json_schema", schema } });
    expect(response.structured).toEqual({ answer: 42 });
    expect(response.text).toBe('{"answer":42}');
  });

  it("rejects unparseable structured output with parse_failed", async () => {
    const stub = stubFetch(200, { ...MESSAGE, content: [{ type: "text", text: "not json" }] });

    const error = await rejection(
      clientWith(stub.impl).generate({ ...PROMPT, outputSchema: { type: "object" } }),
    );

    expect(error.code).toBe("parse_failed");
    expect(error.provider).toBe("claude");
    expect(error.flavor).toBe("api");
    expect(error.operation).toBe("generate");
  });

  it("leaves structured undefined and output_config absent without outputSchema", async () => {
    const stub = stubFetch(200, MESSAGE);
    const response = await clientWith(stub.impl).generate(PROMPT);

    const body = (await (stub.calls[0] as Request).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("output_config");
    expect(response).not.toHaveProperty("structured");
  });

  it("defaults unreported usage counters to zero", async () => {
    const stub = stubFetch(200, {
      ...MESSAGE,
      usage: { input_tokens: 4, output_tokens: 6, cache_read_input_tokens: null },
    });
    const response = await clientWith(stub.impl).generate(PROMPT);

    expect(response.usage).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
    });
  });

  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "max_tokens"],
    ["refusal", "refusal"],
    ["tool_use", ""],
    [null, ""],
  ])("maps stop_reason %s to %s", async (stopReason, expected) => {
    const stub = stubFetch(200, { ...MESSAGE, stop_reason: stopReason });
    const response = await clientWith(stub.impl).generate(PROMPT);

    expect(response.completionReason).toBe(expected);
  });

  it.each([
    [400, "invalid_request_error", "bad request"],
    [401, "authentication_error", "invalid x-api-key"],
    [429, "rate_limit_error", "slow down"],
    [500, "api_error", "internal failure"],
  ])("normalizes HTTP %i into an api_error", async (status, type, message) => {
    const stub = stubFetch(status, { type: "error", error: { type, message } });
    const error = await rejection(clientWith(stub.impl).generate(PROMPT));

    expect(error.code).toBe("api_error");
    expect(error.status).toBe(status);
    expect(error.providerCode).toBe(type);
    expect(error.message).toBe(message);
    expect(error.provider).toBe("claude");
    expect(error.flavor).toBe("api");
    expect(error.operation).toBe("generate");
    expect(stub.calls).toHaveLength(1); // no retries
  });

  it("normalizes a transport failure", async () => {
    const cause = new TypeError("fetch failed");
    const error = await rejection(clientWith(() => Promise.reject(cause)).generate(PROMPT));

    expect(error.code).toBe("transport_failed");
    expect(error.status).toBeUndefined();
    expect(error.provider).toBe("claude");
  });

  it("normalizes an unexpected payload shape", async () => {
    const stub = stubFetch(200, { id: "msg_123" });
    const error = await rejection(clientWith(stub.impl).generate(PROMPT));

    expect(error.code).toBe("parse_failed");
    expect(error.provider).toBe("claude");
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

  it("hands maxRetries to the SDK, retrying a retryable failure", async () => {
    let calls = 0;
    const impl: typeof fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }),
        // retry-after-ms:0 keeps the retries instant rather than backing off.
        { status: 500, headers: { "content-type": "application/json", "retry-after-ms": "0" } },
      );
    };
    const client = createClient({
      provider: "claude",
      flavor: "api",
      model: "claude-test",
      apiKey: "test-key",
      baseUrl: BASE_URL,
      fetch: impl,
      maxRetries: 2,
    });

    await rejection(client.generate(PROMPT));

    expect(calls).toBe(3); // initial attempt + two retries
  });

  it("hands timeoutMs to the SDK, which aborts a slow request", async () => {
    const client = createClient({
      provider: "claude",
      flavor: "api",
      model: "claude-test",
      apiKey: "test-key",
      baseUrl: BASE_URL,
      // Never resolves until the SDK's own timeout aborts it.
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      timeoutMs: 20,
    });

    const error = await rejection(client.generate(PROMPT));

    expect(error.code).toBe("transport_failed");
  });
});

const MESSAGE_START = {
  type: "message_start",
  message: {
    id: "msg_stream",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 1,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    },
  },
};

function messageDelta(stopReason: string) {
  return {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    // Mirrors the wire format: only output_tokens is reported per delta.
    usage: {
      input_tokens: null,
      output_tokens: 5,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    },
  };
}

function textDelta(text: string) {
  return { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
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

describe("anthropic api backend streaming", () => {
  it("streams text deltas and ends with a done event", async () => {
    const stub = stubSse([
      sse("message_start", MESSAGE_START),
      sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      sse("content_block_delta", textDelta("Hello, ")),
      sse("content_block_delta", textDelta("world")),
      sse("content_block_stop", { type: "content_block_stop", index: 0 }),
      sse("message_delta", messageDelta("end_turn")),
      sse("message_stop", { type: "message_stop" }),
    ]);

    const events = await collect(clientWith(stub.impl).generateStream(PROMPT));

    expect(await (stub.requests[0] as Request).json()).toMatchObject({
      stream: true,
      model: "claude-test",
      max_tokens: 64,
    });
    expect(events).toEqual([
      { type: "text", text: "Hello, " },
      { type: "text", text: "world" },
      {
        type: "done",
        response: {
          id: "msg_stream",
          model: "claude-test",
          text: "Hello, world",
          completionReason: "stop",
          provider: "claude",
          flavor: "api",
          toolCalls: [],
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedInputTokens: 3,
            cacheCreationInputTokens: 2,
            reasoningTokens: 0,
          },
        },
      },
    ]);
  });

  it("maps thinking_delta events to interleaved reasoning without polluting the text", async () => {
    const stub = stubSse([
      sse("message_start", MESSAGE_START),
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Think" },
      }),
      sse("content_block_delta", textDelta("Hello, ")),
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "ing" },
      }),
      sse("content_block_delta", textDelta("world")),
      sse("message_delta", messageDelta("end_turn")),
      sse("message_stop", { type: "message_stop" }),
    ]);

    const events = await collect(clientWith(stub.impl).generateStream(PROMPT));

    expect(events.slice(0, 4)).toEqual([
      { type: "reasoning", text: "Think" },
      { type: "text", text: "Hello, " },
      { type: "reasoning", text: "ing" },
      { type: "text", text: "world" },
    ]);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected a done event");
    expect(done.response.text).toBe("Hello, world");
  });

  it("yields only a done event when the stream carries no text", async () => {
    const stub = stubSse([
      sse("message_start", MESSAGE_START),
      sse("message_delta", messageDelta("max_tokens")),
      sse("message_stop", { type: "message_stop" }),
    ]);

    const events = await collect(clientWith(stub.impl).generateStream(PROMPT));

    expect(events).toEqual([
      {
        type: "done",
        response: expect.objectContaining({ text: "", completionReason: "max_tokens" }),
      },
    ]);
    // No reasoning deltas in the stream, so no reasoning events (no placeholders).
    expect(events.some((event) => event.type === "reasoning")).toBe(false);
  });

  it("reports a refusal from the message_delta stop reason", async () => {
    const stub = stubSse([
      sse("message_start", MESSAGE_START),
      sse("content_block_delta", textDelta("I can't ")),
      sse("content_block_delta", textDelta("help with that")),
      sse("message_delta", messageDelta("refusal")),
      sse("message_stop", { type: "message_stop" }),
    ]);

    const events = await collect(clientWith(stub.impl).generateStream(PROMPT));

    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected a done event last");
    expect(done.response.completionReason).toBe("refusal");
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe(done.response.text);
    expect(done.response.text).toBe("I can't help with that");
  });

  it("normalizes a mid-stream error event into an api_error", async () => {
    const stub = stubSse([
      sse("message_start", MESSAGE_START),
      sse("content_block_delta", textDelta("Hello")),
      sse("error", {
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
    ]);

    const error = await rejection(collect(clientWith(stub.impl).generateStream(PROMPT)));

    expect(error.code).toBe("api_error");
    expect(error.providerCode).toBe("overloaded_error");
    expect(error.message).toBe("Overloaded");
    expect(error.provider).toBe("claude");
    expect(error.flavor).toBe("api");
  });

  it("normalizes a stream that never reports a message", async () => {
    const stub = stubSse([
      sse("content_block_delta", textDelta("orphan")),
      sse("message_stop", { type: "message_stop" }),
    ]);

    const error = await rejection(collect(clientWith(stub.impl).generateStream(PROMPT)));

    expect(error.code).toBe("parse_failed");
    expect(error.provider).toBe("claude");
  });

  it("normalizes a malformed SSE event instead of leaking a SyntaxError", async () => {
    const stub = stubSse([
      sse("message_start", MESSAGE_START),
      sse("content_block_delta", textDelta("Hello")),
      "event: content_block_delta\ndata: {not json\n\n",
    ]);

    const error = await rejection(collect(clientWith(stub.impl).generateStream(PROMPT)));

    // The SDK raises the parse failure as a plain SyntaxError mid-iteration.
    expect(error.code).toBe("transport_failed");
    expect(error.cause).toBeInstanceOf(SyntaxError);
    expect(error.provider).toBe("claude");
    expect(error.flavor).toBe("api");
  });

  it("aborts mid-stream and surfaces the abort reason itself", async () => {
    const stub = stubSse(
      [sse("message_start", MESSAGE_START), sse("content_block_delta", textDelta("Hello"))],
      { keepOpen: true },
    );
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
    const stub = stubSse(
      [sse("message_start", MESSAGE_START), sse("content_block_delta", textDelta("Hello"))],
      { keepOpen: true },
    );

    for await (const event of clientWith(stub.impl).generateStream(PROMPT)) {
      expect(event).toEqual({ type: "text", text: "Hello" });
      break;
    }

    expect(stub.signals[0]?.aborted).toBe(true);
  });
});
