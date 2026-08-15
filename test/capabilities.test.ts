import { describe, expect, it } from "vitest";
import { createAnthropicApiBackend } from "../src/backends/anthropic-api.js";
import { createClaudeCliBackend } from "../src/backends/claude-cli.js";
import type { Command, CommandRunner } from "../src/backends/cli.js";
import { createCodexCliBackend } from "../src/backends/codex-cli.js";
import { createOpenAiApiBackend } from "../src/backends/openai-api.js";
import { assertSupported, CAPABILITIES, type Target } from "../src/capabilities.js";
import { createClientWithBackend } from "../src/client.js";
import { LLMDriverError } from "../src/errors.js";
import type { Config, ContentBlock, Request as GenerateRequest } from "../src/types.js";
import { user } from "../src/types.js";

const REQUEST: GenerateRequest = { maxTokens: 32, messages: [user("Hello")], temperature: 0.7 };

const CONFIGS: Record<Target, Config> = {
  "claude/api": { provider: "claude", flavor: "api", model: "m" },
  "openai/api": { provider: "openai", flavor: "api", model: "m" },
  "claude/cli": { provider: "claude", flavor: "cli", model: "m" },
  "openai/cli": { provider: "openai", flavor: "cli", model: "m" },
};

const ALL_TARGETS = Object.keys(CONFIGS) as Target[];

/** A CLI runner that fails the test if the client reaches the transport. */
function neverRun(): { runner: CommandRunner; calls: Command[] } {
  const calls: Command[] = [];
  const runner: CommandRunner = async (command) => {
    calls.push(command);
    throw new Error("runner must not be invoked when the feature is unsupported");
  };
  return { runner, calls };
}

/** Real CLI backend behind the client, so an escaped gate would actually spawn. */
function cliClient(target: "claude/cli" | "openai/cli", runner: CommandRunner) {
  const config = CONFIGS[target];
  const backend =
    target === "claude/cli"
      ? createClaudeCliBackend(config, runner)
      : createCodexCliBackend(config, runner);
  return createClientWithBackend(config, backend);
}

describe("assertSupported (matrix gate)", () => {
  it("is driven by a single data table", () => {
    // Guards the invariant the acceptance criteria hinge on: adding a feature is
    // one row here, not new gate code.
    expect(CAPABILITIES.map((c) => c.feature)).toContain("temperature");
    for (const capability of CAPABILITIES) {
      expect(typeof capability.used).toBe("function");
      expect(capability.supported.length).toBeGreaterThan(0);
    }
  });

  it.each(ALL_TARGETS)("does not throw at the gate on %s without gated features", (target) => {
    expect(() =>
      assertSupported({ maxTokens: 8, messages: [user("hi")] }, CONFIGS[target]),
    ).not.toThrow();
  });

  it.each([
    ["claude/api", false],
    ["openai/api", false],
    ["claude/cli", true],
    ["openai/cli", true],
  ] as const)("temperature on %s throws unsupported=%s", (target, shouldThrow) => {
    const call = () => assertSupported(REQUEST, CONFIGS[target]);
    if (!shouldThrow) {
      expect(call).not.toThrow();
      return;
    }
    let error: unknown;
    try {
      call();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LLMDriverError);
    const err = error as LLMDriverError;
    expect(err.code).toBe("unsupported_feature");
    expect(err.message).toContain("temperature");
    expect(err.message).toContain(target);
    expect(err.provider).toBe(CONFIGS[target].provider);
    expect(err.flavor).toBe(CONFIGS[target].flavor);
    expect(err.operation).toBe("generate");
  });
});

