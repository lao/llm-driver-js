import { describe, expect, it } from "vitest";
import { createClaudeCliBackend } from "../src/backends/claude-cli.js";
import type { Command, CommandResult, CommandRunner } from "../src/backends/cli.js";
import { type ErrorCode, LLMWrapperError } from "../src/errors.js";
import { assistant, type Config, type Request, user } from "../src/types.js";

const config: Config = { provider: "claude", flavor: "cli", model: "claude-test" };
const request: Request = { maxTokens: 32, messages: [user("Hello")] };
const baseArgs = ["-p", "--output-format", "json", "--permission-mode", "default"];

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
    await createClaudeCliBackend(config, runner).generate(request);
  } catch (caught) {
    expect(caught).toBeInstanceOf(LLMWrapperError);
    return caught as LLMWrapperError;
  }
  throw new Error("generate() resolved, want a failure");
}

describe("claude cli command", () => {
  const okStdout = '{"type":"result","subtype":"success","result":"ok"}';

  it("builds the default argv and sends a lone user message raw", async () => {
    const { runner, calls } = fakeRunner({ stdout: okStdout });
    const signal = new AbortController().signal;

    await createClaudeCliBackend(config, runner).generate(request, signal);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toEqual({
      executable: "claude",
      args: [...baseArgs, "--model", "claude-test"],
      stdin: "Hello",
    });
    expect(calls[0]?.signal).toBe(signal);
  });

  it("appends the system prompt and extra cli args, and renders the transcript", async () => {
    const { runner, calls } = fakeRunner({ stdout: okStdout });
    const backend = createClaudeCliBackend(
      {
        ...config,
        cliPath: "/opt/bin/claude-custom",
        cliArgs: ["--permission-mode", "plan"],
      },
      runner,
    );

    await backend.generate({
      system: "Be concise.",
      maxTokens: 32,
      messages: [user("First"), assistant("Second"), user("Third")],
    });

    expect(calls[0]?.command).toEqual({
      executable: "/opt/bin/claude-custom",
      args: [
        ...baseArgs,
        "--model",
        "claude-test",
        "--append-system-prompt",
        "Be concise.",
        "--permission-mode",
        "plan",
      ],
      stdin: "User: First\n\nAssistant: Second\n\nUser: Third",
    });
  });
});

describe("claude cli parsing", () => {
  it("maps a successful result and its usage", async () => {
    const { runner } = fakeRunner({
      stdout: `{
        "type":"result",
        "subtype":"success",
        "is_error":false,
        "result":"Hello from Claude",
        "session_id":"session-123",
        "usage":{
          "input_tokens":11,
          "output_tokens":7,
          "cache_read_input_tokens":5,
          "cache_creation_input_tokens":3
        }
      }`,
    });

    const response = await createClaudeCliBackend(config, runner).generate(request);

    expect(response).toEqual({
      id: "session-123",
      model: "claude-test",
      text: "Hello from Claude",
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cachedInputTokens: 5,
        cacheCreationInputTokens: 3,
        reasoningTokens: 0,
      },
      completionReason: "",
      provider: "claude",
      flavor: "cli",
    });
  });

  it("defaults missing fields instead of failing", async () => {
    const { runner } = fakeRunner({ stdout: '{"type":"result","subtype":"success"}' });

    const response = await createClaudeCliBackend(config, runner).generate(request);

    expect(response.id).toBe("");
    expect(response.text).toBe("");
    expect(response.usage.inputTokens).toBe(0);
  });
});

describe("claude cli failures", () => {
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
      error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
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
      result: { stderr: "authentication failed\n", exitCode: 17 },
      code: "process_failed",
      status: 17,
      message: "authentication failed",
    },
    {
      name: "malformed JSON",
      result: { stdout: "not-json" },
      code: "parse_failed",
    },
    {
      name: "JSON that is not an object",
      result: { stdout: "[]" },
      code: "parse_failed",
    },
    {
      name: "non-success subtype",
      result: {
        stdout: '{"type":"result","subtype":"error_max_turns","result":"turn limit reached"}',
      },
      code: "api_error",
      providerCode: "error_max_turns",
      message: "turn limit reached",
    },
    {
      name: "error result",
      result: {
        stdout:
          '{"type":"result","subtype":"success","is_error":true,"result":"provider rejected request"}',
      },
      code: "api_error",
      providerCode: "error",
      message: "provider rejected request",
    },
    {
      name: "unexpected result type",
      result: { stdout: '{"type":"unexpected","subtype":"success","result":"wrong payload"}' },
      code: "api_error",
      providerCode: "unexpected",
      message: "wrong payload",
    },
    {
      name: "unsuccessful result without a message",
      result: { stdout: '{"type":"result","subtype":"success","is_error":true,"result":"  "}' },
      code: "api_error",
      providerCode: "error",
      message: "Claude CLI returned an unsuccessful result",
    },
  ];

  for (const testCase of cases) {
    it(`normalizes ${testCase.name}`, async () => {
      const error = await generateError(testCase.result, testCase.error);

      expect(error.code).toBe(testCase.code);
      expect(error.status).toBe(testCase.status);
      expect(error.providerCode).toBe(testCase.providerCode);
      expect(error.provider).toBe("claude");
      expect(error.flavor).toBe("cli");
      expect(error.operation).toBe("generate");
      if (testCase.message !== undefined) {
        expect(error.message).toBe(testCase.message);
      }
    });
  }

  it("propagates a caller abort unwrapped", async () => {
    const controller = new AbortController();
    const reason = new Error("caller aborted");
    const runner: CommandRunner = async (_command, signal) => {
      controller.abort(reason);
      throw signal?.reason;
    };

    await expect(
      createClaudeCliBackend(config, runner).generate(request, controller.signal),
    ).rejects.toBe(reason);
  });
});
