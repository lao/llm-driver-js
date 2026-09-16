import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LLMDriverError } from "../src/errors.js";
import { listOpencodeModels, parseOpencodeModels } from "../src/models.js";

describe("parseOpencodeModels", () => {
  it("keeps provider/model lines and drops noise", () => {
    const stdout = `opencode/big-pickle

  anthropic/claude-sonnet-4-5  
openrouter/anthropic/claude-sonnet-4.5#high
opencode-go/deepseek-v4.1-flash
Error: Provider not found
not-a-model
provider/model with space
`;

    expect(parseOpencodeModels(stdout)).toEqual([
      "opencode/big-pickle",
      "anthropic/claude-sonnet-4-5",
      "openrouter/anthropic/claude-sonnet-4.5#high",
      "opencode-go/deepseek-v4.1-flash",
    ]);
  });

  it("returns empty for empty or error-only output", () => {
    expect(parseOpencodeModels("")).toEqual([]);
    expect(parseOpencodeModels("Error: Provider not found\n")).toEqual([]);
    expect(parseOpencodeModels("/\nfoo/\n/bar\n")).toEqual([]);
  });

  it("drops option-injection attempts", () => {
    expect(parseOpencodeModels("--evil/model\n-/x\n")).toEqual([]);
  });

  it("strips terminal colors and drops remaining control bytes", () => {
    expect(
      parseOpencodeModels("\u001b[32mprovider/model\u001b[0m\nprovider/mo\u0000del\n"),
    ).toEqual(["provider/model"]);
  });

  it("drops ids with an empty slash-delimited segment", () => {
    expect(parseOpencodeModels("provider//model\nfoo/\n/bar\n//\na//b/c\n")).toEqual([]);
  });

  it("keeps a nested id while dropping malformed siblings", () => {
    expect(
      parseOpencodeModels("provider//model\nopenrouter/anthropic/claude-sonnet-4.5\nfoo/\n"),
    ).toEqual(["openrouter/anthropic/claude-sonnet-4.5"]);
  });
});

describe("listOpencodeModels option validation", () => {
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
    it(`rejects a non-positive, non-finite, or fractional timeoutMs (${timeoutMs})`, async () => {
      const caught = await listOpencodeModels({
        cliPath: "/nonexistent/llmwrapper-opencode",
        timeoutMs,
      }).catch((e) => e);

      expect(caught).toBeInstanceOf(LLMDriverError);
      expect((caught as LLMDriverError).code).toBe("invalid_config");
      expect((caught as LLMDriverError).provider).toBe("opencode");
      expect((caught as LLMDriverError).operation).toBe("listOpencodeModels");
    });
  }
});

/**
 * Real `node` processes, but no opencode: `listOpencodeModels` runs a fake
 * executable on disk, so a swapped command shows up as the wrong output.
 */
const dir = mkdtempSync(join(tmpdir(), "llmwrapper-models-"));

function fakeCli(name: string, body: string): string {
  const path = join(dir, `${name}.cjs`);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe.skipIf(process.platform === "win32")("listOpencodeModels", () => {
  it("runs `opencode models` and parses its stdout", async () => {
    const cliPath = fakeCli(
      "models-ok",
      'process.stdout.write("opencode/big-pickle\\nanthropic/claude-sonnet-4-5\\n");',
    );

    const models = await listOpencodeModels({ cliPath });

    expect(models).toEqual(["opencode/big-pickle", "anthropic/claude-sonnet-4-5"]);
  });

  it("runs the `models` subcommand with no argv override", async () => {
    const cliPath = fakeCli(
      "models-argv",
      'if (process.argv.slice(2).join(" ") !== "models") {\n  process.stderr.write("wrong argv\\n");\n  process.exit(2);\n}\nprocess.stdout.write("opencode/big-pickle\\n");',
    );

    const models = await listOpencodeModels({ cliPath });

    expect(models).toEqual(["opencode/big-pickle"]);
  });

  it("accepts a positive timeoutMs override", async () => {
    const cliPath = fakeCli("models-timeout", 'process.stdout.write("opencode/big-pickle\\n");');

    const models = await listOpencodeModels({ cliPath, timeoutMs: 5000 });

    expect(models).toEqual(["opencode/big-pickle"]);
  });

  it("propagates a missing executable as executable_not_found", async () => {
    const caught = await listOpencodeModels({
      cliPath: "/nonexistent/llmwrapper-opencode",
    }).catch((e) => e);

    expect(caught).toBeInstanceOf(LLMDriverError);
    expect((caught as LLMDriverError).code).toBe("executable_not_found");
    expect((caught as LLMDriverError).provider).toBe("opencode");
  });

  it("propagates a non-zero exit as process_failed", async () => {
    const cliPath = fakeCli(
      "models-fail",
      'process.stderr.write("not authenticated\\n"); process.exit(3);',
    );

    const caught = await listOpencodeModels({ cliPath }).catch((e) => e);

    expect(caught).toBeInstanceOf(LLMDriverError);
    expect((caught as LLMDriverError).code).toBe("process_failed");
    expect((caught as LLMDriverError).status).toBe(3);
    // Not a generation: the shared CLI normalization is re-stamped.
    expect((caught as LLMDriverError).operation).toBe("listOpencodeModels");
  });
});
