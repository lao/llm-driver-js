import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { LLMDriverError } from "../src/errors.js";
import {
  type Request as GenerateRequest,
  type StreamEvent,
  type Tool,
  user,
} from "../src/types.js";

const BASE_URL = "https://anthropic.test";

/** Serves canned Messages API payloads in order and records each outgoing request. */
function toolStub(responses: unknown[]) {
  const calls: Request[] = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push(new Request(input, init));
    // Repeats the last payload so "always calls a tool" fixtures need one entry.
    const body = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

function clientWith(fetchImpl: typeof fetch) {
  return createClient({
    provider: "claude",
    flavor: "api",
    model: "claude-test",
    apiKey: "test-key",
    baseUrl: BASE_URL,
    fetch: fetchImpl,
  });
}

function usage() {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
  };
}

function toolUseMessage(blocks: Array<Record<string, unknown>>) {
  return {
    id: "msg_tool",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: blocks,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: usage(),
  };
}

function finalMessage(text: string) {
  return {
    id: "msg_final",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: usage(),
  };
}

function echoTool(name: string, result: string, execute?: Tool["execute"]): Tool {
  return {
    name,
    description: `returns ${result}`,
    inputSchema: { type: "object", properties: { a: { type: "number" } } },
    execute: execute ?? (() => result),
  };
}

async function rejection(promise: Promise<unknown>): Promise<LLMDriverError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LLMDriverError);
    return error as LLMDriverError;
  }
  throw new Error("expected generate() to reject");
}

