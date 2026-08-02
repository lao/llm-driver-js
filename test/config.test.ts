import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { validateConfig } from "../src/config.js";
import { LLMWrapperError } from "../src/errors.js";
import { type Config, type Flavor, type Provider, user } from "../src/types.js";

function expectInvalidConfig(config: Config): LLMWrapperError {
  let caught: unknown;
  try {
    validateConfig(config);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LLMWrapperError);
  const error = caught as LLMWrapperError;
  expect(error.code).toBe("invalid_config");
  return error;
}

describe("validateConfig", () => {
  const providers: Provider[] = ["claude", "openai"];
  const flavors: Flavor[] = ["api", "cli"];

  for (const provider of providers) {
    for (const flavor of flavors) {
      it(`accepts ${provider}/${flavor}`, () => {
        expect(() => validateConfig({ provider, flavor, model: "test-model" })).not.toThrow();
        expect(() => createClient({ provider, flavor, model: "test-model" })).not.toThrow();
      });
    }
  }

  it("accepts flavor-appropriate options", () => {
    expect(() =>
      validateConfig({
        provider: "openai",
        flavor: "api",
        model: "m",
        apiKey: "k",
        baseUrl: "https://example.test/v1",
        fetch: globalThis.fetch,
      }),
    ).not.toThrow();
    expect(() =>
      validateConfig({
        provider: "claude",
        flavor: "cli",
        model: "m",
        cliPath: "/usr/local/bin/claude",
        cliArgs: ["--verbose"],
      }),
    ).not.toThrow();
  });

  it("rejects a missing or non-object config", () => {
    for (const config of [undefined, null, 42]) {
      const error = expectInvalidConfig(config as unknown as Config);
      expect(error.message).toBe("config is required");
    }
  });

  it("rejects an unknown provider", () => {
    expectInvalidConfig({ provider: "anthropic" as Provider, flavor: "api", model: "m" });
  });

  it("rejects an unknown flavor", () => {
    expectInvalidConfig({ provider: "claude", flavor: "sdk" as Flavor, model: "m" });
  });

  it("rejects a missing or blank model", () => {
    expectInvalidConfig({ provider: "claude", flavor: "api", model: "" });
    expectInvalidConfig({ provider: "claude", flavor: "api", model: "  " });
    expectInvalidConfig({
      provider: "claude",
      flavor: "api",
      model: undefined as unknown as string,
    });
  });

  it("rejects a non-absolute base URL for the api flavor", () => {
    expectInvalidConfig({ provider: "claude", flavor: "api", model: "m", baseUrl: "://bad" });
    expectInvalidConfig({ provider: "claude", flavor: "api", model: "m", baseUrl: "/v1" });
    expectInvalidConfig({ provider: "claude", flavor: "api", model: "m", baseUrl: "ftp://x/v1" });
  });

  it("rejects api-only options for the cli flavor", () => {
    expectInvalidConfig({ provider: "claude", flavor: "cli", model: "m", apiKey: "k" });
    expectInvalidConfig({
      provider: "claude",
      flavor: "cli",
      model: "m",
      baseUrl: "https://example.test",
    });
    expectInvalidConfig({
      provider: "openai",
      flavor: "cli",
      model: "m",
      fetch: globalThis.fetch,
    });
  });

  it("rejects cli-only options for the api flavor", () => {
    expectInvalidConfig({ provider: "openai", flavor: "api", model: "m", cliPath: "codex" });
    expectInvalidConfig({ provider: "openai", flavor: "api", model: "m", cliArgs: ["--json"] });
  });

  it("rejects cliArgs that is not an array of strings", () => {
    // A JS caller passing a bare string would otherwise be spread into argv
    // one character at a time.
    expectInvalidConfig({
      provider: "claude",
      flavor: "cli",
      model: "m",
      cliArgs: "--verbose" as unknown as string[],
    });
    expectInvalidConfig({
      provider: "claude",
      flavor: "cli",
      model: "m",
      cliArgs: [1, 2] as unknown as string[],
    });
    expectInvalidConfig({
      provider: "claude",
      flavor: "cli",
      model: "m",
      cliArgs: [null] as unknown as string[],
    });
  });

  it("rejects a blank cli path", () => {
    expectInvalidConfig({ provider: "claude", flavor: "cli", model: "m", cliPath: "  " });
  });

  it("stamps target context on config errors", () => {
    const error = expectInvalidConfig({ provider: "claude", flavor: "cli", model: "" });
    expect(error.provider).toBe("claude");
    expect(error.flavor).toBe("cli");
    expect(error.operation).toBe("createClient");
  });

  it("surfaces config errors from createClient", () => {
    expect(() => createClient({ provider: "claude", flavor: "api", model: "" })).toThrow(
      LLMWrapperError,
    );
  });
});

describe("createClient config snapshot", () => {
  it("ignores mutations made to the caller's config after construction", async () => {
    const sent: Record<string, unknown>[] = [];
    const config: Config = {
      provider: "claude",
      flavor: "api",
      model: "claude-test",
      apiKey: "test-key",
      baseUrl: "https://anthropic.test",
      fetch: async (input, init) => {
        sent.push((await new Request(input, init).json()) as Record<string, unknown>);
        return new Response(
          // An empty model makes the response fall back to the configured one.
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "",
            content: [],
            stop_reason: "end_turn",
            usage: {},
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    };
    const client = createClient(config);

    config.provider = "openai";
    config.flavor = "cli";
    config.model = "mutated-model";
    config.fetch = () => Promise.reject(new Error("mutated fetch must not be used"));

    const response = await client.generate({ messages: [user("hello")], maxTokens: 8 });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ model: "claude-test" });
    expect(response.model).toBe("claude-test");
    expect(response.provider).toBe("claude");
    expect(response.flavor).toBe("api");
  });
});
