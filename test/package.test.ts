import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  Client,
  CompletionReason,
  Config,
  ErrorCode,
  Flavor,
  LLMWrapperErrorOptions,
  Message,
  Provider,
  Request,
  Response,
  Role,
  Usage,
} from "../src/index.js";
import * as barrel from "../src/index.js";

/** The public surface SPEC.md promises; anything else is an internal leak. */
const RUNTIME_EXPORTS = ["LLMWrapperError", "assistant", "createClient", "user"];

// Compile-time proof that every documented type is exported from the barrel;
// `tsc --noEmit` fails if one goes missing.
type _Types = [
  Client,
  CompletionReason,
  Config,
  ErrorCode,
  Flavor,
  LLMWrapperErrorOptions,
  Message,
  Provider,
  Request,
  Response,
  Role,
  Usage,
];

describe("src/index.ts barrel", () => {
  it("exports exactly the documented runtime surface", () => {
    expect(Object.keys(barrel).sort()).toEqual(RUNTIME_EXPORTS);
  });

  it("exports working helpers and the error class", () => {
    expect(typeof barrel.createClient).toBe("function");
    expect(barrel.user("hi")).toEqual({ role: "user", text: "hi" });
    expect(barrel.assistant("yo")).toEqual({ role: "assistant", text: "yo" });
    expect(new barrel.LLMWrapperError("invalid_config", "nope").code).toBe("invalid_config");
  });
});

const dist = join(import.meta.dirname, "..", "dist");
const built = existsSync(join(dist, "index.cjs")) && existsSync(join(dist, "index.js"));

// Skips before `npm run build`; `npm pack`/`prepublishOnly` always build first.
describe.skipIf(!built)("built package", () => {
  it("exposes the same surface from the CommonJS build", () => {
    const required = createRequire(import.meta.url)(join(dist, "index.cjs"));
    expect(Object.keys(required).sort()).toEqual(RUNTIME_EXPORTS);
    expect(required.user("hi")).toEqual({ role: "user", text: "hi" });
  });

  it("exposes the same surface from the ESM build", async () => {
    const imported = await import(join(dist, "index.js"));
    expect(Object.keys(imported).sort()).toEqual(RUNTIME_EXPORTS);
    expect(imported.assistant("yo")).toEqual({ role: "assistant", text: "yo" });
  });
});

describe("validation runs before any transport", () => {
  const badRequest = { messages: [], maxTokens: 0 } as unknown as Request;

  it("rejects an invalid api request without calling the injected fetch", async () => {
    let called = false;
    const client = barrel.createClient({
      provider: "claude",
      flavor: "api",
      model: "claude-test",
      apiKey: "test-key",
      baseUrl: "https://anthropic.test",
      fetch: async () => {
        called = true;
        return new Response("{}");
      },
    });

    await expect(client.generate(badRequest)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(called).toBe(false);
  });

  it("rejects an invalid cli request without spawning anything", async () => {
    const client = barrel.createClient({
      provider: "openai",
      flavor: "cli",
      model: "codex-test",
      // A path that would fail loudly with executable_not_found if reached.
      cliPath: "/nonexistent/llmwrapper-never-spawned",
    });

    await expect(client.generate(badRequest)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});