describe("tool loop on anthropic/api", () => {
  it("runs a two-round loop, executes parallel calls concurrently, and records them", async () => {
    // A barrier that only clears once BOTH handlers are in flight — a sequential
    // loop would deadlock here and fail the test by timeout.
    let entered = 0;
    let release = () => {};
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = (result: string) => async () => {
      entered += 1;
      if (entered === 2) release();
      await both;
      return result;
    };

    const stub = toolStub([
      toolUseMessage([
        { type: "text", text: "computing" },
        { type: "tool_use", id: "t1", name: "add", input: { a: 1, b: 2 } },
        { type: "tool_use", id: "t2", name: "mul", input: { a: 3, b: 4 } },
      ]),
      finalMessage("the answers are 3 and 12"),
    ]);

    const request: GenerateRequest = {
      maxTokens: 64,
      messages: [user("compute")],
      tools: [echoTool("add", "3", gated("3")), echoTool("mul", "12", gated("12"))],
    };

    const response = await clientWith(stub.impl).generate(request);

    expect(response.text).toBe("the answers are 3 and 12");
    expect(response.completionReason).toBe("stop");
    expect(response.toolCalls).toEqual([
      {
        id: "t1",
        name: "add",
        input: { a: 1, b: 2 },
        output: { text: "3", isError: false },
        isError: false,
      },
      {
        id: "t2",
        name: "mul",
        input: { a: 3, b: 4 },
        output: { text: "12", isError: false },
        isError: false,
      },
    ]);

    // First send carries the tools; second send carries the tool_use + tool_result turns.
    expect(stub.calls).toHaveLength(2);
    const firstBody = (await stub.calls[0]?.json()) as Record<string, unknown>;
    expect(firstBody.tools).toEqual([
      {
        name: "add",
        description: "returns 3",
        input_schema: { type: "object", properties: { a: { type: "number" } } },
      },
      {
        name: "mul",
        description: "returns 12",
        input_schema: { type: "object", properties: { a: { type: "number" } } },
      },
    ]);

    const secondBody = (await stub.calls[1]?.json()) as { messages: unknown[] };
    expect(secondBody.messages).toMatchObject([
      { role: "user", content: [{ type: "text", text: "compute" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "computing" },
          { type: "tool_use", id: "t1", name: "add", input: { a: 1, b: 2 } },
          { type: "tool_use", id: "t2", name: "mul", input: { a: 3, b: 4 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "3" },
          { type: "tool_result", tool_use_id: "t2", content: "12" },
        ],
      },
    ]);
  });

  it("maps toolChoice onto tool_choice (required → any, named → tool)", async () => {
    const required = toolStub([finalMessage("done")]);
    await clientWith(required.impl).generate({
      maxTokens: 8,
      messages: [user("hi")],
      tools: [echoTool("add", "3")],
      toolChoice: "required",
    });
    expect(
      ((await (required.calls[0] as Request).json()) as Record<string, unknown>).tool_choice,
    ).toEqual({
      type: "any",
    });

    const named = toolStub([finalMessage("done")]);
    await clientWith(named.impl).generate({
      maxTokens: 8,
      messages: [user("hi")],
      tools: [echoTool("add", "3")],
      toolChoice: { name: "add" },
    });
    expect(
      ((await (named.calls[0] as Request).json()) as Record<string, unknown>).tool_choice,
    ).toEqual({
      type: "tool",
      name: "add",
    });
  });

  it("rejects tool_failed when the model calls a tool that was not declared", async () => {
    const stub = toolStub([
      toolUseMessage([{ type: "tool_use", id: "t1", name: "ghost", input: {} }]),
    ]);

    const error = await rejection(
      clientWith(stub.impl).generate({
        maxTokens: 8,
        messages: [user("go")],
        tools: [echoTool("add", "3")],
      }),
    );

    expect(error.code).toBe("tool_failed");
    expect(error.message).toContain("ghost");
  });

  it("continues the loop when a handler returns { isError: true }", async () => {
    const stub = toolStub([
      toolUseMessage([{ type: "tool_use", id: "t1", name: "add", input: {} }]),
      finalMessage("recovered"),
    ]);

    const response = await clientWith(stub.impl).generate({
      maxTokens: 8,
      messages: [user("go")],
      tools: [echoTool("add", "", () => ({ text: "nope", isError: true }))],
    });

    expect(response.text).toBe("recovered");
    expect(response.toolCalls).toEqual([
      { id: "t1", name: "add", input: {}, output: { text: "nope", isError: true }, isError: true },
    ]);
    expect(stub.calls).toHaveLength(2);
    const secondBody = (await stub.calls[1]?.json()) as { messages: Array<{ content: unknown }> };
    expect(secondBody.messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "nope", is_error: true },
    ]);
  });

  it("rejects tool_failed when a handler throws, preserving the cause", async () => {
    const stub = toolStub([
      toolUseMessage([{ type: "tool_use", id: "t1", name: "boom", input: {} }]),
    ]);
    const cause = new Error("handler exploded");

    const error = await rejection(
      clientWith(stub.impl).generate({
        maxTokens: 8,
        messages: [user("go")],
        tools: [
          echoTool("boom", "", () => {
            throw cause;
          }),
        ],
      }),
    );

    expect(error.code).toBe("tool_failed");
    expect(error.cause).toBe(cause);
    expect(error.provider).toBe("claude");
    expect(error.flavor).toBe("api");
  });

  it("rejects tool_loop_exceeded after 16 rounds without ending", async () => {
    let executed = 0;
    const stub = toolStub([
      toolUseMessage([{ type: "tool_use", id: "t1", name: "add", input: {} }]),
    ]);

    const error = await rejection(
      clientWith(stub.impl).generate({
        maxTokens: 8,
        messages: [user("loop")],
        tools: [
          echoTool("add", "", () => {
            executed += 1;
            return "3";
          }),
        ],
      }),
    );

    expect(error.code).toBe("tool_loop_exceeded");
    expect(stub.calls).toHaveLength(16);
    expect(executed).toBe(16);
  });

  it("surfaces the raw abort reason when the signal fires mid-handler", async () => {
    let started = () => {};
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stub = toolStub([
      toolUseMessage([{ type: "tool_use", id: "t1", name: "wait", input: {} }]),
    ]);
    const controller = new AbortController();
    const reason = new Error("my-timeout");

    const tool: Tool = {
      name: "wait",
      description: "never resolves until aborted",
      inputSchema: { type: "object" },
      execute: (_input, ctx) =>
        new Promise((_resolve, reject) => {
          started();
          ctx.signal?.addEventListener("abort", () => reject(new Error("handler saw abort")));
        }),
    };

    const pending = clientWith(stub.impl).generate(
      { maxTokens: 8, messages: [user("go")], tools: [tool] },
      { signal: controller.signal },
    );
    await handlerStarted;
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("does not enter the loop when the request has no tools", async () => {
    const stub = toolStub([finalMessage("plain")]);
    const response = await clientWith(stub.impl).generate({ maxTokens: 8, messages: [user("hi")] });

    expect(response.text).toBe("plain");
    expect(response.toolCalls).toEqual([]);
    expect(stub.calls).toHaveLength(1);
    expect((await stub.calls[0]?.json()) as Record<string, unknown>).not.toHaveProperty("tools");
  });
});

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const STREAM_MESSAGE_START = {
  type: "message_start",
  message: {
    id: "msg_stream",
    type: "message",
    role: "assistant",
    model: "claude-test",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: usage(),
  },
};

const textStart = (index: number) =>
  sse("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  });
const textDelta = (index: number, text: string) =>
  sse("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
const toolStart = (index: number, id: string, name: string) =>
  sse("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name, input: {} },
  });
const toolDelta = (index: number, partial: string) =>
  sse("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partial },
  });
const blockStop = (index: number) =>
  sse("content_block_stop", { type: "content_block_stop", index });
const messageDelta = (stopReason: string) =>
  sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 5 },
  });
const MESSAGE_STOP = sse("message_stop", { type: "message_stop" });

/**
 * Serves one canned SSE body per request (one round each) and records the abort
 * signal it saw. `keepOpen` leaves that round's stream unfinished so a break can
 * observe the transport being torn down.
 */
