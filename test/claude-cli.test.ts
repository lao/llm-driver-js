import { describe, expect, it } from "vitest";
import { createClaudeCliBackend } from "../src/backends/claude-cli.js";
import {
  type Command,
  type CommandResult,
  type CommandRunner,
  type StreamingCommandRunner,
  spawnRunner,
} from "../src/backends/cli.js";
import { type ErrorCode, LLMWrapperError } from "../src/errors.js";
import { assistant, type Config, type Request, type StreamEvent, user } from "../src/types.js";

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
      name: "an empty JSON object",
      result: { stdout: "{}" },
      code: "api_error",
      providerCode: "unsuccessful_result",
      message: "Claude CLI returned an unsuccessful result",
    },
    {
      name: "a result with no subtype",
      result: { stdout: '{"type":"result"}' },
      code: "api_error",
      providerCode: "unsuccessful_result",
      message: "Claude CLI returned an unsuccessful result",
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

const streamBaseArgs = [
  "-p",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--permission-mode",
  "default",
];

function delta(text: string): string {
  return JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    session_id: "session-123",
  });
}

const resultLine = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Hello, world",
  session_id: "session-123",
  usage: {
    input_tokens: 11,
    output_tokens: 7,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 3,
  },
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
  const backend = createClaudeCliBackend(config, spawnRunner, fake.runner);
  return { ...fake, backend };
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

describe("claude cli streaming command", () => {
  it("builds the stream-json argv and forwards the signal", async () => {
    const { backend, calls } = streamBackend([resultLine]);
    const signal = new AbortController().signal;

    await collect(backend.generateStream(request, signal));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toEqual({
      executable: "claude",
      args: [...streamBaseArgs, "--model", "claude-test"],
      stdin: "Hello",
    });
    expect(calls[0]?.signal).toBe(signal);
  });

  it("appends the system prompt and extra cli args like generate does", async () => {
    const fake = fakeStreamRunner([resultLine]);
    const backend = createClaudeCliBackend(
      { ...config, cliPath: "/opt/bin/claude-custom", cliArgs: ["--permission-mode", "plan"] },
      spawnRunner,
      fake.runner,
    );

    await collect(
      backend.generateStream({
        system: "Be concise.",
        maxTokens: 32,
        messages: [user("First"), assistant("Second"), user("Third")],
      }),
    );

    expect(fake.calls[0]?.command).toEqual({
      executable: "/opt/bin/claude-custom",
      args: [
        ...streamBaseArgs,
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

describe("claude cli streaming events", () => {
  it("yields partial text deltas, then the same response generate would return", async () => {
    const { backend } = streamBackend([
      '{"type":"system","subtype":"init","session_id":"session-123"}',
      delta("Hello, "),
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}}',
      delta("world"),
      '{"type":"assistant","message":{"role":"assistant"}}',
      "",
      resultLine,
    ]);

    const events = await collect(backend.generateStream(request));

    expect(events.slice(0, 2)).toEqual([
      { type: "text", text: "Hello, " },
      { type: "text", text: "world" },
    ]);
    expect(events[2]).toEqual({
      type: "done",
      response: {
        id: "session-123",
        model: "claude-test",
        text: "Hello, world",
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
      },
    });
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join("");
    expect(text).toBe("Hello, world");
  });

  it("emits only the done event when no partial messages arrive", async () => {
    const { backend } = streamBackend([resultLine]);

    const events = await collect(backend.generateStream(request));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "done", response: { text: "Hello, world" } });
  });

  it("closes the runner when the consumer breaks early", async () => {
    const { backend, wasClosed } = streamBackend([delta("Hello, "), delta("world"), resultLine]);

    for await (const event of backend.generateStream(request)) {
      expect(event).toEqual({ type: "text", text: "Hello, " });
      break;
    }

    expect(wasClosed()).toBe(true);
  });
});

describe("claude cli streaming failures", () => {
  it("normalizes a malformed event line", async () => {
    const error = await streamError([delta("hi"), "not-json"]);

    expect(error.code).toBe("parse_failed");
    expect(error.message).toContain("event 2");
    expect(error.provider).toBe("claude");
    expect(error.flavor).toBe("cli");
  });

  it("normalizes a stream that never reports a result", async () => {
    const error = await streamError([delta("hi")]);

    expect(error.code).toBe("parse_failed");
    expect(error.providerCode).toBe("missing_result");
  });

  it("normalizes an unsuccessful result exactly like generate", async () => {
    const error = await streamError([
      '{"type":"result","subtype":"error_max_turns","result":"turn limit reached"}',
    ]);

    expect(error.code).toBe("api_error");
    expect(error.providerCode).toBe("error_max_turns");
    expect(error.message).toBe("turn limit reached");
  });

  it("normalizes a non-zero exit", async () => {
    const error = await streamError([delta("hi")], {
      exitCode: 17,
      stderr: "authentication failed\n",
    });

    expect(error.code).toBe("process_failed");
    expect(error.status).toBe(17);
    expect(error.message).toBe("authentication failed");
  });

  it("normalizes a missing executable", async () => {
    const error = await streamError(
      [],
      {},
      Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
    );

    expect(error.code).toBe("executable_not_found");
  });

  it("propagates a caller abort unwrapped mid-stream", async () => {
    const controller = new AbortController();
    const reason = new Error("caller aborted");
    const runner: StreamingCommandRunner = async function* (_command, signal) {
      yield { type: "line", line: delta("Hello, ") };
      controller.abort(reason);
      throw signal?.reason;
    };
    const backend = createClaudeCliBackend(config, spawnRunner, runner);

    await expect(collect(backend.generateStream(request, controller.signal))).rejects.toBe(reason);
  });
});
