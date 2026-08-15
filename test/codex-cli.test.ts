import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Command, CommandResult, CommandRunner } from "../src/backends/cli.js";
import { createCodexCliBackend } from "../src/backends/codex-cli.js";
import { type ErrorCode, LLMDriverError } from "../src/errors.js";
import { assistant, type Config, type Request, type StreamEvent, user } from "../src/types.js";

const config: Config = { provider: "openai", flavor: "cli", model: "gpt-test" };
const request: Request = { maxTokens: 32, messages: [user("Hello")] };
const baseArgs = ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check"];

const successStdout = [
  '{"type":"thread.started","thread_id":"thread-1"}',
  '{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{}}',
  "",
].join("\n");

function fakeRunner(result: Partial<CommandResult>, error?: unknown) {
  const calls: Array<{ command: Command; signal?: AbortSignal }> = [];
  const runner: CommandRunner = async (command, signal) => {
    calls.push({ command, signal });
    if (error !== undefined) throw error;
    return { stdout: "", stderr: "", exitCode: 0, ...result };
  };
  return { runner, calls };
}

async function generateError(
  result: Partial<CommandResult>,
  error?: unknown,
): Promise<LLMDriverError> {
  const { runner } = fakeRunner(result, error);
  try {
    await createCodexCliBackend(config, runner).generate(request);
  } catch (caught) {
    expect(caught).toBeInstanceOf(LLMDriverError);
    return caught as LLMDriverError;
  }
  throw new Error("generate() resolved, want a failure");
}

describe("codex cli command", () => {
  it("builds the default argv and sends a lone user message raw", async () => {
    const { runner, calls } = fakeRunner({ stdout: successStdout });
    const signal = new AbortController().signal;

    await createCodexCliBackend(config, runner).generate(request, signal);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toEqual({
      executable: "codex",
      args: [...baseArgs, "--model", "gpt-test", "-"],
      stdin: "Hello",
    });
    expect(calls[0]?.signal).toBe(signal);
  });

  it("passes reasoning.effort as -c model_reasoning_effort before the stdin marker", async () => {
    const { runner, calls } = fakeRunner({ stdout: successStdout });
    const backend = createCodexCliBackend({ ...config, cliArgs: ["--color", "never"] }, runner);

    await backend.generate({ ...request, reasoning: { effort: "low" } });

    expect(calls[0]?.command.args).toEqual([
      ...baseArgs,
      "--model",
      "gpt-test",
      "-c",
      'model_reasoning_effort="low"',
      "--color",
      "never",
      "-",
    ]);
  });

  it("omits the reasoning override when the request has none (byte-identical to v1)", async () => {
    const { runner, calls } = fakeRunner({ stdout: successStdout });

    await createCodexCliBackend(config, runner).generate(request);

    expect(calls[0]?.command.args).toEqual([...baseArgs, "--model", "gpt-test", "-"]);
  });

  it("JSON-encodes developer instructions and keeps the stdin marker last", async () => {
    const { runner, calls } = fakeRunner({ stdout: successStdout });
    const backend = createCodexCliBackend(
      { ...config, cliPath: "/opt/bin/codex-custom", cliArgs: ["--color", "never"] },
      runner,
    );

    await backend.generate({
      system: 'Be "concise".\nUse x = y.',
      maxTokens: 32,
      messages: [user("First"), assistant("Second"), user("Third")],
    });

    expect(calls[0]?.command).toEqual({
      executable: "/opt/bin/codex-custom",
      args: [
        ...baseArgs,
        "--model",
        "gpt-test",
        "--config",
        'developer_instructions="Be \\"concise\\".\\nUse x = y."',
        "--color",
        "never",
        "-",
      ],
      stdin: "User: First\n\nAssistant: Second\n\nUser: Third",
    });
  });
});

