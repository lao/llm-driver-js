import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  Command,
  CommandChunk,
  CommandResult,
  CommandRunner,
  StreamingCommandRunner,
} from "../src/backends/cli.js";
import { createOpencodeCliBackend } from "../src/backends/opencode-cli.js";
import { type ErrorCode, LLMDriverError } from "../src/errors.js";
import {
  assistant,
  type Config,
  type ContentBlock,
  type Request,
  type StreamEvent,
  user,
} from "../src/types.js";

const config: Config = { provider: "opencode", flavor: "cli", model: "anthropic/claude-test" };
const request: Request = { maxTokens: 32, messages: [user("Hello")] };
const baseArgs = ["run", "--format", "json"];

const successStdout = [
  '{"type":"step_start","sessionID":"ses_1"}',
  '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"ok"}}',
  '{"type":"step_finish","sessionID":"ses_1","part":{"reason":"stop","tokens":{"input":19,"output":7,"reasoning":3,"cache":{"read":11,"write":5}}}}',
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

/** A buffered runner that fails the test if a streaming test accidentally drives generate(). */
const neverSpawn: CommandRunner = () => {
  throw new Error("buffered runner must not be used in streaming tests");
};

function fakeStreamRunner(chunks: CommandChunk[], error?: unknown) {
  const calls: Array<{ command: Command; signal?: AbortSignal }> = [];
  const streamRunner: StreamingCommandRunner = async function* (command, signal) {
    calls.push({ command, signal });
    if (error !== undefined) throw error;
    for (const chunk of chunks) yield chunk;
    yield { type: "exit", exitCode: 0, stderr: "" } as const;
  };
  return { streamRunner, calls };
}

/** Emits canned stdout lines, then a clean exit; never spawns a process. */
function stubStreamRunner(lines: string[], exitCode = 0, stderr = ""): StreamingCommandRunner {
  return async function* () {
    for (const line of lines) yield { type: "line", line } as const;
    yield { type: "exit", exitCode, stderr } as const;
  };
}

async function generateError(
  result: Partial<CommandResult>,
  error?: unknown,
): Promise<LLMDriverError> {
  const { runner } = fakeRunner(result, error);
  try {
    await createOpencodeCliBackend(config, runner).generate(request);
  } catch (caught) {
    expect(caught).toBeInstanceOf(LLMDriverError);
    return caught as LLMDriverError;
  }
  throw new Error("generate() resolved, want a failure");
}

describe("opencode cli command", () => {
  it("builds the default argv and sends a lone user message raw", async () => {
    const { runner, calls } = fakeRunner({ stdout: successStdout });
    const signal = new AbortController().signal;

    await createOpencodeCliBackend(config, runner).generate(request, signal);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toEqual({
      executable: "opencode",
      args: [...baseArgs, "--model", "anthropic/claude-test", "--", "Hello"],
      stdin: "",
    });
    expect(calls[0]?.signal).toBe(signal);
  });

  it("carries a system instruction as inline-config instructions, not prompt text", async () => {
    let args: string[] = [];
    let instructionPath = "";
    let instructionContents = "";
    const runner: CommandRunner = async (command) => {
      args = command.args;
      const config = JSON.parse(command.env?.OPENCODE_CONFIG_CONTENT as string) as {
        instructions?: string[];
      };
      instructionPath = config.instructions?.[0] as string;
      instructionContents = readFileSync(instructionPath, "utf8");
      return { stdout: successStdout, stderr: "", exitCode: 0 };
    };

    await createOpencodeCliBackend(config, runner).generate({
      system: "Be concise.",
      maxTokens: 32,
      messages: [user("First"), assistant("Second"), user("Third")],
    });

    expect(instructionContents).toBe("Be concise.");
    // The transcript is user/assistant turns only; the system text is privileged.
    expect(args.at(-1)).toBe("User: First\n\nAssistant: Second\n\nUser: Third");
    expect(instructionPath).not.toBe("");
    expect(existsSync(instructionPath)).toBe(false);
  });

  it("passes reasoning.effort as --variant", async () => {
    const { runner, calls } = fakeRunner({ stdout: successStdout });
    const backend = createOpencodeCliBackend({ ...config, cliArgs: ["--agent", "build"] }, runner);

    await backend.generate({ ...request, reasoning: { effort: "low" } });

    expect(calls[0]?.command.args).toEqual([
      ...baseArgs,
      "--model",
      "anthropic/claude-test",
      "--thinking",
      "--variant",
      "low",
      "--agent",
      "build",
      "--",
      "Hello",
    ]);
  });

  it("omits the variant and thinking when the request has no reasoning", async () => {
    const { runner, calls } = fakeRunner({ stdout: successStdout });

    await createOpencodeCliBackend(config, runner).generate(request);

    expect(calls[0]?.command.args).toEqual([
      ...baseArgs,
      "--model",
      "anthropic/claude-test",
      "--",
      "Hello",
    ]);
  });

  it("uses cliPath when provided", async () => {
    const { runner, calls } = fakeRunner({ stdout: successStdout });

    await createOpencodeCliBackend({ ...config, cliPath: "/opt/bin/oc" }, runner).generate(request);

    expect(calls[0]?.command.executable).toBe("/opt/bin/oc");
  });
});

describe("opencode cli parsing", () => {
  it("keeps the last step text, sums usage, and maps the terminal reason", async () => {
    const { runner } = fakeRunner({
      stdout: [
        '{"type":"step_start","sessionID":"ses_9"}',
        '{"type":"reasoning","sessionID":"ses_9","part":{"type":"reasoning","text":"think"}}',
        '{"type":"text","sessionID":"ses_9","part":{"type":"text","text":"intermediate"}}',
        '{"type":"step_finish","sessionID":"ses_9","part":{"reason":"tool-calls","tokens":{"input":10,"output":5,"reasoning":1,"cache":{"read":3,"write":2}}}}',
        '{"type":"step_start","sessionID":"ses_9"}',
        '{"type":"text","sessionID":"ses_9","part":{"type":"text","text":"Final answer"}}',
        '{"type":"step_finish","sessionID":"ses_9","part":{"reason":"stop","tokens":{"input":4,"output":2,"reasoning":1,"cache":{"read":1,"write":1}}}}',
        "",
      ].join("\n"),
    });

    const response = await createOpencodeCliBackend(config, runner).generate(request);

    expect(response).toEqual({
      id: "ses_9",
      model: "anthropic/claude-test",
      text: "Final answer",
      usage: {
        inputTokens: 14,
        outputTokens: 7,
        cachedInputTokens: 4,
        cacheCreationInputTokens: 3,
        reasoningTokens: 2,
      },
      completionReason: "stop",
      provider: "opencode",
      flavor: "cli",
      toolCalls: [],
    });
  });

  it("maps a length stop reason to max_tokens", async () => {
    const { runner } = fakeRunner({
      stdout: [
        '{"type":"text","sessionID":"s","part":{"type":"text","text":"partial"}}',
        '{"type":"step_finish","sessionID":"s","part":{"reason":"length","tokens":{"input":1,"output":1}}}',
      ].join("\n"),
    });

    const response = await createOpencodeCliBackend(config, runner).generate(request);

    expect(response.completionReason).toBe("max_tokens");
  });

  it("concatenates multiple text parts within a step", async () => {
    const { runner } = fakeRunner({
      stdout: [
        '{"type":"text","sessionID":"s","part":{"type":"text","text":"Hello, "}}',
        '{"type":"text","sessionID":"s","part":{"type":"text","text":"world"}}',
        '{"type":"step_finish","sessionID":"s","part":{"reason":"stop","tokens":{}}}',
      ].join("\n"),
    });

    const response = await createOpencodeCliBackend(config, runner).generate(request);

    expect(response.text).toBe("Hello, world");
    expect(response.id).toBe("s");
  });

  it("returns accumulated text when a successful run omits the final step_finish", async () => {
    // Upstream race: `opencode run --format json` can exit 0 after streaming text
    // but before the terminal `step_finish`, so the answer must not be discarded.
    const { runner } = fakeRunner({
      stdout: '{"type":"text","sessionID":"s","part":{"type":"text","text":"orphan"}}\n',
    });

    const response = await createOpencodeCliBackend(config, runner).generate(request);

    expect(response).toEqual({
      id: "s",
      model: "anthropic/claude-test",
      text: "orphan",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
      },
      completionReason: "",
      provider: "opencode",
      flavor: "cli",
      toolCalls: [],
    });
  });

  const orphanText = '{"type":"text","sessionID":"s","part":{"type":"text","text":"orphan"}}\n';
  const usageExport = JSON.stringify({
    info: { id: "s" },
    messages: [
      { info: { role: "user" }, parts: [] },
      {
        info: {
          role: "assistant",
          tokens: { input: 20, output: 7, reasoning: 2, cache: { read: 5, write: 3 } },
        },
        parts: [],
      },
    ],
  });

  it("recovers usage from the session export when the terminal step_finish is lost", async () => {
    const runner: CommandRunner = async (command) =>
      command.args[0] === "export"
        ? { stdout: usageExport, stderr: "", exitCode: 0 }
        : { stdout: orphanText, stderr: "", exitCode: 0 };

    const response = await createOpencodeCliBackend(config, runner).generate(request);

    expect(response.usage).toEqual({
      inputTokens: 20,
      outputTokens: 7,
      cachedInputTokens: 5,
      cacheCreationInputTokens: 3,
      reasoningTokens: 2,
    });
    expect(response.text).toBe("orphan");
  });

  it("fails when a successful run emits no usable event", async () => {
    const runner: CommandRunner = async (command) => ({
      stdout: command.args[0] === "export" ? "" : '{"type":"session","sessionID":"s"}\n',
      stderr: "",
      exitCode: 0,
    });

    const error = await createOpencodeCliBackend(config, runner)
      .generate(request)
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(LLMDriverError);
    expect((error as LLMDriverError).code).toBe("parse_failed");
    expect((error as LLMDriverError).providerCode).toBe("missing_result");
  });
});

