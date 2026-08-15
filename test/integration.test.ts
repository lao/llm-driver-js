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
import type { Provider, StreamEvent } from "../src/types.js";
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

    it(
      "accepts a reasoning.effort request through the real CLI",
      async () => {
        // Proves the real binary accepts the mapped flag (claude `--effort`,
        // codex `-c model_reasoning_effort=`) — the truth fixtures cannot show.
        const client = createClient({ provider, flavor: "cli", model: model as string });

        const response = await client.generate({
          system: "Reply with a single word.",
          messages: [user("Reply with the word: pong")],
          maxTokens: 64,
          reasoning: { effort: "low" },
        });

        expect(response.text.trim()).not.toBe("");
        expect(response.provider).toBe(provider);
      },
      TIMEOUT_MS,
    );

    it(
      "streams text through the real CLI",
      async () => {
        const client = createClient({ provider, flavor: "cli", model: model as string });

        const events: StreamEvent[] = [];
        for await (const event of client.generateStream({
          system: "Reply with a single word.",
          messages: [user("Reply with the word: pong")],
          maxTokens: 64,
        })) {
          events.push(event);
        }

        const done = events.at(-1);
        expect(done?.type).toBe("done");
        if (done?.type !== "done") throw new Error("unreachable");
        expect(events.filter((event) => event.type === "done")).toHaveLength(1);
        expect(done.response.text.trim()).not.toBe("");
        expect(done.response.provider).toBe(provider);
        expect(done.response.model).toBe(model);
        // Granularity is target-dependent; only the sum is contractual — and
        // only for the three targets that hold it unconditionally. `claude`/`cli`
        // is an agent whose deltas are a superset once the turn runs tools, so
        // it keeps the invariants above and is characterized separately below.
        if (provider !== "claude") {
          expect(
            events
              .filter((event) => event.type === "text")
              .map((event) => event.text)
              .join(""),
          ).toBe(done.response.text);
        }
      },
      TIMEOUT_MS,
    );
  });
}

/**
 * Real `claude -p` running a client tool through the MCP bridge: the CLI drives
 * its own loop, calls our in-process handler over loopback HTTP, and the record
 * lands in `response.toolCalls`.
 */
describe.skipIf(!process.env.LLMWRAPPER_CLAUDE_CLI_MODEL)("claude cli tools via bridge", () => {
  it(
    "calls a trivial in-process tool and records the call",
    async () => {
      const model = process.env.LLMWRAPPER_CLAUDE_CLI_MODEL as string;
      const client = createClient({ provider: "claude", flavor: "cli", model });

      let called = false;
      const response = await client.generate({
        messages: [
          user(
            "Call the secret_number tool with no arguments and reply with exactly the number it returns.",
          ),
        ],
        maxTokens: 512,
        tools: [
          {
            name: "secret_number",
            description: "Returns the secret number. Call it to learn the secret.",
            inputSchema: { type: "object", properties: {} },
            execute: () => {
              called = true;
              return "1729";
            },
          },
        ],
      });

      expect(called).toBe(true);
      expect(response.toolCalls.map((call) => call.name)).toContain("secret_number");
      expect(response.text).toContain("1729");
    },
    TIMEOUT_MS,
  );
});

/**
 * Real `codex exec` running a client tool through the MCP bridge. Also the sole
 * confirmation of the `-c mcp_servers.llmdriver.url=` streamable-HTTP key syntax
 * (SPEC-v2 open question 4) against the real codex 0.147 binary: if codex ignores
 * the override or needs stdio-only MCP, this test fails and the argv needs a fix.
 */
describe.skipIf(!process.env.LLMWRAPPER_CODEX_CLI_MODEL)("codex cli tools via bridge", () => {
  it(
    "calls a trivial in-process tool and records the call",
    async () => {
      const model = process.env.LLMWRAPPER_CODEX_CLI_MODEL as string;
      const client = createClient({ provider: "openai", flavor: "cli", model });

      let called = false;
      const response = await client.generate({
        messages: [
          user(
            "Call the secret_number tool with no arguments and reply with exactly the number it returns.",
          ),
        ],
        maxTokens: 512,
        tools: [
          {
            name: "secret_number",
            description: "Returns the secret number. Call it to learn the secret.",
            inputSchema: { type: "object", properties: {} },
            execute: () => {
              called = true;
              return "1729";
            },
          },
        ],
      });

      expect(called).toBe(true);
      expect(response.toolCalls.map((call) => call.name)).toContain("secret_number");
      expect(response.text).toContain("1729");
    },
    TIMEOUT_MS,
  );
});

/**
 * The truth the fixtures cannot prove: that `--json-schema` (claude) and
 * `--output-schema` (codex) really make the CLI emit JSON we can parse into
 * `structured`. Env-gated, skipped by default; run before checkpoint sign-off.
 */
for (const { provider, envVar } of targets) {
  const model = process.env[envVar];

  describe.skipIf(!model)(`${provider} cli structured output`, () => {
    it(
      "returns parseable structured output for a schema",
      async () => {
        const client = createClient({ provider, flavor: "cli", model: model as string });

        const response = await client.generate({
          system: "Reply only with JSON that satisfies the schema.",
          messages: [user("The answer to life, the universe, and everything is 42.")],
          maxTokens: 256,
          outputSchema: {
            type: "object",
            properties: { answer: { type: "number" } },
            required: ["answer"],
            additionalProperties: false,
          },
        });

        // Parse succeeded (the adapter throws parse_failed otherwise), and the
        // schema shape came back.
        expect(response.structured).toBeTypeOf("object");
        expect(response.structured).not.toBeNull();
        expect(JSON.parse(response.text)).toEqual(response.structured);
      },
      TIMEOUT_MS,
    );
  });
}

/**
 * Characterization, not a contract assertion: `claude -p` is an agent, so a turn
 * that runs tools streams deltas for every assistant message while
 * `done.response` comes from the final `result` event alone. The concatenation
 * is then a superset of `done.response.text`. Recorded here so a change in the
 * CLI's own behaviour is visible; see the caveat in SPEC.md and README.
 */
describe.skipIf(!process.env.LLMWRAPPER_CLAUDE_CLI_MODEL)("claude cli agentic streaming", () => {
  it(
    "characterizes a tool-running turn",
    async ({ annotate }) => {
      const model = process.env.LLMWRAPPER_CLAUDE_CLI_MODEL as string;
      const client = createClient({ provider: "claude", flavor: "cli", model });

      const events: StreamEvent[] = [];
      for await (const event of client.generateStream({
        // Unanswerable without running a read-only tool, so the turn goes agentic.
        messages: [
          user("Use your file tools to count the files in this directory. Reply with the number."),
        ],
        maxTokens: 512,
      })) {
        events.push(event);
      }

      const done = events.at(-1);
      expect(done?.type).toBe("done");
      if (done?.type !== "done") throw new Error("unreachable");
      expect(events.filter((event) => event.type === "done")).toHaveLength(1);
      expect(done.response.text.trim()).not.toBe("");

      const streamed = events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join("");
      // Deliberately never asserted: equality holds only for a single-message turn.
      await annotate(
        streamed === done.response.text
          ? "single-message turn: concatenated deltas === done.response.text"
          : `agentic turn: ${streamed.length} delta chars vs ${done.response.text.length} final chars — the deltas also carry intermediate assistant messages`,
      );
    },
    TIMEOUT_MS,
  );
});
