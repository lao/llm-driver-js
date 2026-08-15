import { describe, expect, it } from "vitest";
import { createClaudeCliBackend } from "../src/backends/claude-cli.js";
import type { CommandResult, CommandRunner, StreamingCommandRunner } from "../src/backends/cli.js";
import { createCodexCliBackend } from "../src/backends/codex-cli.js";
import { createClient, createClientWithBackend } from "../src/client.js";
import { LLMDriverError } from "../src/errors.js";
import {
  assistant,
  type Config,
  type Flavor,
  type Request as GenerateRequest,
  type Response as GenerateResponse,
  type Provider,
  type StreamEvent,
  type Tool,
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

/** Reasoning chunks, interleaved with text in each streaming fixture. */
const REASONING_DELTAS = ["Think", "ing"];
const REASONING_TEXT = REASONING_DELTAS.join("");

/** Replies with a canned payload; never touches the network. */
function stubFetch(body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

/** Serves canned JSON payloads in order, one per request; never touches the network. */
function sequencedFetch(bodies: unknown[]): typeof fetch {
  let call = 0;
  return async () => {
    const body = bodies[Math.min(call++, bodies.length - 1)];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
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

/** Serves one canned SSE body per request (one tool round each); never touches the network. */
function sequencedSseFetch(rounds: string[][]): typeof fetch {
  let call = 0;
  return async () => {
    const round = rounds[Math.min(call++, rounds.length - 1)] ?? [];
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of round) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
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
  ...REASONING_DELTAS.map(
    (text) =>
      `{"type":"item.completed","item":{"type":"reasoning","text":${JSON.stringify(text)}}}`,
  ),
  `{"type":"item.completed","item":{"type":"agent_message","text":${JSON.stringify(TEXT)}}}`,
  '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5,' +
    '"cached_input_tokens":3,"cache_write_input_tokens":2,"reasoning_output_tokens":1}}',
  "",
].join("\n");

/** Pairs each reasoning chunk with the text chunk that follows it, in source order. */
function interleave<T>(reasoning: (chunk: string) => T, text: (chunk: string) => T): T[] {
  return REASONING_DELTAS.flatMap((chunk, i) => [reasoning(chunk), text(DELTAS[i] as string)]);
}

const CLAUDE_API_STREAM = [
  sse("message_start", {
    type: "message_start",
    message: { ...CLAUDE_API_BODY, content: [], stop_reason: null, stop_sequence: null },
  }),
  ...interleave(
    (thinking) =>
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking },
      }),
    (text) =>
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
  ...interleave(
    (delta) =>
      sse("response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta",
        delta,
        item_id: "rs_123",
        output_index: 0,
        summary_index: 0,
        sequence_number: 1,
      }),
    (delta) =>
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
  ...interleave(
    (thinking) =>
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking },
        },
      }),
    (text) =>
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      }),
  ),
  CLAUDE_CLI_STDOUT,
];

const CLAUDE_CLI_CONFIG: Config = { provider: "claude", flavor: "cli", model: "claude-cli-test" };
const CODEX_CLI_CONFIG: Config = { provider: "openai", flavor: "cli", model: "codex-cli-test" };

const claudeCliClient = () =>
  createClientWithBackend(
    CLAUDE_CLI_CONFIG,
    createClaudeCliBackend(
      CLAUDE_CLI_CONFIG,
      stubRunner(CLAUDE_CLI_STDOUT),
      stubStreamRunner(CLAUDE_CLI_STREAM),
    ),
  );