describe("codex cli parsing", () => {
  it("keeps the last agent message and the reported usage", async () => {
    const { runner } = fakeRunner({
      stdout: `{"type":"thread.started","thread_id":"thread-123"}
{"type":"turn.started"}

{"type":"item.completed","item":{"id":"reason-1","type":"reasoning","text":"private progress"}}
{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"intermediate"}}
{"type":"item.completed","item":{"id":"command-1","type":"command_execution","aggregated_output":"noise"}}
{"type":"item.completed","item":{"id":"message-2","type":"agent_message","text":"Final answer"}}
{"type":"turn.completed","usage":{"input_tokens":19,"cached_input_tokens":11,"cache_write_input_tokens":5,"output_tokens":7,"reasoning_output_tokens":3}}
`,
    });

    const response = await createCodexCliBackend(config, runner).generate(request);

    expect(response).toEqual({
      id: "thread-123",
      model: "gpt-test",
      text: "Final answer",
      usage: {
        inputTokens: 19,
        outputTokens: 7,
        cachedInputTokens: 11,
        cacheCreationInputTokens: 5,
        reasoningTokens: 3,
      },
      completionReason: "",
      provider: "openai",
      flavor: "cli",
      toolCalls: [],
    });
  });
});

describe("codex cli structured output", () => {
  const schema = { type: "object", properties: { answer: { type: "number" } } };
  const structuredStdout = [
    '{"type":"thread.started","thread_id":"thread-1"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"answer\\":42}"}}',
    '{"type":"turn.completed","usage":{}}',
    "",
  ].join("\n");

  /**
   * Captures the --output-schema path and whether the file existed (and its
   * contents) at the moment the runner was invoked — the temp file must live for
   * the whole run and be gone once generate settles.
   */
  function schemaProbingRunner(result: Partial<CommandResult>, error?: unknown) {
    const seen: { path?: string; existedDuringRun: boolean; contents?: string } = {
      existedDuringRun: false,
    };
    const runner: CommandRunner = async (command) => {
      const index = command.args.indexOf("--output-schema");
      if (index !== -1) {
        seen.path = command.args[index + 1];
        seen.existedDuringRun = seen.path !== undefined && existsSync(seen.path);
        if (seen.existedDuringRun && seen.path) {
          seen.contents = readFileSync(seen.path, "utf8");
        }
      }
      if (error !== undefined) throw error;
      return { stdout: "", stderr: "", exitCode: 0, ...result };
    };
    return { runner, seen };
  }

  it("writes the schema to a temp file, passes --output-schema, and cleans up", async () => {
    const { runner, seen } = schemaProbingRunner({ stdout: structuredStdout });

    const response = await createCodexCliBackend(config, runner).generate({
      ...request,
      outputSchema: schema,
    });

    expect(seen.existedDuringRun).toBe(true);
    expect(seen.contents).toBe(JSON.stringify(schema));
    // Gone after resolve.
    expect(seen.path && existsSync(seen.path)).toBe(false);
    expect(response.structured).toEqual({ answer: 42 });
    expect(response.text).toBe('{"answer":42}');
  });

  it("deletes the temp file even when the run fails", async () => {
    const { runner, seen } = schemaProbingRunner({}, new Error("launch failed"));

    await expect(
      createCodexCliBackend(config, runner).generate({ ...request, outputSchema: schema }),
    ).rejects.toBeInstanceOf(LLMDriverError);

    expect(seen.existedDuringRun).toBe(true);
    expect(seen.path && existsSync(seen.path)).toBe(false);
  });

  it("deletes the temp file when the caller aborts", async () => {
    const controller = new AbortController();
    const reason = new Error("caller aborted");
    let seenPath: string | undefined;
    let existedDuringRun = false;
    const runner: CommandRunner = async (command, signal) => {
      const index = command.args.indexOf("--output-schema");
      seenPath = command.args[index + 1];
      existedDuringRun = seenPath !== undefined && existsSync(seenPath);
      controller.abort(reason);
      throw signal?.reason;
    };

    await expect(
      createCodexCliBackend(config, runner).generate(
        { ...request, outputSchema: schema },
        controller.signal,
      ),
    ).rejects.toBe(reason);

    expect(existedDuringRun).toBe(true);
    expect(seenPath && existsSync(seenPath)).toBe(false);
  });

  it("reports parse_failed when the structured output is not valid JSON", async () => {
    const { runner } = schemaProbingRunner({
      stdout: [
        '{"type":"thread.started","thread_id":"thread-1"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"not json"}}',
        '{"type":"turn.completed","usage":{}}',
        "",
      ].join("\n"),
    });

    const error = await createCodexCliBackend(config, runner)
      .generate({ ...request, outputSchema: schema })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(LLMDriverError);
    expect(error.code).toBe("parse_failed");
    expect(error.provider).toBe("openai");
    expect(error.flavor).toBe("cli");
  });

  it("omits --output-schema and leaves structured undefined without a schema", async () => {
    const { runner, calls } = fakeRunner({ stdout: successStdout });

    const response = await createCodexCliBackend(config, runner).generate(request);

    expect(calls[0]?.command.args).not.toContain("--output-schema");
    expect(response.structured).toBeUndefined();
  });
});