function sequencedSse(rounds: string[][], options: { keepOpen?: boolean } = {}) {
  const signals: (AbortSignal | undefined)[] = [];
  const impl: typeof fetch = async (input, init) => {
    const round = rounds[Math.min(signals.length, rounds.length - 1)] ?? [];
    const signal = init?.signal ?? undefined;
    signals.push(signal);
    void input;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of round) controller.enqueue(new TextEncoder().encode(chunk));
        if (options.keepOpen) {
          signal?.addEventListener("abort", () => controller.error(signal.reason));
        } else {
          controller.close();
        }
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { impl, signals };
}

describe("tool loop streaming on anthropic/api", () => {
  it("orders text → tool_call → tool_result → text → done, one done last", async () => {
    const stub = sequencedSse([
      [
        sse("message_start", STREAM_MESSAGE_START),
        textStart(0),
        textDelta(0, "let me check"),
        blockStop(0),
        toolStart(1, "t1", "add"),
        toolDelta(1, '{"a":1,'),
        toolDelta(1, '"b":2}'),
        blockStop(1),
        messageDelta("tool_use"),
        MESSAGE_STOP,
      ],
      [
        sse("message_start", STREAM_MESSAGE_START),
        textStart(0),
        textDelta(0, "the answer is 3"),
        blockStop(0),
        messageDelta("end_turn"),
        MESSAGE_STOP,
      ],
    ]);

    const events: StreamEvent[] = [];
    for await (const event of clientWith(stub.impl).generateStream({
      maxTokens: 64,
      messages: [user("add")],
      tools: [echoTool("add", "3")],
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "text",
      "tool_call",
      "tool_result",
      "text",
      "done",
    ]);
    expect(events[0]).toEqual({ type: "text", text: "let me check" });
    expect(events[1]).toEqual({ type: "tool_call", id: "t1", name: "add", input: { a: 1, b: 2 } });
    expect(events[2]).toEqual({
      type: "tool_result",
      id: "t1",
      name: "add",
      output: { text: "3", isError: false },
      isError: false,
    });
    expect(events[3]).toEqual({ type: "text", text: "the answer is 3" });

    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected a done event last");
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    // Narrowed contract: with tools, response.text is the FINAL message only —
    // the pre-tool "let me check" delta streamed but is not part of it.
    expect(done.response.text).toBe("the answer is 3");
    expect(done.response.completionReason).toBe("stop");
    expect(done.response.toolCalls).toEqual([
      {
        id: "t1",
        name: "add",
        input: { a: 1, b: 2 },
        output: { text: "3", isError: false },
        isError: false,
      },
    ]);
  });

  it("break at a tool_result aborts the in-flight sibling execute", async () => {
    let siblingAborted = false;
    const stub = sequencedSse([
      [
        sse("message_start", STREAM_MESSAGE_START),
        toolStart(0, "fast", "fast"),
        blockStop(0),
        toolStart(1, "slow", "slow"),
        blockStop(1),
        messageDelta("tool_use"),
        MESSAGE_STOP,
      ],
    ]);

    const tools: Tool[] = [
      echoTool("fast", "1"),
      {
        name: "slow",
        description: "never resolves until aborted",
        inputSchema: { type: "object" },
        execute: (_input, ctx) =>
          new Promise((_resolve, reject) => {
            ctx.signal?.addEventListener("abort", () => {
              siblingAborted = true;
              reject(new Error("handler saw abort"));
            });
          }),
      },
    ];

    for await (const event of clientWith(stub.impl).generateStream({
      maxTokens: 8,
      messages: [user("go")],
      tools,
    })) {
      if (event.type === "tool_result") break;
    }

    expect(siblingAborted).toBe(true);
  });

  it("tears the transport down when the consumer breaks during a text delta", async () => {
    const stub = sequencedSse(
      [[sse("message_start", STREAM_MESSAGE_START), textStart(0), textDelta(0, "streaming")]],
      { keepOpen: true },
    );

    for await (const event of clientWith(stub.impl).generateStream({
      maxTokens: 8,
      messages: [user("go")],
      tools: [echoTool("add", "3")],
    })) {
      expect(event).toEqual({ type: "text", text: "streaming" });
      break;
    }

    expect(stub.signals[0]?.aborted).toBe(true);
  });

  it("surfaces the raw abort reason when the request signal fires mid-stream", async () => {
    const stub = sequencedSse(
      [[sse("message_start", STREAM_MESSAGE_START), textStart(0), textDelta(0, "hi")]],
      { keepOpen: true },
    );
    const controller = new AbortController();
    const reason = new Error("my-timeout");

    const drain = (async () => {
      for await (const event of clientWith(stub.impl).generateStream(
        { maxTokens: 8, messages: [user("go")], tools: [echoTool("add", "3")] },
        { signal: controller.signal },
      )) {
        expect(event).toEqual({ type: "text", text: "hi" });
        controller.abort(reason);
      }
    })();

    await expect(drain).rejects.toBe(reason);
  });
});