describe("opencode cli failures", () => {
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
      error: Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" }),
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
      name: "non-zero exit with no reported event",
      result: { stdout: successStdout, stderr: "not authenticated\n", exitCode: 9 },
      code: "process_failed",
      status: 9,
      message: "not authenticated",
    },
    {
      name: "non-zero exit with a reported error event",
      result: {
        stdout: '{"type":"error","error":{"_tag":"BadRequest"}}\n',
        stderr: "opencode exited",
        exitCode: 9,
      },
      code: "api_error",
      status: 9,
      providerCode: "BadRequest",
      message: "OpenCode run failed",
    },
    {
      name: "malformed JSONL",
      result: { stdout: '{"type":"step_start"}\nnot-json\n' },
      code: "parse_failed",
    },
    {
      name: "a JSONL line that is not an object",
      result: { stdout: "[1,2]\n" },
      code: "parse_failed",
    },
    {
      name: "error event with a message",
      result: {
        stdout: '{"type":"error","error":{"name":"ProviderError","message":"model exploded"}}\n',
      },
      code: "api_error",
      providerCode: "ProviderError",
      message: "model exploded",
    },
  ];

  for (const testCase of cases) {
    it(`normalizes ${testCase.name}`, async () => {
      const error = await generateError(testCase.result, testCase.error);

      expect(error.code).toBe(testCase.code);
      expect(error.status).toBe(testCase.status);
      expect(error.providerCode).toBe(testCase.providerCode);
      expect(error.provider).toBe("opencode");
      expect(error.flavor).toBe("cli");
      expect(error.operation).toBe("generate");
      if (testCase.message !== undefined) {
        expect(error.message).toBe(testCase.message);
      }
    });
  }

  it("reports the offending line number for malformed JSONL", async () => {
    const error = await generateError({ stdout: '{"type":"step_start"}\nnot-json\n' });

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
      createOpencodeCliBackend(config, runner).generate(request, controller.signal),
    ).rejects.toBe(reason);
  });
});