describe("codex cli failures", () => {
  const cases: Array<{
    name: string;
    result: Partial<CommandResult>;
    error?: unknown;
    code: ErrorCode;
    status?: number;
    providerCode?: string;
    message?: string;
  }> = [
    {
      name: "missing executable",
      result: {},
      error: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }),
      code: "executable_not_found",
    },
    {
      name: "launch failure",
      result: {},
      error: new Error("launch failed"),
      code: "process_failed",
      message: "launch failed",
    },
    {
      name: "non-zero exit",
      result: { stderr: "not authenticated\n", exitCode: 9 },
      code: "process_failed",
      status: 9,
      message: "not authenticated",
    },
    {
      name: "non-zero exit with a failed turn diagnostic",
      result: {
        stdout: '{"type":"turn.failed","error":{"message":"model failed"}}\n',
        stderr: "codex exited",
        exitCode: 9,
      },
      code: "api_error",
      status: 9,
      providerCode: "turn_failed",
      message: "model failed",
    },
    {
      name: "non-zero exit whose stdout holds no diagnostic",
      result: {
        stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"orphan"}}\n',
        stderr: "codex exited",
        exitCode: 9,
      },
      code: "process_failed",
      status: 9,
      message: "codex exited",
    },
    {
      name: "malformed JSONL",
      result: { stdout: '{"type":"turn.started"}\nnot-json\n' },
      code: "parse_failed",
    },
    {
      name: "a JSONL line that is not an object",
      result: { stdout: "[1,2]\n" },
      code: "parse_failed",
    },
    {
      name: "failed turn",
      result: { stdout: '{"type":"turn.failed","error":{"message":"model failed"}}\n' },
      code: "api_error",
      providerCode: "turn_failed",
      message: "model failed",
    },
    {
      name: "failed turn with a blank message",
      result: { stdout: '{"type":"turn.failed","error":{"message":"   "}}\n' },
      code: "api_error",
      providerCode: "turn_failed",
      message: "Codex CLI turn failed",
    },
    {
      name: "stream error",
      result: { stdout: '{"type":"error","message":"stream disconnected"}\n' },
      code: "api_error",
      providerCode: "error",
      message: "stream disconnected",
    },
    {
      name: "stream error with a blank message",
      result: { stdout: '{"type":"error","message":"   "}\n' },
      code: "api_error",
      providerCode: "error",
      message: "Codex CLI stream failed",
    },
    {
      name: "missing final message",
      result: {
        stdout:
          '{"type":"item.completed","item":{"id":"reason-1","type":"reasoning","text":"thinking"}}\n{"type":"turn.completed","usage":{}}\n',
      },
      code: "parse_failed",
      providerCode: "missing_final_message",
    },
    {
      name: "missing turn completion",
      result: {
        stdout:
          '{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"orphan"}}\n',
      },
      code: "parse_failed",
      providerCode: "missing_turn_completion",
    },
  ];

  for (const testCase of cases) {
    it(`normalizes ${testCase.name}`, async () => {
      const error = await generateError(testCase.result, testCase.error);

      expect(error.code).toBe(testCase.code);
      expect(error.status).toBe(testCase.status);
      expect(error.providerCode).toBe(testCase.providerCode);
      expect(error.provider).toBe("openai");
      expect(error.flavor).toBe("cli");
      expect(error.operation).toBe("generate");
      if (testCase.message !== undefined) {
        expect(error.message).toBe(testCase.message);
      }
    });
  }

  it("reports the offending line number for malformed JSONL", async () => {
    const error = await generateError({ stdout: '{"type":"turn.started"}\nnot-json\n' });

    expect(error.message).toContain("event 2");
  });

  it("propagates a caller abort unwrapped", async () => {
    const controller = new AbortController();
    const reason = new Error("caller aborted");
    const runner: CommandRunner = async (_command, signal) => {
      controller.abort(reason);
      throw signal?.reason;
    };

    await expect(
      createCodexCliBackend(config, runner).generate(request, controller.signal),
    ).rejects.toBe(reason);
  });
});

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const seen: StreamEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

