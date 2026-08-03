import { describe, expect, it } from "vitest";
import { createClaudeCliBackend } from "../src/backends/claude-cli.js";
import type { CommandResult, CommandRunner, StreamingCommandRunner } from "../src/backends/cli.js";
import { createCodexCliBackend } from "../src/backends/codex-cli.js";
import { createClient, createClientWithBackend } from "../src/client.js";
import {
  assistant,
  type Config,
  type Flavor,
  type Request as GenerateRequest,
  type Response as GenerateResponse,
  type Provider,
  type StreamEvent,
  user,
} from "../src/types.js";

/** One neutral request, sent unchanged to every target. */
const PROMPT: GenerateRequest = {
  system: "Be concise.",
  maxTokens: 64,
  messages: [user("hello"), assistant("hi"), user("continue")],
};

/** Streamed in pieces by the targets that report deltas; joined everywhere else. */
const DELTAS = ["Hello, ", "world"];
const TEXT = DELTAS.join("");

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

/** Serves a canned SSE body; never touches the network. */
function stubSseFetch(chunks: string[]): typeof fetch {
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Emits canned stdout lines, then a clean exit; never spawns a process. */
function stubStreamRunner(lines: string[]): StreamingCommandRunner {
  return async function* () {
    for (const line of lines) yield { type: "line", line };
    yield { type: "exit", exitCode: 0, stderr: "" };
  };
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

const CLAUDE_API_STREAM = [
  sse("message_start", {
    type: "message_start",
    message: { ...CLAUDE_API_BODY, content: [], stop_reason: null, stop_sequence: null },
  }),
  ...DELTAS.map((text) =>
    sse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    }),
  ),
  sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 5 },
  }),
  sse("message_stop", { type: "message_stop" }),
];

const OPENAI_API_STREAM = [
  ...DELTAS.map((delta) =>
    sse("response.output_text.delta", {
      type: "response.output_text.delta",
      delta,
      item_id: "msg_123",
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
    }),
  ),
  sse("response.completed", { type: "response.completed", response: OPENAI_API_BODY }),
];

const CLAUDE_CLI_STREAM = [
  ...DELTAS.map((text) =>
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    }),
  ),
  CLAUDE_CLI_STDOUT,
];

const CLAUDE_CLI_CONFIG: Config = { provider: "claude", flavor: "cli", model: "claude-cli-test" };
const CODEX_CLI_CONFIG: Config = { provider: "openai", flavor: "cli", model: "codex-cli-test" };

interface Target {
  provider: Provider;
  flavor: Flavor;
  model: string;
  generate: (request: GenerateRequest) => Promise<GenerateResponse>;
  stream: (request: GenerateRequest) => AsyncIterable<StreamEvent>;
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
    stream: (request) =>
      createClient({
        provider: "claude",
        flavor: "api",
        model: "claude-api-test",
        apiKey: "test-key",
        baseUrl: "https://anthropic.test",
        fetch: stubSseFetch(CLAUDE_API_STREAM),
      }).generateStream(request),
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
    stream: (request) =>
      createClient({
        provider: "openai",
        flavor: "api",
        model: "gpt-api-test",
        apiKey: "test-key",
        baseUrl: "https://openai.test",
        fetch: stubSseFetch(OPENAI_API_STREAM),
      }).generateStream(request),
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
      createClaudeCliBackend(CLAUDE_CLI_CONFIG, stubRunner(CLAUDE_CLI_STDOUT)).generate(request),
    stream: (request) =>
      createClientWithBackend(
        CLAUDE_CLI_CONFIG,
        createClaudeCliBackend(
          CLAUDE_CLI_CONFIG,
          stubRunner(""),
          stubStreamRunner(CLAUDE_CLI_STREAM),
        ),
      ).generateStream(request),
    id: "session-1",
    completionReason: "",
    reasoningTokens: 0,
  },
  {
    provider: "openai",
    flavor: "cli",
    model: "codex-cli-test",
    generate: (request) =>
      createCodexCliBackend(CODEX_CLI_CONFIG, stubRunner(CODEX_CLI_STDOUT)).generate(request),
    // `codex exec --json` reports completed items only, so the whole turn
    // arrives as one coarse text event — allowed by the contract, which pins no
    // granularity — and `generateStream` just delegates to `generate`.
    stream: (request) =>
      createClientWithBackend(
        CODEX_CLI_CONFIG,
        createCodexCliBackend(CODEX_CLI_CONFIG, stubRunner(CODEX_CLI_STDOUT)),
      ).generateStream(request),
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

  for (const target of targets) {
    it(`${target.provider}/${target.flavor} streams deltas that add up to the done response`, async () => {
      const events: StreamEvent[] = [];
      for await (const event of target.stream(PROMPT)) events.push(event);

      const done = events.at(-1);
      expect(done?.type).toBe("done");
      // Exactly one done event, and nothing after it.
      expect(events.filter((event) => event.type === "done")).toHaveLength(1);
      if (done?.type !== "done") throw new Error("unreachable");

      const streamed = events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join("");
      expect(streamed).toBe(done.response.text);
      // The done response is the one generate() would have returned, stamped.
      expect(done.response).toEqual(await target.generate(PROMPT));
      expect(done.response.provider).toBe(target.provider);
      expect(done.response.flavor).toBe(target.flavor);
      expect(done.response.model).toBe(target.model);
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