const codexCliClient = () =>
  createClientWithBackend(
    CODEX_CLI_CONFIG,
    createCodexCliBackend(CODEX_CLI_CONFIG, stubRunner(CODEX_CLI_STDOUT)),
  );

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
    // The runner seam is internal, so CLI targets use createClientWithBackend —
    // one client per target so generate and stream share the same stamping path.
    generate: (request) => claudeCliClient().generate(request),
    stream: (request) => claudeCliClient().generateStream(request),
    id: "session-1",
    completionReason: "",
    reasoningTokens: 0,
  },
  {
    provider: "openai",
    flavor: "cli",
    model: "codex-cli-test",
    generate: (request) => codexCliClient().generate(request),
    // `codex exec --json` reports completed items only, so the whole turn
    // arrives as one coarse text event — allowed by the contract, which pins no
    // granularity — and `generateStream` just delegates to `generate`.
    stream: (request) => codexCliClient().generateStream(request),
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
        toolCalls: [],
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

  for (const target of targets) {
    it(`${target.provider}/${target.flavor} streams reasoning without polluting the text`, async () => {
      const events: StreamEvent[] = [];
      for await (const event of target.stream(PROMPT)) events.push(event);

      const reasoning = events
        .filter((event) => event.type === "reasoning")
        .map((event) => event.text)
        .join("");
      const text = events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join("");
      const done = events.at(-1);
      if (done?.type !== "done") throw new Error("unreachable");

      // Reasoning is surfaced in source order and never folds into the text.
      expect(reasoning).toBe(REASONING_TEXT);
      expect(text).toBe(done.response.text);
      expect(done.response.text).not.toContain(REASONING_TEXT);
    });
  }

  it("accepts a neutral reasoning request on every target with the same shape", async () => {
    // reasoning.effort is ✅ on all four targets, so one request runs unmodified
    // everywhere and normalizes to the identical shape (matrix single source).
    const reasoningPrompt: GenerateRequest = { ...PROMPT, reasoning: { effort: "medium" } };
    const responses = await Promise.all(targets.map((target) => target.generate(reasoningPrompt)));

    const shapes = responses.map((response) => ({
      keys: Object.keys(response).sort(),
      usageKeys: Object.keys(response.usage).sort(),
    }));
    for (const shape of shapes) {
      expect(shape).toEqual(shapes[0]);
    }
  });

  // Images are honored on the API targets only in this task; CLI cells flip
  // later (T8/T9). One neutral image fixture proves both halves of the matrix.
  const IMAGE_PROMPT: GenerateRequest = {
    maxTokens: 64,
    messages: [
      user([
        { type: "text", text: "describe" },
        { type: "image", source: { base64: "aGVsbG8=", mediaType: "image/png" } },
      ]),
    ],
  };

  for (const target of targets.filter((t) => t.flavor === "api")) {
    it(`${target.provider}/${target.flavor} accepts an image request`, async () => {
      const response = await target.generate(IMAGE_PROMPT);
      expect(response.text).toBe(TEXT);
      expect(response.provider).toBe(target.provider);
      expect(response.flavor).toBe(target.flavor);
    });
  }

  for (const target of targets.filter((t) => t.flavor === "cli")) {
    it(`${target.provider}/${target.flavor} rejects an image request as unsupported`, async () => {
      const error = await target.generate(IMAGE_PROMPT).catch((caught) => caught);
      expect(error).toBeInstanceOf(LLMDriverError);
      expect((error as LLMDriverError).code).toBe("unsupported_feature");
    });
  }

  it("runs the tool loop to the same toolCalls and text on both api targets", async () => {
    // One neutral tool request, sent to both api flavors. Provider wire shapes
    // differ (Messages tool_use vs Responses function_call) but the normalized
    // toolCalls records and final text must be identical. Shared call id + input
    // make the records comparable across providers.
    const request: GenerateRequest = {
      maxTokens: 64,
      messages: [user("look it up")],
      tools: [
        {
          name: "lookup",
          description: "looks up a value",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          execute: () => "42",
        } satisfies Tool,
      ],
    };

    const claude = createClient({
      provider: "claude",
      flavor: "api",
      model: "claude-api-test",
      apiKey: "test-key",
      baseUrl: "https://anthropic.test",
      fetch: sequencedFetch([
        {
          id: "msg_tool",
          type: "message",
          role: "assistant",
          model: "claude-api-test",
          content: [{ type: "tool_use", id: "tc_1", name: "lookup", input: { q: "x" } }],
          stop_reason: "tool_use",
          usage: CLAUDE_API_BODY.usage,
        },
        { ...CLAUDE_API_BODY, content: [{ type: "text", text: "the value is 42" }] },
      ]),
    });

    const openai = createClient({
      provider: "openai",
      flavor: "api",
      model: "gpt-api-test",
      apiKey: "test-key",
      baseUrl: "https://openai.test",
      fetch: sequencedFetch([
        {
          id: "resp_tool",
          object: "response",
          status: "completed",
          model: "gpt-api-test",
          output: [
            {
              type: "function_call",
              status: "completed",
              call_id: "tc_1",
              name: "lookup",
              arguments: JSON.stringify({ q: "x" }),
            },
          ],
          usage: OPENAI_API_BODY.usage,
        },
        {
          ...OPENAI_API_BODY,
          output: [
            {
              id: "msg_1",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "the value is 42", annotations: [] }],
            },
          ],
        },
      ]),
    });

    const [claudeResponse, openaiResponse] = await Promise.all([
      claude.generate(request),
      openai.generate(request),
    ]);

    const expectedToolCalls = [
      {
        id: "tc_1",
        name: "lookup",
        input: { q: "x" },
        output: { text: "42", isError: false },
        isError: false,
      },
    ];
    expect(claudeResponse.toolCalls).toEqual(expectedToolCalls);
    expect(openaiResponse.toolCalls).toEqual(expectedToolCalls);
    expect(claudeResponse.toolCalls).toEqual(openaiResponse.toolCalls);
    expect(claudeResponse.text).toBe("the value is 42");
    expect(openaiResponse.text).toBe("the value is 42");
  });

  it("streams the same tool event ordering on both api targets", async () => {
    // One neutral tool request, streamed through both api flavors. Provider SSE
    // shapes differ, but the normalized event sequence, ids, and final text must
    // match: text → tool_call → tool_result → text → done, done last exactly once.
    const request: GenerateRequest = {
      maxTokens: 64,
      messages: [user("look it up")],
      tools: [
        {
          name: "lookup",
          description: "looks up a value",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          execute: () => "42",
        } satisfies Tool,
      ],
    };

    const claudeStart = {
      type: "message_start",
      message: { ...CLAUDE_API_BODY, content: [], stop_reason: null, stop_sequence: null },
    };
    const claude = createClient({
      provider: "claude",
      flavor: "api",
      model: "claude-api-test",
      apiKey: "test-key",
      baseUrl: "https://anthropic.test",
      fetch: sequencedSseFetch([
        [
          sse("message_start", claudeStart),
          sse("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tc_1", name: "lookup", input: {} },
          }),
          sse("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify({ q: "x" }) },
          }),
          sse("content_block_stop", { type: "content_block_stop", index: 0 }),
          sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 5 },
          }),
          sse("message_stop", { type: "message_stop" }),
        ],
        [
          sse("message_start", claudeStart),
          sse("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
          sse("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "the value is 42" },
          }),
          sse("content_block_stop", { type: "content_block_stop", index: 0 }),
          sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 5 },
          }),
          sse("message_stop", { type: "message_stop" }),
        ],
      ]),
    });

    const openai = createClient({
      provider: "openai",
      flavor: "api",
      model: "gpt-api-test",
      apiKey: "test-key",
      baseUrl: "https://openai.test",
      fetch: sequencedSseFetch([
        [
          sse("response.completed", {
            type: "response.completed",
            response: {
              id: "resp_tool",
              object: "response",
              status: "completed",
              model: "gpt-api-test",
              output: [
                {
                  type: "function_call",
                  status: "completed",
                  call_id: "tc_1",
                  name: "lookup",
                  arguments: JSON.stringify({ q: "x" }),
                },
              ],
              usage: OPENAI_API_BODY.usage,
            },
          }),
        ],
        [
          sse("response.output_text.delta", {
            type: "response.output_text.delta",
            delta: "the value is 42",
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            sequence_number: 1,
          }),
          sse("response.completed", {
            type: "response.completed",
            response: {
              ...OPENAI_API_BODY,
              output: [
                {
                  id: "msg_1",
                  type: "message",
                  status: "completed",
                  role: "assistant",
                  content: [{ type: "output_text", text: "the value is 42", annotations: [] }],
                },
              ],
            },
          }),
        ],
      ]),
    });

    const drain = async (stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
      const events: StreamEvent[] = [];
      for await (const event of stream) events.push(event);
      return events;
    };
    const [claudeEvents, openaiEvents] = await Promise.all([
      drain(claude.generateStream(request)),
      drain(openai.generateStream(request)),
    ]);

    for (const events of [claudeEvents, openaiEvents]) {
      // A tool_call always precedes its matching tool_result (same id).
      const callAt = events.findIndex((e) => e.type === "tool_call");
      const resultAt = events.findIndex((e) => e.type === "tool_result");
      expect(callAt).toBeGreaterThanOrEqual(0);
      expect(callAt).toBeLessThan(resultAt);
      const call = events[callAt];
      const result = events[resultAt];
      if (call?.type !== "tool_call" || result?.type !== "tool_result")
        throw new Error("unreachable");
      expect(call.id).toBe(result.id);

      const done = events.at(-1);
      if (done?.type !== "done") throw new Error("expected a done event last");
      expect(events.filter((e) => e.type === "done")).toHaveLength(1);
      expect(done.response.text).toBe("the value is 42");
      expect(done.response.toolCalls).toEqual([
        {
          id: "tc_1",
          name: "lookup",
          input: { q: "x" },
          output: { text: "42", isError: false },
          isError: false,
        },
      ]);
    }

    // Normalized event-type sequences are identical across providers.
    expect(claudeEvents.map((e) => e.type)).toEqual(openaiEvents.map((e) => e.type));
  });

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

  it("stamps toolCalls on every target", async () => {
    for (const target of targets) {
      const response = await target.generate(PROMPT);
      expect(response.toolCalls).toEqual([]);
    }
  });
});