/**
 * `generateStream` delegates to `generate`, so the failure-normalization matrix
 * above covers both paths; only the event contract is tested here.
 */
describe("codex cli streaming", () => {
  const successStream = [
    '{"type":"thread.started","thread_id":"thread-123"}',
    '{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"Final answer"}}',
    '{"type":"turn.completed","usage":{"input_tokens":19,"cached_input_tokens":11,"cache_write_input_tokens":5,"output_tokens":7,"reasoning_output_tokens":3}}',
    "",
  ].join("\n");

  it("reuses the generate argv and forwards the signal", async () => {
    const { runner, calls } = fakeRunner({ stdout: successStream });
    const signal = new AbortController().signal;

    await collect(createCodexCliBackend(config, runner).generateStream(request, signal));

    expect(calls[0]?.command).toEqual({
      executable: "codex",
      args: [...baseArgs, "--model", "gpt-test", "-"],
      stdin: "Hello",
    });
    expect(calls[0]?.signal).toBe(signal);
  });

  it("yields one coarse text event, then the response generate would return", async () => {
    const { runner } = fakeRunner({ stdout: successStream });

    const events = await collect(createCodexCliBackend(config, runner).generateStream(request));

    expect(events).toEqual([
      { type: "text", text: "Final answer" },
      {
        type: "done",
        response: {
          id: "thread-123",
          model: "gpt-test",
          text: "Final answer",
          usage: {
            inputTokens: 19,
            outputTokens: 7,
            cachedInputTokens: 11,
            cacheCreationInputTokens: 5,
            reasoningTokens: 3,
          },
          completionReason: "",
          provider: "openai",
          flavor: "cli",
          toolCalls: [],
        },
      },
    ]);
  });

  it("maps reasoning items to reasoning events, in source order before the text", async () => {
    const { runner } = fakeRunner({
      stdout: [
        '{"type":"thread.started","thread_id":"thread-123"}',
        '{"type":"item.completed","item":{"type":"reasoning","text":"Think"}}',
        '{"type":"item.completed","item":{"type":"reasoning","text":"ing"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"Final answer"}}',
        '{"type":"turn.completed","usage":{}}',
      ].join("\n"),
    });

    const events = await collect(createCodexCliBackend(config, runner).generateStream(request));

    // Coarse turn: reasoning items surface first, then the one text event, then done.
    expect(events.slice(0, 3)).toEqual([
      { type: "reasoning", text: "Think" },
      { type: "reasoning", text: "ing" },
      { type: "text", text: "Final answer" },
    ]);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected a done event");
    expect(done.response.text).toBe("Final answer");
  });

  it("emits no reasoning events when the JSONL exposes none", async () => {
    const { runner } = fakeRunner({ stdout: successStream });

    const events = await collect(createCodexCliBackend(config, runner).generateStream(request));

    // codex reports no reasoning on this turn (matrix ⚠️) — no placeholder events.
    expect(events.some((event) => event.type === "reasoning")).toBe(false);
  });

  it("emits only the done event when the agent message is empty", async () => {
    const { runner } = fakeRunner({
      stdout: [
        '{"type":"item.completed","item":{"type":"agent_message","text":""}}',
        '{"type":"turn.completed","usage":{}}',
      ].join("\n"),
    });

    const events = await collect(createCodexCliBackend(config, runner).generateStream(request));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "done", response: { text: "" } });
  });

  it("propagates a caller abort unwrapped mid-stream", async () => {
    const controller = new AbortController();
    const reason = new Error("caller aborted");
    const runner: CommandRunner = async (_command, signal) => {
      controller.abort(reason);
      throw signal?.reason;
    };

    await expect(
      collect(createCodexCliBackend(config, runner).generateStream(request, controller.signal)),
    ).rejects.toBe(reason);
  });

  it("leaves an LLMDriverError abort reason untouched", async () => {
    const controller = new AbortController();
    // An abort reason that is itself an LLMDriverError used to be re-normalized
    // into a fresh error by the diagnostic fallback; it must pass through.
    const reason = new LLMDriverError("process_failed", "caller aborted", { status: 9 });
    const runner: CommandRunner = async (_command, signal) => {
      controller.abort(reason);
      throw signal?.reason;
    };

    await expect(
      collect(createCodexCliBackend(config, runner).generateStream(request, controller.signal)),
    ).rejects.toBe(reason);
  });
});

