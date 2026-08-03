import { describe, expect, it } from "vitest";
import { validateRequest } from "../src/client.js";
import { LLMShimError } from "../src/errors.js";
import { assistant, type Config, type Request, type Role, user } from "../src/types.js";

const config: Config = { provider: "openai", flavor: "cli", model: "test-model" };

function expectInvalidRequest(request: Request): LLMShimError {
  let caught: unknown;
  try {
    validateRequest(request, config);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LLMShimError);
  const error = caught as LLMShimError;
  expect(error.code).toBe("invalid_request");
  return error;
}

describe("message helpers", () => {
  it("builds user and assistant messages", () => {
    expect(user("hello")).toEqual({ role: "user", text: "hello" });
    expect(assistant("hi")).toEqual({ role: "assistant", text: "hi" });
  });
});

describe("validateRequest", () => {
  it("accepts a multi-turn transcript", () => {
    expect(() =>
      validateRequest(
        {
          system: "be concise",
          messages: [user("hello"), assistant("hi"), user("continue")],
          maxTokens: 128,
        },
        config,
      ),
    ).not.toThrow();
  });

  it("rejects a missing or non-object request", () => {
    for (const request of [undefined, null, 42]) {
      const error = expectInvalidRequest(request as unknown as Request);
      expect(error.message).toBe("request is required");
    }
  });

  it("rejects an empty transcript", () => {
    expectInvalidRequest({ messages: [], maxTokens: 1 });
    expectInvalidRequest({ messages: undefined as unknown as Request["messages"], maxTokens: 1 });
  });

  it("rejects empty message text", () => {
    expectInvalidRequest({ messages: [user("")], maxTokens: 1 });
    expectInvalidRequest({ messages: [user("hello"), assistant("  ")], maxTokens: 1 });
  });

  it("rejects an invalid role", () => {
    expectInvalidRequest({ messages: [{ role: "system" as Role, text: "hello" }], maxTokens: 1 });
  });

  it("rejects a non-positive or non-integer maxTokens", () => {
    for (const maxTokens of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectInvalidRequest({ messages: [user("hello")], maxTokens });
    }
    expectInvalidRequest({
      messages: [user("hello")],
      maxTokens: undefined as unknown as number,
    });
  });

  it("rejects a non-string system prompt", () => {
    for (const system of [42, {}, ["a"], null]) {
      expectInvalidRequest({
        system: system as unknown as string,
        messages: [user("hello")],
        maxTokens: 1,
      });
    }
  });

  it("stamps target context on request errors", () => {
    const error = expectInvalidRequest({ messages: [], maxTokens: 1 });
    expect(error.provider).toBe("openai");
    expect(error.flavor).toBe("cli");
    expect(error.operation).toBe("generate");
  });
});
