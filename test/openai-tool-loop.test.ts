import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { LLMDriverError } from "../src/errors.js";
import {
  type Request as GenerateRequest,
  type StreamEvent,
  type Tool,
  user,
} from "../src/types.js";

const BASE_URL = "https://openai.test";

/** Serves canned Responses API payloads in order and records each outgoing request. */
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
    provider: "openai",
    flavor: "api",
    model: "gpt-test",
    apiKey: "test-key",
    baseUrl: BASE_URL,
    fetch: fetchImpl,
  });
}

function usage() {
  return {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 1 },
  };
}

/** A Responses payload whose output is a set of function_call items (no message text). */
function functionCallResponse(calls: Array<Record<string, unknown>>) {
  return {
    id: "resp_tool",
    object: "response",
    status: "completed",
    model: "gpt-test",
    output: calls.map((call) => ({ type: "function_call", status: "completed", ...call })),
    usage: usage(),
  };
}

function finalResponse(text: string) {
  return {
    id: "resp_final",
    object: "response",
    status: "completed",
    model: "gpt-test",
    output: [
      {
        id: "msg_1",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
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

describe("tool loop on openai/api", () => {
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
      functionCallResponse([
        { call_id: "call_1", name: "add", arguments: JSON.stringify({ a: 1, b: 2 }) },
        { call_id: "call_2", name: "mul", arguments: JSON.stringify({ a: 3, b: 4 }) },
      ]),
      finalResponse("the answers are 3 and 12"),
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
        id: "call_1",
        name: "add",
        input: { a: 1, b: 2 },
        output: { text: "3", isError: false },
        isError: false,
      },
      {
        id: "call_2",
        name: "mul",
        input: { a: 3, b: 4 },
        output: { text: "12", isError: false },
        isError: false,
      },
    ]);

    // First send carries the tools; second send carries the function_call +
    // function_call_output items appended to the transcript.
    expect(stub.calls).toHaveLength(2);
    const firstBody = (await stub.calls[0]?.json()) as Record<string, unknown>;
    expect(firstBody.tools).toEqual([
      {
        type: "function",
        name: "add",
        description: "returns 3",
        parameters: { type: "object", properties: { a: { type: "number" } } },
        strict: false,
      },
      {
        type: "function",
        name: "mul",
        description: "returns 12",
        parameters: { type: "object", properties: { a: { type: "number" } } },
        strict: false,
      },
    ]);

    const secondBody = (await stub.calls[1]?.json()) as { input: unknown[] };
    expect(secondBody.input).toMatchObject([
      { type: "message", role: "user", content: [{ type: "input_text", text: "compute" }] },
      { type: "function_call", call_id: "call_1", name: "add" },
      { type: "function_call", call_id: "call_2", name: "mul" },
      { type: "function_call_output", call_id: "call_1", output: "3" },
      { type: "function_call_output", call_id: "call_2", output: "12" },
    ]);
  });

  it("maps toolChoice onto tool_choice (required passthrough, named → function)", async () => {
    const required = toolStub([finalResponse("done")]);
    await clientWith(required.impl).generate({
      maxTokens: 8,
      messages: [user("hi")],
      tools: [echoTool("add", "3")],
      toolChoice: "required",
    });
    expect(
      ((await (required.calls[0] as Request).json()) as Record<string, unknown>).tool_choice,
    ).toBe("required");

    const named = toolStub([finalResponse("done")]);
    await clientWith(named.impl).generate({
      maxTokens: 8,
      messages: [user("hi")],
      tools: [echoTool("add", "3")],
      toolChoice: { name: "add" },
    });
    expect(
      ((await (named.calls[0] as Request).json()) as Record<string, unknown>).tool_choice,
    ).toEqual({ type: "function", name: "add" });
  });

  it("rejects tool_failed when the model calls a tool that was not declared", async () => {
    const stub = toolStub([
      functionCallResponse([{ call_id: "call_1", name: "ghost", arguments: "{}" }]),
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
      functionCallResponse([{ call_id: "call_1", name: "add", arguments: "{}" }]),
      finalResponse("recovered"),
    ]);

    const response = await clientWith(stub.impl).generate({
      maxTokens: 8,
      messages: [user("go")],
      tools: [echoTool("add", "", () => ({ text: "nope", isError: true }))],
    });

    expect(response.text).toBe("recovered");
    expect(response.toolCalls).toEqual([
      {
        id: "call_1",
        name: "add",
        input: {},
        output: { text: "nope", isError: true },
        isError: true,
      },
    ]);
    expect(stub.calls).toHaveLength(2);
    const secondBody = (await stub.calls[1]?.json()) as { input: unknown[] };
    // OpenAI has no per-result error flag; the failed text is reported as output.
    expect(secondBody.input.at(-1)).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "nope",
    });
  });

  it("rejects tool_failed when a handler throws, preserving the cause", async () => {
    const stub = toolStub([
      functionCallResponse([{ call_id: "call_1", name: "boom", arguments: "{}" }]),
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
    expect(error.provider).toBe("openai");
    expect(error.flavor).toBe("api");
  });

  it("rejects tool_loop_exceeded after 16 rounds without ending", async () => {
    let executed = 0;
    const stub = toolStub([
      functionCallResponse([{ call_id: "call_1", name: "add", arguments: "{}" }]),
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
      functionCallResponse([{ call_id: "call_1", name: "wait", arguments: "{}" }]),
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

  it("rejects parse_failed when function_call arguments are not valid JSON", async () => {
    const stub = toolStub([
      functionCallResponse([{ call_id: "call_1", name: "add", arguments: "{not json" }]),
    ]);

    const error = await rejection(
      clientWith(stub.impl).generate({
        maxTokens: 8,
        messages: [user("go")],
        tools: [echoTool("add", "3")],
      }),
    );

    expect(error.code).toBe("parse_failed");
    expect(error.provider).toBe("openai");
  });

  it("treats empty function_call arguments as no input", async () => {
    const stub = toolStub([
      functionCallResponse([{ call_id: "call_1", name: "add", arguments: "" }]),
      finalResponse("done"),
    ]);

    const response = await clientWith(stub.impl).generate({
      maxTokens: 8,
      messages: [user("go")],
      tools: [echoTool("add", "3")],
    });

    expect(response.toolCalls[0]?.input).toEqual({});
  });

  it("does not enter the loop when the request has no tools", async () => {
    const stub = toolStub([finalResponse("plain")]);
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

const textDelta = (delta: string) =>
  sse("response.output_text.delta", {
    type: "response.output_text.delta",
    delta,
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    sequence_number: 1,
  });
const completed = (response: unknown) =>
  sse("response.completed", { type: "response.completed", response });

/**
 * Serves one canned SSE body per request (one round each) and records the abort
 * signal it saw. `keepOpen` leaves that round's stream unfinished so a break can
 * observe the transport being torn down.
 */
function sequencedSse(rounds: string[][], options: { keepOpen?: boolean } = {}) {
  const signals: (AbortSignal | undefined)[] = [];
  const impl: typeof fetch = async (_input, init) => {
    const round = rounds[Math.min(signals.length, rounds.length - 1)] ?? [];
    const signal = init?.signal ?? undefined;
    signals.push(signal);
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

describe("tool loop streaming on openai/api", () => {
  it("orders text → tool_call → tool_result → text → done, one done last", async () => {
    const stub = sequencedSse([
      [
        textDelta("checking"),
        completed(
          functionCallResponse([
            { call_id: "call_1", name: "add", arguments: JSON.stringify({ a: 1, b: 2 }) },
          ]),
        ),
      ],
      [textDelta("the answer is 3"), completed(finalResponse("the answer is 3"))],
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
    expect(events[0]).toEqual({ type: "text", text: "checking" });
    expect(events[1]).toEqual({
      type: "tool_call",
      id: "call_1",
      name: "add",
      input: { a: 1, b: 2 },
    });
    expect(events[2]).toEqual({
      type: "tool_result",
      id: "call_1",
      name: "add",
      output: { text: "3", isError: false },
      isError: false,
    });
    expect(events[3]).toEqual({ type: "text", text: "the answer is 3" });

    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected a done event last");
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    // Narrowed contract: with tools, response.text is the FINAL message only —
    // the pre-tool "checking" delta streamed but is not part of it.
    expect(done.response.text).toBe("the answer is 3");
    expect(done.response.completionReason).toBe("stop");
    expect(done.response.toolCalls).toEqual([
      {
        id: "call_1",
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
        completed(
          functionCallResponse([
            { call_id: "fast", name: "fast", arguments: "{}" },
            { call_id: "slow", name: "slow", arguments: "{}" },
          ]),
        ),
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
    const stub = sequencedSse([[textDelta("streaming")]], { keepOpen: true });

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
    const stub = sequencedSse([[textDelta("hi")]], { keepOpen: true });
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
