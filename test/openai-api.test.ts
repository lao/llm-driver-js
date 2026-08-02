import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { LLMWrapperError } from "../src/errors.js";
import { assistant, type Request as GenerateRequest, user } from "../src/types.js";

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

async function rejection(promise: Promise<unknown>): Promise<LLMWrapperError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LLMWrapperError);
    return error as LLMWrapperError;
  }
  throw new Error("expected generate() to reject");
}

describe("openai api backend", () => {
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

  it("omits instructions when the request has no system prompt", async () => {
    const stub = stubFetch(200, RESPONSE);
    await clientWith(stub.impl).generate({ maxTokens: 8, messages: [user("hello")] });

    const body = (await (stub.calls[0] as Request).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("instructions");
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

  it("aborts an in-flight request", async () => {
    const controller = new AbortController();
    const client = clientWith(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const pending = client.generate(PROMPT, { signal: controller.signal });
    controller.abort();
    const error = await rejection(pending);

    expect(error.code).toBe("transport_failed");
  });
});