/** A minimal request exercising exactly one gated feature, keyed by feature name. */
const FEATURE_REQUESTS: Record<string, GenerateRequest> = {
  temperature: { maxTokens: 8, messages: [user("hi")], temperature: 0.7 },
  topP: { maxTokens: 8, messages: [user("hi")], topP: 0.9 },
  topK: { maxTokens: 8, messages: [user("hi")], topK: 40 },
  stopSequences: { maxTokens: 8, messages: [user("hi")], stopSequences: ["STOP"] },
  "metadata.userId": { maxTokens: 8, messages: [user("hi")], metadata: { userId: "u1" } },
  "reasoning.effort": { maxTokens: 8, messages: [user("hi")], reasoning: { effort: "low" } },
  outputSchema: { maxTokens: 8, messages: [user("hi")], outputSchema: { type: "object" } },
  "image input": {
    maxTokens: 8,
    messages: [user([{ type: "image", source: { base64: "x", mediaType: "image/png" } }])],
  },
  "document input": {
    maxTokens: 8,
    messages: [user([{ type: "document", source: { base64: "x", mediaType: "application/pdf" } }])],
  },
  tools: {
    maxTokens: 8,
    messages: [user("hi")],
    tools: [
      { name: "add", description: "adds", inputSchema: { type: "object" }, execute: () => "3" },
    ],
  },
  toolChoice: { maxTokens: 8, messages: [user("hi")], toolChoice: "required" },
};

describe("matrix gate covers every feature × target cell", () => {
  // Table-driven from CAPABILITIES itself: each ✅ cell passes the gate, each ❌
  // cell throws unsupported_feature naming the feature and target.
  const cells = CAPABILITIES.flatMap((capability) =>
    ALL_TARGETS.map((target) => ({ capability, target })),
  );

  it("has a probe request for every gated feature", () => {
    for (const capability of CAPABILITIES) {
      expect(FEATURE_REQUESTS[capability.feature]).toBeDefined();
    }
  });

  it.each(cells)("$capability.feature on $target", ({ capability, target }) => {
    const request = FEATURE_REQUESTS[capability.feature] as GenerateRequest;
    const call = () => assertSupported(request, CONFIGS[target]);
    if (capability.supported.includes(target)) {
      expect(call).not.toThrow();
      return;
    }
    let error: unknown;
    try {
      call();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LLMDriverError);
    const err = error as LLMDriverError;
    expect(err.code).toBe("unsupported_feature");
    expect(err.message).toContain(capability.feature);
    expect(err.message).toContain(target);
  });
});

