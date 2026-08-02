import { describe, expect, it } from "vitest";
import { createClaudeCliBackend } from "../src/backends/claude-cli.js";
import type { CommandResult, CommandRunner } from "../src/backends/cli.js";
import { createCodexCliBackend } from "../src/backends/codex-cli.js";
import { createClient } from "../src/client.js";
import {
  assistant,
  type Flavor,
  type Request as GenerateRequest,
  type Response as GenerateResponse,
  type Provider,
  user,
} from "../src/types.js";

/** One neutral request, sent unchanged to every target. */
const PROMPT: GenerateRequest = {
  system: "Be concise.",
  maxTokens: 64,
  messages: [user("hello"), assistant("hi"), user("continue")],
};

const TEXT = "Hello, world";

/** Replies with a canned payload; never touches the network. */
function stubFetch(body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

/** Replies with canned process output; never spawns a process. */
function stubRunner(stdout: string): CommandRunner {
  return async (): Promise<CommandResult> => ({ stdout, stderr: "", exitCode: 0 });
}

const CLAUDE_API_BODY = {
  id: "msg_123",
  type: "message",
  role: "assistant",
  model: "claude-api-test",
  content: [{ type: "text", text: TEXT }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
  },
};

const OPENAI_API_BODY = {
  id: "resp_123",
  object: "response",
  status: "completed",
  model: "gpt-api-test",
  output: [
    {
      id: "msg_123",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: TEXT, annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 1 },
  },
};

const CLAUDE_CLI_STDOUT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: TEXT,
  session_id: "session-1",
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
  },
});

const CODEX_CLI_STDOUT = [
  '{"type":"thread.started","thread_id":"thread-1"}',
  `{"type":"item.completed","item":{"type":"agent_message","text":${JSON.stringify(TEXT)}}}`,
  '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5,' +
    '"cached_input_tokens":3,"cache_write_input_tokens":2,"reasoning_output_tokens":1}}',
  "",
].join("\n");

interface Target {
  provider: Provider;
  flavor: Flavor;
  model: string;
  generate: (request: GenerateRequest) => Promise<GenerateResponse>;
  /** Fields the target legitimately reports differently. */
  id: string;
  completionReason: GenerateResponse["completionReason"];
  reasoningTokens: number;
}

const targets: Target[] = [
  {
    provider: "claude",
    flavor: "api",
    model: "claude-api-test",
    generate: (request) =>
      createClient({
        provider: "claude",
        flavor: "api",
        model: "claude-api-test",
        apiKey: "test-key",
        baseUrl: "https://anthropic.test",
        fetch: stubFetch(CLAUDE_API_BODY),
      }).generate(request),
    id: "msg_123",
    completionReason: "stop",
    reasoningTokens: 0,
  },
  {
    provider: "openai",
    flavor: "api",
    model: "gpt-api-test",
    generate: (request) =>
      createClient({
        provider: "openai",
        flavor: "api",
        model: "gpt-api-test",
        apiKey: "test-key",
        baseUrl: "https://openai.test",
        fetch: stubFetch(OPENAI_API_BODY),
      }).generate(request),
    id: "resp_123",
    completionReason: "stop",
    reasoningTokens: 1,
  },
  {
    provider: "claude",
    flavor: "cli",
    model: "claude-cli-test",
    // The runner seam is internal, so CLI targets go through the backend directly.
    generate: (request) =>
      createClaudeCliBackend(
        { provider: "claude", flavor: "cli", model: "claude-cli-test" },
        stubRunner(CLAUDE_CLI_STDOUT),
      ).generate(request),
    id: "session-1",
    completionReason: "",
    reasoningTokens: 0,
  },
  {
    provider: "openai",
    flavor: "cli",
    model: "codex-cli-test",
    generate: (request) =>
      createCodexCliBackend(
        { provider: "openai", flavor: "cli", model: "codex-cli-test" },
        stubRunner(CODEX_CLI_STDOUT),
      ).generate(request),
    id: "thread-1",
    completionReason: "",
    reasoningTokens: 1,
  },
];

describe("contract across all four targets", () => {
  for (const target of targets) {
    it(`${target.provider}/${target.flavor} returns the normalized response`, async () => {
      const response = await target.generate(PROMPT);

      expect(response).toEqual({
        id: target.id,
        model: target.model,
        text: TEXT,
        completionReason: target.completionReason,
        provider: target.provider,
        flavor: target.flavor,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 3,
          cacheCreationInputTokens: 2,
          reasoningTokens: target.reasoningTokens,
        },
      });
    });
  }

  it("returns the same field set from every target", async () => {
    const responses = await Promise.all(targets.map((target) => target.generate(PROMPT)));
    const shapes = responses.map((response) => ({
      keys: Object.keys(response).sort(),
      usageKeys: Object.keys(response.usage).sort(),
    }));

    for (const shape of shapes) {
      expect(shape).toEqual(shapes[0]);
    }
  });
});
