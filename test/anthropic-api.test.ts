import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/client.js";
import { LLMWrapperError } from "../src/errors.js";
import { assistant, type Request as GenerateRequest, user } from "../src/types.js";

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

async function rejection(promise: Promise<unknown>): Promise<LLMWrapperError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LLMWrapperError);
    return error as LLMWrapperError;
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

  it("omits system when the request has none", async () => {
    const stub = stubFetch(200, MESSAGE);
    await clientWith(stub.impl).generate({ maxTokens: 8, messages: [user("hello")] });

    const body = (await (stub.calls[0] as Request).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("system");
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
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 2,
        reasoningTokens: 0,
      },
    });
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
});
