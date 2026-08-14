import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { LLMDriverError } from "../src/errors.js";
import { type Request as GenerateRequest, type Tool, user } from "../src/types.js";

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

  it("rejects unsupported_feature for tools in generateStream", async () => {
    const stub = toolStub([finalMessage("unused")]);
    const stream = clientWith(stub.impl).generateStream({
      maxTokens: 8,
      messages: [user("hi")],
      tools: [echoTool("add", "3")],
    });

    const error = await rejection(
      (async () => {
        for await (const _event of stream) {
          // first next() should throw
        }
      })(),
    );
    expect(error.code).toBe("unsupported_feature");
    expect(stub.calls).toHaveLength(0);
  });
});