// ── Tools via the MCP bridge (T15) ─────────────────────────────────────────
// These drive the REAL loopback bridge: the fake runner reads the bridge URL
// out of the argv it is handed and plays codex, calling the bridge over HTTP.
//
// FLAG: the `-c mcp_servers.llmdriver.url=` key syntax is characterized by the
// env-gated integration test against the real binary (SPEC-v2 open question 4).

const toolsRequest: Request = {
  maxTokens: 32,
  messages: [user("add 1 and 2")],
  tools: [
    {
      name: "add",
      description: "adds two numbers",
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
      execute: (input) => `sum:${JSON.stringify(input)}`,
    },
    {
      name: "mul",
      description: "multiplies two numbers",
      inputSchema: { type: "object" },
      execute: () => "0",
    },
  ],
};

const toolsStdout = [
  '{"type":"thread.started","thread_id":"thread-1"}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"the sum is 3"}}',
  '{"type":"turn.completed","usage":{}}',
  "",
].join("\n");

/** Reads the bridge URL the adapter wrote into the `-c mcp_servers.*` override. */
function bridgeUrl(command: Command): string {
  const index = command.args.indexOf("-c");
  const override = command.args[index + 1] as string;
  // `mcp_servers.llmdriver.url="http://..."` — key is fixed, value is JSON-quoted.
  const value = override.slice(override.indexOf("=") + 1);
  return JSON.parse(value) as string;
}

/** One JSON-RPC call to the live bridge; rejects if the bridge is closed. */
async function rpc(url: string, method: string, params?: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("codex cli tools argv", () => {
  it("adds the -c mcp_servers.llmdriver.url override (parsed) and keeps stdin last", async () => {
    const { runner, calls } = fakeRunner({ stdout: toolsStdout });

    await createCodexCliBackend(config, runner).generate(toolsRequest);

    const args = calls[0]?.command.args ?? [];
    // The stdin marker stays last even with the tool override present.
    expect(args.at(-1)).toBe("-");

    const cIndex = args.indexOf("-c");
    expect(cIndex).toBeGreaterThanOrEqual(0);
    const override = args[cIndex + 1] as string;
    const [key, ...rest] = override.split("=");
    expect(key).toBe("mcp_servers.llmdriver.url");
    // Value is a JSON-quoted loopback bridge URL, not a brittle string match.
    expect(JSON.parse(rest.join("="))).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f-]{36}$/);
  });

  it("keeps the v1 argv untouched when the request carries no tools", async () => {
    const { runner, calls } = fakeRunner({ stdout: successStdout });

    await createCodexCliBackend(config, runner).generate(request);

    const args = calls[0]?.command.args ?? [];
    expect(args).not.toContain("-c");
    expect(args.some((arg) => arg.startsWith("mcp_servers."))).toBe(false);
  });
});

