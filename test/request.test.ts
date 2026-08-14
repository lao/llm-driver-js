import { describe, expect, it } from "vitest";
import { validateRequest } from "../src/client.js";
import { LLMDriverError } from "../src/errors.js";
import {
  assistant,
  type Config,
  type ContentBlock,
  type Message,
  type Request,
  type Role,
  user,
} from "../src/types.js";

const config: Config = { provider: "openai", flavor: "cli", model: "test-model" };
// API target: content blocks pass the capability gate here so validation, not
// portability, is what request-shape tests observe.
const apiConfig: Config = { provider: "claude", flavor: "api", model: "test-model" };

const PNG: ContentBlock = {
  type: "image",
  source: { base64: "aGVsbG8=", mediaType: "image/png" },
};

function expectInvalidRequest(request: Request, cfg: Config = config): LLMDriverError {
  let caught: unknown;
  try {
    validateRequest(request, cfg);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LLMDriverError);
  const error = caught as LLMDriverError;
  expect(error.code).toBe("invalid_request");
  return error;
}

describe("message helpers", () => {
  it("builds user and assistant text messages", () => {
    expect(user("hello")).toEqual({ role: "user", text: "hello" });
    expect(assistant("hi")).toEqual({ role: "assistant", text: "hi" });
  });

  it("builds user and assistant content-block messages", () => {
    const blocks: ContentBlock[] = [{ type: "text", text: "look" }, PNG];
    expect(user(blocks)).toEqual({ role: "user", content: blocks });
    expect(assistant([{ type: "text", text: "ok" }])).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    });
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

  it("accepts a well-formed content-block transcript", () => {
    expect(() =>
      validateRequest(
        {
          messages: [
            user([
              { type: "text", text: "describe" },
              PNG,
              { type: "image", source: { url: "https://example.test/a.png" } },
              { type: "document", source: { base64: "cGRm", mediaType: "application/pdf" } },
            ]),
          ],
          maxTokens: 64,
        },
        apiConfig,
      ),
    ).not.toThrow();
  });

  it("rejects a message with both text and content", () => {
    const error = expectInvalidRequest({
      messages: [{ role: "user", text: "hi", content: [{ type: "text", text: "hi" }] }],
      maxTokens: 1,
    });
    expect(error.message).toBe("message 0 must have exactly one of text or content");
  });

  it("rejects a message with neither text nor content", () => {
    const error = expectInvalidRequest({ messages: [{ role: "user" }], maxTokens: 1 });
    expect(error.message).toBe("message 0 must have exactly one of text or content");
  });

  it("rejects an empty content array", () => {
    const error = expectInvalidRequest({ messages: [user([])], maxTokens: 1 });
    expect(error.message).toBe("message 0 content must be a non-empty array");
  });

  it("reports the offending message index for a bad block", () => {
    const error = expectInvalidRequest(
      {
        messages: [user("ok"), user([{ type: "flavour" } as unknown as ContentBlock])],
        maxTokens: 1,
      },
      apiConfig,
    );
    expect(error.message).toBe('message 1 content block 0 has unknown type "flavour"');
  });

  it.each<[string, ContentBlock, string]>([
    [
      "empty text block",
      { type: "text", text: "" },
      "content block 0 text must be a non-empty string",
    ],
    [
      "image without base64 or url",
      { type: "image", source: {} as never },
      "content block 0 image source needs base64 or url",
    ],
    [
      "image with bad media type",
      { type: "image", source: { base64: "x", mediaType: "image/tiff" as never } },
      "content block 0 image mediaType is invalid",
    ],
    [
      "document without base64",
      { type: "document", source: { mediaType: "application/pdf" } as never },
      "content block 0 document source needs base64",
    ],
    [
      "document with wrong media type",
      { type: "document", source: { base64: "x", mediaType: "text/plain" as never } },
      "content block 0 document mediaType must be application/pdf",
    ],
  ])("rejects an %s", (_name, block, expected) => {
    const message: Message = { role: "user", content: [block] };
    const error = expectInvalidRequest({ messages: [message], maxTokens: 1 }, apiConfig);
    expect(error.message).toBe(`message 0 ${expected}`);
  });

  it("stamps target context on request errors", () => {
    const error = expectInvalidRequest({ messages: [], maxTokens: 1 });
    expect(error.provider).toBe("openai");
    expect(error.flavor).toBe("cli");
    expect(error.operation).toBe("generate");
  });
});