describe("image and document gate", () => {
  const IMAGE: ContentBlock = { type: "image", source: { base64: "x", mediaType: "image/png" } };
  const DOCUMENT: ContentBlock = {
    type: "document",
    source: { base64: "x", mediaType: "application/pdf" },
  };
  const request = (block: ContentBlock): GenerateRequest => ({
    maxTokens: 32,
    messages: [user([block])],
  });

  it.each([
    ["image input", IMAGE],
    ["document input", DOCUMENT],
  ] as const)("does not throw for %s on either api target", (_feature, block) => {
    expect(() => assertSupported(request(block), CONFIGS["claude/api"])).not.toThrow();
    expect(() => assertSupported(request(block), CONFIGS["openai/api"])).not.toThrow();
  });

  it.each([
    ["image input", IMAGE, "claude/cli"],
    ["image input", IMAGE, "openai/cli"],
    ["document input", DOCUMENT, "claude/cli"],
    ["document input", DOCUMENT, "openai/cli"],
  ] as const)("throws unsupported_feature for %s on %s", (feature, block, target) => {
    const error = (() => {
      try {
        assertSupported(request(block), CONFIGS[target]);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(LLMDriverError);
    const err = error as LLMDriverError;
    expect(err.code).toBe("unsupported_feature");
    expect(err.message).toContain(feature);
    expect(err.message).toContain(target);
  });
});

describe("tools + toolChoice gate", () => {
  const TOOLS: GenerateRequest["tools"] = [
    { name: "add", description: "adds", inputSchema: { type: "object" }, execute: () => "3" },
  ];
  const toolsReq: GenerateRequest = { maxTokens: 8, messages: [user("hi")], tools: TOOLS };
  // toolChoice-only so the gate isolates that row (the tools row would fire first).
  const toolChoiceReq: GenerateRequest = {
    maxTokens: 8,
    messages: [user("hi")],
    toolChoice: "required",
  };

  it("does not throw at the gate on claude/api", () => {
    expect(() => assertSupported(toolsReq, CONFIGS["claude/api"])).not.toThrow();
    expect(() => assertSupported(toolChoiceReq, CONFIGS["claude/api"])).not.toThrow();
  });

  it.each([
    ["tools", toolsReq],
    ["toolChoice", toolChoiceReq],
  ] as const)(
    "throws unsupported_feature for %s on every non-claude/api target",
    (feature, req) => {
      for (const target of ["openai/api", "claude/cli", "openai/cli"] as const) {
        let error: unknown;
        try {
          assertSupported(req, CONFIGS[target]);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(LLMDriverError);
        expect((error as LLMDriverError).code).toBe("unsupported_feature");
        expect((error as LLMDriverError).message).toContain(feature);
        expect((error as LLMDriverError).message).toContain(target);
      }
    },
  );
});

describe("temperature on cli flavors", () => {
  it.each(["claude/cli", "openai/cli"] as const)(
    "generate() rejects before any spawn on %s",
    async (target) => {
      const { runner, calls } = neverRun();
      const client = cliClient(target, runner);

      const error = await client.generate(REQUEST).catch((caught) => caught);

      expect(error).toBeInstanceOf(LLMDriverError);
      expect((error as LLMDriverError).code).toBe("unsupported_feature");
      expect(calls).toHaveLength(0);
    },
  );

  it.each(["claude/cli", "openai/cli"] as const)(
    "generateStream() throws from the first next() on %s",
    async (target) => {
      const { runner, calls } = neverRun();
      const client = cliClient(target, runner);
      const iterator = client.generateStream(REQUEST)[Symbol.asyncIterator]();

      const error = await iterator.next().catch((caught) => caught);

      expect(error).toBeInstanceOf(LLMDriverError);
      expect((error as LLMDriverError).code).toBe("unsupported_feature");
      expect(calls).toHaveLength(0);
    },
  );
});

describe("outputSchema on cli flavors", () => {
  const schemaRequest: GenerateRequest = {
    maxTokens: 32,
    messages: [user("Hello")],
    outputSchema: { type: "object" },
  };

  it.each(["claude/cli", "openai/cli"] as const)(
    "generate() rejects unsupported_feature before any spawn on %s",
    async (target) => {
      const { runner, calls } = neverRun();
      const client = cliClient(target, runner);

      const error = await client.generate(schemaRequest).catch((caught) => caught);

      expect(error).toBeInstanceOf(LLMDriverError);
      const err = error as LLMDriverError;
      expect(err.code).toBe("unsupported_feature");
      expect(err.message).toContain("outputSchema");
      expect(err.message).toContain(target);
      expect(calls).toHaveLength(0);
    },
  );
});

/** Captures outgoing requests and replies with a canned payload. Never hits the network. */
function stubFetch(body: unknown) {
  const calls: Request[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push(new Request(input, init));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, impl };
}

describe("temperature passthrough on api flavors", () => {
  const anthropicBody = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "m",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const openaiBody = {
    id: "resp_1",
    model: "m",
    status: "completed",
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  it("claude/api sends temperature verbatim", async () => {
    const stub = stubFetch(anthropicBody);
    const config: Config = {
      provider: "claude",
      flavor: "api",
      model: "m",
      apiKey: "k",
      baseUrl: "https://anthropic.test",
      fetch: stub.impl,
    };
    await createClientWithBackend(config, createAnthropicApiBackend(config)).generate(REQUEST);

    expect(await (stub.calls[0] as Request).json()).toMatchObject({ temperature: 0.7 });
  });

  it("openai/api sends temperature verbatim", async () => {
    const stub = stubFetch(openaiBody);
    const config: Config = {
      provider: "openai",
      flavor: "api",
      model: "m",
      apiKey: "k",
      baseUrl: "https://openai.test",
      fetch: stub.impl,
    };
    await createClientWithBackend(config, createOpenAiApiBackend(config)).generate(REQUEST);

    expect(await (stub.calls[0] as Request).json()).toMatchObject({ temperature: 0.7 });
  });

  it("omits temperature when the request has none", async () => {
    const stub = stubFetch(anthropicBody);
    const config: Config = {
      provider: "claude",
      flavor: "api",
      model: "m",
      apiKey: "k",
      baseUrl: "https://anthropic.test",
      fetch: stub.impl,
    };
    await createClientWithBackend(config, createAnthropicApiBackend(config)).generate({
      maxTokens: 8,
      messages: [user("hi")],
    });

    expect(await (stub.calls[0] as Request).json()).not.toHaveProperty("temperature");
  });
});

describe("reasoning.effort validation", () => {
  const config: Config = { provider: "claude", flavor: "api", model: "m" };

  it.each(["extreme", "", undefined])(
    "rejects invalid effort %s with invalid_request",
    async (effort) => {
      const stub = stubFetch({});
      const withFetch: Config = { ...config, apiKey: "k", fetch: stub.impl };
      const client = createClientWithBackend(withFetch, createAnthropicApiBackend(withFetch));

      const error = await client
        .generate({
          maxTokens: 8,
          messages: [user("hi")],
          reasoning: { effort: effort as never },
        })
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(LLMDriverError);
      expect((error as LLMDriverError).code).toBe("invalid_request");
      expect(stub.calls).toHaveLength(0);
    },
  );

  it.each(["minimal", "low", "medium", "high"] as const)(
    "accepts the neutral level %s",
    async (effort) => {
      const stub = stubFetch({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "m",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      const withFetch: Config = { ...config, apiKey: "k", fetch: stub.impl };
      const client = createClientWithBackend(withFetch, createAnthropicApiBackend(withFetch));

      await client.generate({ maxTokens: 8, messages: [user("hi")], reasoning: { effort } });

      expect(await (stub.calls[0] as Request).json()).toMatchObject({
        output_config: { effort },
      });
    },
  );
});

describe("sampling param validation", () => {
  const config: Config = { provider: "claude", flavor: "api", model: "m" };

  /** Runs one request through the claude/api gate with fetch stubbed. */
  async function reject(request: GenerateRequest) {
    const stub = stubFetch({});
    const withFetch: Config = { ...config, apiKey: "k", fetch: stub.impl };
    const client = createClientWithBackend(withFetch, createAnthropicApiBackend(withFetch));
    const error = await client.generate(request).catch((caught) => caught);
    expect(error).toBeInstanceOf(LLMDriverError);
    expect((error as LLMDriverError).code).toBe("invalid_request");
    expect(stub.calls).toHaveLength(0);
  }

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite temperature %s",
    (value) => reject({ maxTokens: 8, messages: [user("hi")], temperature: value }),
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("rejects non-finite topP %s", (value) =>
    reject({ maxTokens: 8, messages: [user("hi")], topP: value }),
  );

  it.each([1.5, Number.NaN])("rejects non-integer topK %s", (value) =>
    reject({ maxTokens: 8, messages: [user("hi")], topK: value }),
  );

  it("rejects a non-array stopSequences", () =>
    reject({ maxTokens: 8, messages: [user("hi")], stopSequences: "STOP" as unknown as string[] }));

  it("rejects non-string entries in stopSequences", () =>
    reject({ maxTokens: 8, messages: [user("hi")], stopSequences: [1 as unknown as string] }));

  it("rejects a non-string metadata.userId", () =>
    reject({
      maxTokens: 8,
      messages: [user("hi")],
      metadata: { userId: 42 as unknown as string },
    }));
});
