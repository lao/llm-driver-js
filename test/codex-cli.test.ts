import { describe, expect, it } from "vitest";
import {
  type Command,
  type CommandResult,
  type CommandRunner,
  type StreamingCommandRunner,
  spawnRunner,
} from "../src/backends/cli.js";
import { createCodexCliBackend } from "../src/backends/codex-cli.js";
import { type ErrorCode, LLMWrapperError } from "../src/errors.js";
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
): Promise<LLMWrapperError> {
  const { runner } = fakeRunner(result, error);
  try {
    await createCodexCliBackend(config, runner).generate(request);
  } catch (caught) {
    expect(caught).toBeInstanceOf(LLMWrapperError);
    return caught as LLMWrapperError;
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
    });
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

function fakeStreamRunner(
  lines: string[],
  exit: Partial<{ exitCode: number; stderr: string }> = {},
  error?: unknown,
) {
  const calls: Array<{ command: Command; signal?: AbortSignal }> = [];
  let closed = false;
  const runner: StreamingCommandRunner = async function* (command, signal) {
    calls.push({ command, signal });
    try {
      if (error !== undefined) throw error;
      for (const line of lines) yield { type: "line", line };
      yield { type: "exit", exitCode: 0, stderr: "", ...exit };
    } finally {
      closed = true;
    }
  };
  return { runner, calls, wasClosed: () => closed };
}

function streamBackend(
  lines: string[],
  exit?: Partial<{ exitCode: number; stderr: string }>,
  error?: unknown,
) {
  const fake = fakeStreamRunner(lines, exit, error);
  return { ...fake, backend: createCodexCliBackend(config, spawnRunner, fake.runner) };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const seen: StreamEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

async function streamError(
  lines: string[],
  exit?: Partial<{ exitCode: number; stderr: string }>,
  error?: unknown,
): Promise<LLMWrapperError> {
  const { backend } = streamBackend(lines, exit, error);
  try {
    await collect(backend.generateStream(request));
  } catch (caught) {
    expect(caught).toBeInstanceOf(LLMWrapperError);
    return caught as LLMWrapperError;
  }
  throw new Error("generateStream() completed, want a failure");
}

describe("codex cli streaming", () => {
  const successLines = [
    '{"type":"thread.started","thread_id":"thread-123"}',
    '{"type":"item.completed","item":{"id":"message-1","type":"agent_message","text":"Final answer"}}',
    '{"type":"turn.completed","usage":{"input_tokens":19,"cached_input_tokens":11,"cache_write_input_tokens":5,"output_tokens":7,"reasoning_output_tokens":3}}',
  ];

  it("reuses the generate argv and forwards the signal", async () => {
    const { backend, calls } = streamBackend(successLines);
    const signal = new AbortController().signal;

    await collect(backend.generateStream(request, signal));

    expect(calls[0]?.command).toEqual({
      executable: "codex",
      args: [...baseArgs, "--model", "gpt-test", "-"],
      stdin: "Hello",
    });
    expect(calls[0]?.signal).toBe(signal);
  });

  it("yields one coarse text event, then the response generate would return", async () => {
    const { backend } = streamBackend(successLines);

    const events = await collect(backend.generateStream(request));

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
        },
      },
    ]);
  });

  it("emits only the done event when the agent message is empty", async () => {
    const { backend } = streamBackend([
      '{"type":"item.completed","item":{"type":"agent_message","text":""}}',
      '{"type":"turn.completed","usage":{}}',
    ]);

    const events = await collect(backend.generateStream(request));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "done", response: { text: "" } });
  });

  it("normalizes a failed turn", async () => {
    const error = await streamError(['{"type":"turn.failed","error":{"message":"model failed"}}']);

    expect(error.code).toBe("api_error");
    expect(error.providerCode).toBe("turn_failed");
    expect(error.message).toBe("model failed");
    expect(error.status).toBeUndefined();
  });

  it("prefers a reported diagnostic over a bare non-zero exit", async () => {
    const error = await streamError(['{"type":"turn.failed","error":{"message":"model failed"}}'], {
      exitCode: 9,
      stderr: "codex exited",
    });

    expect(error.code).toBe("api_error");
    expect(error.status).toBe(9);
    expect(error.providerCode).toBe("turn_failed");
    expect(error.message).toBe("model failed");
  });

  it("keeps the exit code when the stream holds no diagnostic", async () => {
    const error = await streamError(
      ['{"type":"item.completed","item":{"type":"agent_message","text":"orphan"}}'],
      { exitCode: 9, stderr: "codex exited" },
    );

    expect(error.code).toBe("process_failed");
    expect(error.status).toBe(9);
    expect(error.message).toBe("codex exited");
  });

  it("normalizes a malformed event line", async () => {
    const error = await streamError(['{"type":"turn.started"}', "not-json"]);

    expect(error.code).toBe("parse_failed");
    expect(error.message).toContain("event 2");
  });

  it("normalizes a stream that never completes a turn", async () => {
    const error = await streamError([
      '{"type":"item.completed","item":{"type":"agent_message","text":"orphan"}}',
    ]);

    expect(error.code).toBe("parse_failed");
    expect(error.providerCode).toBe("missing_turn_completion");
  });

  it("normalizes a missing executable", async () => {
    const error = await streamError(
      [],
      {},
      Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }),
    );

    expect(error.code).toBe("executable_not_found");
  });

  it("closes the runner when the consumer breaks early", async () => {
    const { backend, wasClosed } = streamBackend(successLines);

    for await (const event of backend.generateStream(request)) {
      expect(event).toEqual({ type: "text", text: "Final answer" });
      break;
    }

    expect(wasClosed()).toBe(true);
  });

  it("propagates a caller abort unwrapped mid-stream", async () => {
    const controller = new AbortController();
    const reason = new Error("caller aborted");
    const runner: StreamingCommandRunner = async function* (_command, signal) {
      yield { type: "line", line: '{"type":"thread.started","thread_id":"thread-123"}' };
      controller.abort(reason);
      throw signal?.reason;
    };
    const backend = createCodexCliBackend(config, spawnRunner, runner);

    await expect(collect(backend.generateStream(request, controller.signal))).rejects.toBe(reason);
  });
});