// ── Image input (base64 temp files + -f) ─────────────────────────────────────

/** Pulls the `-f <path>` arguments out of a built command, in order. */
function imagePaths(command: Command): string[] {
  const paths: string[] = [];
  command.args.forEach((arg, index) => {
    if (arg === "-f") paths.push(command.args[index + 1] as string);
  });
  return paths;
}

function imageBlock(base64: string, mediaType: string): ContentBlock {
  return { type: "image", source: { base64, mediaType: mediaType as never } };
}

function stagingRunner(result: Partial<CommandResult> = {}) {
  const seen = {
    command: undefined as Command | undefined,
    paths: [] as string[],
    existedDuringRun: [] as boolean[],
    contents: [] as string[],
  };
  const runner: CommandRunner = async (command) => {
    seen.command = command;
    seen.paths = imagePaths(command);
    seen.existedDuringRun = seen.paths.map((path) => existsSync(path));
    seen.contents = seen.paths.map((path) => (existsSync(path) ? readFileSync(path, "utf8") : ""));
    return { stdout: successStdout, stderr: "", exitCode: 0, ...result };
  };
  return { runner, seen };
}

describe("opencode cli image input", () => {
  const pngB64 = Buffer.from("fake-png-bytes").toString("base64");
  const jpgB64 = Buffer.from("fake-jpg-bytes").toString("base64");

  it("writes one temp file per image and passes each via -f, then cleans up", async () => {
    const { runner, seen } = stagingRunner();
    const request: Request = {
      maxTokens: 32,
      messages: [
        user([
          imageBlock(pngB64, "image/png"),
          imageBlock(jpgB64, "image/jpeg"),
          { type: "text", text: "describe" },
        ]),
      ],
    };

    await createOpencodeCliBackend(config, runner).generate(request);

    expect(seen.paths).toHaveLength(2);
    expect(seen.paths[0]).toMatch(/image-0\.png$/);
    expect(seen.paths[1]).toMatch(/image-1\.jpg$/);
    expect(seen.command?.args).toEqual([
      ...baseArgs,
      "--model",
      "anthropic/claude-test",
      "-f",
      seen.paths[0],
      "-f",
      seen.paths[1],
      "--",
      "describe",
    ]);
    expect(seen.existedDuringRun).toEqual([true, true]);
    expect(seen.contents).toEqual(["fake-png-bytes", "fake-jpg-bytes"]);
    for (const path of seen.paths) expect(existsSync(path)).toBe(false);
  });

  it("cleans up temp files after a process failure", async () => {
    const { runner, seen } = stagingRunner({ stdout: "", stderr: "boom", exitCode: 9 });
    const request: Request = {
      maxTokens: 32,
      messages: [user([imageBlock(pngB64, "image/png")])],
    };

    await expect(createOpencodeCliBackend(config, runner).generate(request)).rejects.toBeInstanceOf(
      LLMDriverError,
    );

    expect(seen.existedDuringRun).toEqual([true]);
    for (const path of seen.paths) expect(existsSync(path)).toBe(false);
  });

  it("rejects a URL-source image as unsupported_feature without spawning", async () => {
    const { runner, calls } = fakeRunner({ stdout: successStdout });
    const request: Request = {
      maxTokens: 32,
      messages: [user([{ type: "image", source: { url: "https://example.test/cat.png" } }])],
    };

    const error = await createOpencodeCliBackend(config, runner)
      .generate(request)
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(LLMDriverError);
    expect((error as LLMDriverError).code).toBe("unsupported_feature");
    expect((error as LLMDriverError).message).toContain("URL-source images");
    expect((error as LLMDriverError).message).toContain("opencode/cli");
    expect(calls).toHaveLength(0);
  });

  it("rejects an image outside the final user message as unsupported_feature", async () => {
    const { runner, calls } = fakeRunner({ stdout: successStdout });
    const request: Request = {
      maxTokens: 32,
      messages: [user([imageBlock(pngB64, "image/png")]), assistant("ack"), user("and now?")],
    };

    const error = await createOpencodeCliBackend(config, runner)
      .generate(request)
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(LLMDriverError);
    expect((error as LLMDriverError).code).toBe("unsupported_feature");
    expect((error as LLMDriverError).message).toContain("final user message");
    expect(calls).toHaveLength(0);
  });
});

