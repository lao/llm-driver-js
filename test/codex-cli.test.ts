import { describe, expect, it } from "vitest";
import type { Command, CommandResult, CommandRunner } from "../src/backends/cli.js";
import { createCodexCliBackend } from "../src/backends/codex-cli.js";
import { type ErrorCode, LLMShimError } from "../src/errors.js";
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
): Promise<LLMShimError> {
  const { runner } = fakeRunner(result, error);
  try {
    await createCodexCliBackend(config, runner).generate(request);
  } catch (caught) {
    expect(caught).toBeInstanceOf(LLMShimError);
    return caught as LLMShimError;
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
        },
      },
    ]);
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

  it("leaves an LLMShimError abort reason untouched", async () => {
    const controller = new AbortController();
    // An abort reason that is itself an LLMShimError used to be re-normalized
    // into a fresh error by the diagnostic fallback; it must pass through.
    const reason = new LLMShimError("process_failed", "caller aborted", { status: 9 });
    const runner: CommandRunner = async (_command, signal) => {
      controller.abort(reason);
      throw signal?.reason;
    };

    await expect(
      collect(createCodexCliBackend(config, runner).generateStream(request, controller.signal)),
    ).rejects.toBe(reason);
  });
});