describe("codex cli tools bridge lifecycle", () => {
  it("keeps the bridge reachable during the run, then closes it on resolve", async () => {
    let url = "";
    let statusDuringRun = 0;
    const runner: CommandRunner = async (command) => {
      url = bridgeUrl(command);
      statusDuringRun = (await rpc(url, "tools/list")).status;
      return { stdout: toolsStdout, stderr: "", exitCode: 0 };
    };

    await createCodexCliBackend(config, runner).generate(toolsRequest);

    expect(statusDuringRun).toBe(200);
    await expect(rpc(url, "tools/list")).rejects.toThrow(); // connection refused after close
  });

  it("closes the bridge when the run fails", async () => {
    let url = "";
    const runner: CommandRunner = async (command) => {
      url = bridgeUrl(command);
      return { stdout: "", stderr: "boom\n", exitCode: 1 };
    };

    await expect(
      createCodexCliBackend(config, runner).generate(toolsRequest),
    ).rejects.toBeInstanceOf(LLMDriverError);
    await expect(rpc(url, "tools/list")).rejects.toThrow();
  });

  it("closes the bridge when the run aborts", async () => {
    const controller = new AbortController();
    const reason = new Error("caller aborted");
    let url = "";
    const runner: CommandRunner = async (command, signal) => {
      url = bridgeUrl(command);
      controller.abort(reason);
      throw signal?.reason;
    };

    await expect(
      createCodexCliBackend(config, runner).generate(toolsRequest, controller.signal),
    ).rejects.toBe(reason);
    await expect(rpc(url, "tools/list")).rejects.toThrow();
  });

  it("closes the bridge when the stream consumer breaks early", async () => {
    let url = "";
    const runner: CommandRunner = async (command) => {
      url = bridgeUrl(command);
      return { stdout: toolsStdout, stderr: "", exitCode: 0 };
    };
    const backend = createCodexCliBackend(config, runner);

    for await (const _event of backend.generateStream(toolsRequest)) break;

    await expect(rpc(url, "tools/list")).rejects.toThrow();
  });
});

describe("codex cli tools round-trip", () => {
  it("populates response.toolCalls from a mid-turn tool call (generate)", async () => {
    const runner: CommandRunner = async (command) => {
      await rpc(bridgeUrl(command), "tools/call", { name: "add", arguments: { a: 1, b: 2 } });
      return { stdout: toolsStdout, stderr: "", exitCode: 0 };
    };

    const response = await createCodexCliBackend(config, runner).generate(toolsRequest);

    expect(response.toolCalls).toEqual([
      {
        id: expect.any(String),
        name: "add",
        input: { a: 1, b: 2 },
        output: { text: 'sum:{"a":1,"b":2}', isError: false },
        isError: false,
      },
    ]);
  });

  it("emits tool_call before tool_result and lands them in the done response (stream)", async () => {
    const runner: CommandRunner = async (command) => {
      await rpc(bridgeUrl(command), "tools/call", { name: "add", arguments: { a: 1, b: 2 } });
      return { stdout: toolsStdout, stderr: "", exitCode: 0 };
    };

    const events = await collect(
      createCodexCliBackend(config, runner).generateStream(toolsRequest),
    );

    const callAt = events.findIndex((event) => event.type === "tool_call");
    const resultAt = events.findIndex((event) => event.type === "tool_result");
    expect(callAt).toBeGreaterThanOrEqual(0);
    expect(callAt).toBeLessThan(resultAt);
    const call = events[callAt];
    const toolResult = events[resultAt];
    if (call?.type !== "tool_call" || toolResult?.type !== "tool_result") {
      throw new Error("unreachable");
    }
    expect(call).toMatchObject({ name: "add", input: { a: 1, b: 2 } });
    expect(toolResult).toMatchObject({
      id: call.id,
      name: "add",
      output: { text: 'sum:{"a":1,"b":2}', isError: false },
      isError: false,
    });

    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected a done event last");
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(done.response.toolCalls).toEqual([
      {
        id: call.id,
        name: "add",
        input: { a: 1, b: 2 },
        output: { text: 'sum:{"a":1,"b":2}', isError: false },
        isError: false,
      },
    ]);
  });
});