// ── Streaming ────────────────────────────────────────────────────────────────

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const seen: StreamEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe("opencode cli streaming", () => {
  const successStream = successStdout.split("\n").filter((line) => line !== "");

  it("streams text and reasoning in source order, then the done response", async () => {
    const streamRunner = stubStreamRunner([
      '{"type":"step_start","sessionID":"ses_s"}',
      '{"type":"reasoning","sessionID":"ses_s","part":{"type":"reasoning","text":"Think"}}',
      '{"type":"reasoning","sessionID":"ses_s","part":{"type":"reasoning","text":"ing"}}',
      '{"type":"text","sessionID":"ses_s","part":{"type":"text","text":"Hello, "}}',
      '{"type":"reasoning","sessionID":"ses_s","part":{"type":"reasoning","text":"more"}}',
      '{"type":"text","sessionID":"ses_s","part":{"type":"text","text":"world"}}',
      '{"type":"step_finish","sessionID":"ses_s","part":{"reason":"stop","tokens":{"input":10,"output":5,"cache":{"read":3,"write":2}}}}',
    ]);
    const backend = createOpencodeCliBackend(config, neverSpawn, streamRunner);

    const events = await collect(backend.generateStream(request));

    expect(events).toEqual([
      { type: "reasoning", text: "Think" },
      { type: "reasoning", text: "ing" },
      { type: "text", text: "Hello, " },
      { type: "reasoning", text: "more" },
      { type: "text", text: "world" },
      {
        type: "done",
        response: {
          id: "ses_s",
          model: "anthropic/claude-test",
          text: "Hello, world",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedInputTokens: 3,
            cacheCreationInputTokens: 2,
            reasoningTokens: 0,
          },
          completionReason: "stop",
          provider: "opencode",
          flavor: "cli",
          toolCalls: [],
        },
      },
    ]);
  });

  it("reuses the generate argv and forwards the signal", async () => {
    const { streamRunner, calls } = fakeStreamRunner(
      successStream.map((line) => ({ type: "line" as const, line })),
    );
    const signal = new AbortController().signal;

    await collect(
      createOpencodeCliBackend(config, neverSpawn, streamRunner).generateStream(request, signal),
    );

    expect(calls[0]?.command).toEqual({
      executable: "opencode",
      args: [...baseArgs, "--model", "anthropic/claude-test", "--", "Hello"],
      stdin: "",
    });
    expect(calls[0]?.signal).toBe(signal);
  });

  it("ignores unrecognized event types", async () => {
    const streamRunner = stubStreamRunner([
      '{"type":"session","sessionID":"s"}',
      '{"type":"text","sessionID":"s","part":{"type":"text","text":"ok"}}',
      '{"type":"step_finish","sessionID":"s","part":{"reason":"stop","tokens":{}}}',
    ]);

    const events = await collect(
      createOpencodeCliBackend(config, neverSpawn, streamRunner).generateStream(request),
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text", text: "ok" });
    expect(events[1]).toMatchObject({ type: "done", response: { text: "ok" } });
  });

  it("emits no reasoning events when the stream has none", async () => {
    const events = await collect(
      createOpencodeCliBackend(config, neverSpawn, stubStreamRunner(successStream)).generateStream(
        request,
      ),
    );

    expect(events.some((event) => event.type === "reasoning")).toBe(false);
  });

  it("propagates a caller abort unwrapped mid-stream", async () => {
    const controller = new AbortController();
    const reason = new Error("caller aborted");
    // biome-ignore lint/correctness/useYield: aborting before any output is the case.
    const streamRunner: StreamingCommandRunner = async function* (_command, signal) {
      controller.abort(reason);
      throw signal?.reason;
    };

    await expect(
      collect(
        createOpencodeCliBackend(config, neverSpawn, streamRunner).generateStream(
          request,
          controller.signal,
        ),
      ),
    ).rejects.toBe(reason);
  });

  it("throws the reported error event from the stream", async () => {
    const streamRunner = stubStreamRunner(['{"type":"error","error":{"_tag":"BadRequest"}}']);

    const error = await collect(
      createOpencodeCliBackend(config, neverSpawn, streamRunner).generateStream(request),
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(LLMDriverError);
    expect((error as LLMDriverError).code).toBe("api_error");
    expect((error as LLMDriverError).providerCode).toBe("BadRequest");
  });

  it("returns accumulated text when the stream never completes a step", async () => {
    const streamRunner = stubStreamRunner([
      '{"type":"text","sessionID":"s","part":{"type":"text","text":"orphan"}}',
    ]);

    const events = await collect(
      createOpencodeCliBackend(config, neverSpawn, streamRunner).generateStream(request),
    );

    expect(events).toEqual([
      { type: "text", text: "orphan" },
      {
        type: "done",
        response: {
          id: "s",
          model: "anthropic/claude-test",
          text: "orphan",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0,
            reasoningTokens: 0,
          },
          completionReason: "",
          provider: "opencode",
          flavor: "cli",
          toolCalls: [],
        },
      },
    ]);
  });

  it("returns the last open step's text when a later step never finishes", async () => {
    const streamRunner = stubStreamRunner([
      '{"type":"text","sessionID":"s","part":{"type":"text","text":"first"}}',
      '{"type":"step_finish","sessionID":"s","part":{"reason":"tool-calls","tokens":{}}}',
      '{"type":"step_start","sessionID":"s"}',
      '{"type":"text","sessionID":"s","part":{"type":"text","text":"second"}}',
    ]);

    const events = await collect(
      createOpencodeCliBackend(config, neverSpawn, streamRunner).generateStream(request),
    );

    expect(events.at(-1)).toMatchObject({
      type: "done",
      response: { text: "second", id: "s", completionReason: "" },
    });
  });

  it("recovers usage from the session export when the stream loses the final step_finish", async () => {
    const exportJson = JSON.stringify({
      info: { id: "s" },
      messages: [
        {
          info: {
            role: "assistant",
            tokens: { input: 11, output: 4, reasoning: 1, cache: { read: 2, write: 1 } },
          },
          parts: [],
        },
      ],
    });
    const streamRunner: StreamingCommandRunner = async function* (command) {
      const lines =
        command.args[0] === "export"
          ? [exportJson]
          : ['{"type":"text","sessionID":"s","part":{"type":"text","text":"orphan"}}'];
      for (const line of lines) yield { type: "line", line };
      yield { type: "exit", exitCode: 0, stderr: "" };
    };

    const events = await collect(
      createOpencodeCliBackend(config, neverSpawn, streamRunner).generateStream(request),
    );

    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected a done event");
    expect(done.response.usage).toEqual({
      inputTokens: 11,
      outputTokens: 4,
      cachedInputTokens: 2,
      cacheCreationInputTokens: 1,
      reasoningTokens: 1,
    });
  });

  it("fails when the stream emits no usable event", async () => {
    const streamRunner = stubStreamRunner(['{"type":"session","sessionID":"s"}']);

    const error = await collect(
      createOpencodeCliBackend(config, neverSpawn, streamRunner).generateStream(request),
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(LLMDriverError);
    expect((error as LLMDriverError).code).toBe("parse_failed");
  });
});

// ── Tools via the MCP bridge ─────────────────────────────────────────────────

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
  ],
};