/** A schema and a matching JSON payload the structured targets echo back. */
const SCHEMA = { type: "object", properties: { answer: { type: "number" } } };
const STRUCTURED = { answer: 42 };
const STRUCTURED_TEXT = JSON.stringify(STRUCTURED);

/** Structured output is api-only in T5; both api targets parse the final text. */
const structuredTargets: {
  provider: Provider;
  generate: (request: GenerateRequest) => Promise<GenerateResponse>;
}[] = [
  {
    provider: "claude",
    generate: (request) =>
      createClient({
        provider: "claude",
        flavor: "api",
        model: "claude-api-test",
        apiKey: "test-key",
        baseUrl: "https://anthropic.test",
        fetch: stubFetch({
          ...CLAUDE_API_BODY,
          content: [{ type: "text", text: STRUCTURED_TEXT }],
        }),
      }).generate(request),
  },
  {
    provider: "openai",
    generate: (request) =>
      createClient({
        provider: "openai",
        flavor: "api",
        model: "gpt-api-test",
        apiKey: "test-key",
        baseUrl: "https://openai.test",
        fetch: stubFetch({
          ...OPENAI_API_BODY,
          output: [
            {
              id: "msg_123",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: STRUCTURED_TEXT, annotations: [] }],
            },
          ],
        }),
      }).generate(request),
  },
];

describe("structured output across api targets", () => {
  for (const target of structuredTargets) {
    it(`${target.provider}/api parses the final text into structured`, async () => {
      const response = await target.generate({ ...PROMPT, outputSchema: SCHEMA });

      expect(response.structured).toEqual(STRUCTURED);
      expect(response.text).toBe(STRUCTURED_TEXT);
      expect(response.toolCalls).toEqual([]);
    });
  }
});
