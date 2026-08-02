/**
 * Opt-in smoke test against the real, locally authenticated agent CLIs.
 *
 * Skipped unless the model env var is set, so the default suite never spawns a
 * binary or bills an account:
 *
 *   LLMWRAPPER_CLAUDE_CLI_MODEL=claude-sonnet-4-6 npm test
 *   LLMWRAPPER_CODEX_CLI_MODEL=gpt-5.6-sol npm test
 */
import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import type { Provider } from "../src/types.js";
import { user } from "../src/types.js";

const TIMEOUT_MS = 180_000;

const targets: Array<{ provider: Provider; envVar: string }> = [
  { provider: "claude", envVar: "LLMWRAPPER_CLAUDE_CLI_MODEL" },
  { provider: "openai", envVar: "LLMWRAPPER_CODEX_CLI_MODEL" },
];

for (const { provider, envVar } of targets) {
  const model = process.env[envVar];

  describe.skipIf(!model)(`${provider} cli integration`, () => {
    it(
      "generates text through the real CLI",
      async () => {
        const client = createClient({ provider, flavor: "cli", model: model as string });

        const response = await client.generate({
          system: "Reply with a single word.",
          messages: [user("Reply with the word: pong")],
          maxTokens: 64,
        });

        expect(response.text.trim()).not.toBe("");
        expect(response.provider).toBe(provider);
        expect(response.flavor).toBe("cli");
        expect(response.model).toBe(model);
      },
      TIMEOUT_MS,
    );
  });
}