const toolsStdout = [
  '{"type":"step_start","sessionID":"ses_t"}',
  '{"type":"text","sessionID":"ses_t","part":{"type":"text","text":"the sum is 3"}}',
  '{"type":"step_finish","sessionID":"ses_t","part":{"reason":"stop","tokens":{}}}',
  "",
].join("\n");

/** Reads the bridge URL the adapter wrote into `OPENCODE_CONFIG_CONTENT`. */
function bridgeUrl(command: Command): string {
  const content = command.env?.OPENCODE_CONFIG_CONTENT;
  if (!content) throw new Error("missing OPENCODE_CONFIG_CONTENT");
  const config = JSON.parse(content) as { mcp: Record<string, { url?: string }> };
  const bridge = Object.values(config.mcp).find((server) => typeof server.url === "string");
  if (!bridge?.url) throw new Error("missing remote bridge in OPENCODE_CONFIG_CONTENT");
  return bridge.url;
}

/** One JSON-RPC call to the live bridge; rejects if the bridge is closed. */
async function rpc(url: string, method: string, params?: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("opencode cli tools config", () => {
  it("passes the bridge through OPENCODE_CONFIG_CONTENT (remote, no oauth)", async () => {
    const { runner, calls } = fakeRunner({ stdout: toolsStdout });

    await createOpencodeCliBackend(config, runner).generate(toolsRequest);

    const content = calls[0]?.command.env?.OPENCODE_CONFIG_CONTENT;
    expect(content).toBeDefined();
    const parsed = JSON.parse(content as string) as {
      mcp: { llmdriver: { type: string; url: string; oauth: boolean } };
    };
    expect(parsed.mcp.llmdriver.type).toBe("remote");
    expect(parsed.mcp.llmdriver.oauth).toBe(false);
    expect(parsed.mcp.llmdriver.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f-]{36}$/);
  });

  it("sets no env when the request carries no tools", async () => {
    const { runner, calls } = fakeRunner({ stdout: successStdout });

    await createOpencodeCliBackend(config, runner).generate(request);

    expect(calls[0]?.command.env).toBeUndefined();
  });

  it("merges an inherited OPENCODE_CONFIG_CONTENT instead of replacing it", async () => {
    const { runner, calls } = fakeRunner({ stdout: toolsStdout });
    const inherited = {
      model: "anthropic/claude-sonnet-4-5",
      mcp: { other: { type: "local", command: ["node", "server.js"] } },
    };
    const previous = process.env.OPENCODE_CONFIG_CONTENT;
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(inherited);
    try {
      await createOpencodeCliBackend(config, runner).generate(toolsRequest);

      const parsed = JSON.parse(calls[0]?.command.env?.OPENCODE_CONFIG_CONTENT as string) as Record<
        string,
        unknown
      > & {
        mcp: Record<string, { type: string; oauth?: boolean; command?: string[] }>;
      };
      expect(parsed.model).toBe("anthropic/claude-sonnet-4-5");
      expect(parsed.mcp.other).toEqual({ type: "local", command: ["node", "server.js"] });
      expect(parsed.mcp.llmdriver?.type).toBe("remote");
      expect(parsed.mcp.llmdriver?.oauth).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = previous;
    }
  });

  it("does not overwrite a caller-defined mcp server named llmdriver", async () => {
    const { runner, calls } = fakeRunner({ stdout: toolsStdout });
    const inherited = {
      mcp: { llmdriver: { type: "remote", url: "https://caller.example/mcp" } },
    };
    const previous = process.env.OPENCODE_CONFIG_CONTENT;
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(inherited);
    try {
      await createOpencodeCliBackend(config, runner).generate(toolsRequest);

      const parsed = JSON.parse(calls[0]?.command.env?.OPENCODE_CONFIG_CONTENT as string) as {
        mcp: Record<string, { type: string; url: string; oauth?: boolean }>;
      };
      // The caller's own `llmdriver` server survives untouched...
      expect(parsed.mcp.llmdriver).toEqual({
        type: "remote",
        url: "https://caller.example/mcp",
      });
      // ...and the bridge lands under a fresh key it cannot collide with.
      expect(parsed.mcp["llmdriver-2"]).toMatchObject({ type: "remote", oauth: false });
      expect(parsed.mcp["llmdriver-2"]?.url).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f-]{36}$/,
      );
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = previous;
    }
  });
});

