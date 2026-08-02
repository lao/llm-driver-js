import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { validateConfig } from "../src/config.js";
import { LLMWrapperError } from "../src/errors.js";
import type { Config, Flavor, Provider } from "../src/types.js";

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