describe("opencode cli tools bridge lifecycle", () => {
  it("keeps the bridge reachable during the run, then closes it on resolve", async () => {
    let url = "";
    let statusDuringRun = 0;
    const runner: CommandRunner = async (command) => {
      url = bridgeUrl(command);
      statusDuringRun = (await rpc(url, "tools/list")).status;
      return { stdout: toolsStdout, stderr: "", exitCode: 0 };
    };

    await createOpencodeCliBackend(config, runner).generate(toolsRequest);

    expect(statusDuringRun).toBe(200);
    await expect(rpc(url, "tools/list")).rejects.toThrow();
  });

  it("closes the bridge when the run fails", async () => {
    let url = "";
    const runner: CommandRunner = async (command) => {
      url = bridgeUrl(command);
      return { stdout: "", stderr: "boom\n", exitCode: 1 };
    };

    await expect(
      createOpencodeCliBackend(config, runner).generate(toolsRequest),
    ).rejects.toBeInstanceOf(LLMDriverError);
    await expect(rpc(url, "tools/list")).rejects.toThrow();
  });

  it("closes the bridge when the stream consumer breaks early", async () => {
    let url = "";
    const streamRunner: StreamingCommandRunner = async function* (command) {
      url = bridgeUrl(command);
      for (const line of toolsStdout.split("\n").filter((line) => line !== "")) {
        yield { type: "line", line } as const;
      }
      yield { type: "exit", exitCode: 0, stderr: "" } as const;
    };
    const backend = createOpencodeCliBackend(config, neverSpawn, streamRunner);

    for await (const _event of backend.generateStream(toolsRequest)) break;

    expect(url).not.toBe("");
    await expect(rpc(url, "tools/list")).rejects.toThrow();
  });

  it("surfaces a failed run instead of draining a stuck tool handler", async () => {
    // The timeout killed the CLI, but an MCP handler ignores cancellation and
    // never resolves; generate() must not wait on the bridge forever.
    let started: () => void = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stuckRequest: Request = {
      ...toolsRequest,
      tools: [
        {
          name: "add",
          description: "adds two numbers",
          inputSchema: { type: "object" },
          execute: () => {
            started();
            return new Promise<string>(() => {});
          },
        },
      ],
    };
    const runner: CommandRunner = async (command) => {
      // Fire the call but never await it: the handler hangs.
      void rpc(bridgeUrl(command), "tools/call", { name: "add", arguments: {} }).catch(() => {});
      await startedPromise;
      return { stdout: "", stderr: "timed out\n", exitCode: 124 };
    };

    await expect(
      createOpencodeCliBackend(config, runner).generate(stuckRequest),
    ).rejects.toBeInstanceOf(LLMDriverError);
  });
});

describe("opencode cli tools round-trip", () => {
  it("populates response.toolCalls from a mid-turn tool call (generate)", async () => {
    const runner: CommandRunner = async (command) => {
      await rpc(bridgeUrl(command), "tools/call", { name: "add", arguments: { a: 1, b: 2 } });
      return { stdout: toolsStdout, stderr: "", exitCode: 0 };
    };

    const response = await createOpencodeCliBackend(config, runner).generate(toolsRequest);

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
    // The stream path drives `streamRunner`, so it plays both the CLI output and
    // the mid-turn bridge call.
    const streamRunner: StreamingCommandRunner = async function* (command) {
      await rpc(bridgeUrl(command), "tools/call", { name: "add", arguments: { a: 1, b: 2 } });
      for (const line of toolsStdout.split("\n").filter((line) => line !== "")) {
        yield { type: "line", line };
      }
      yield { type: "exit", exitCode: 0, stderr: "" };
    };

    const events = await collect(
      createOpencodeCliBackend(config, neverSpawn, streamRunner).generateStream(toolsRequest),
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
    expect(done.response.toolCalls).toHaveLength(1);
  });
});
