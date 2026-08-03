import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type Command,
  type CommandChunk,
  type CommandRunner,
  createBoundedCapture,
  executeCli,
  readCount,
  renderTranscript,
  type StreamingCommandRunner,
  spawnRunner,
  spawnStreamRunner,
  streamCli,
} from "../src/backends/cli.js";
import { LLMWrapperError } from "../src/errors.js";
import { assistant, user } from "../src/types.js";

const command: Command = { executable: "claude", args: ["-p"], stdin: "Hello" };

function failingRunner(error: unknown): CommandRunner {
  return async () => {
    throw error;
  };
}

function resultRunner(result: Partial<Awaited<ReturnType<CommandRunner>>>): CommandRunner {
  return async () => ({ stdout: "", stderr: "", exitCode: 0, ...result });
}

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
}

/** `0` until the spawned process has recorded its grandchild's pid. */
function readPid(file: string): number {
  try {
    return Number(readFileSync(file, "utf8")) || 0;
  } catch {
    return 0;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every temp dir is tracked and removed after the file runs, pass or fail. */
const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "llmwrapper-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Child script fragments: record the pid, then outlive anything but a SIGKILL. */
const RECORD_PID = "require('node:fs').writeFileSync(process.env.PID_FILE, String(process.pid));";
const LIVE_FOREVER = "setInterval(() => {}, 1000)";

/** Host statement: exit as soon as the child has recorded its pid. */
const EXIT_ONCE_SPAWNED = [
  "const poll = setInterval(() => {",
  "  if (existsSync(process.env.PID_FILE)) { clearInterval(poll); process.exit(0); }",
  "}, 50);",
].join("\n");

/**
 * Runs a host process that starts a run via `start` — statements using the
 * in-scope `command`, and responsible for exiting the host — against a `child`
 * script. Only the exit handler can stop the detached child from outliving the
 * host. Returns the child's pid.
 */
async function hostExitsMidRun(child: string, start: string): Promise<number> {
  const dir = tempDir();
  const pidFile = join(dir, "child.pid");
  const script = join(dir, "host.ts");
  const cliModule = join(import.meta.dirname, "..", "src", "backends", "cli.ts");
  // PID_FILE is inherited, so neither script has to quote a path inside a
  // quoted script.
  writeFileSync(
    script,
    [
      'import { existsSync } from "node:fs";',
      `import { spawnRunner, spawnStreamRunner } from ${JSON.stringify(cliModule)};`,
      `const child = ${JSON.stringify(child)};`,
      'const command = { executable: process.execPath, args: ["-e", child], stdin: "" };',
      start,
    ].join("\n"),
  );

  await new Promise<void>((resolve, reject) => {
    const host = spawn(process.execPath, ["--import", "tsx/esm", script], {
      // so `tsx/esm` resolves out of this package's node_modules
      cwd: join(import.meta.dirname, ".."),
      env: { ...process.env, PID_FILE: pidFile },
      stdio: "ignore",
    });
    host.on("error", reject);
    host.on("exit", () => resolve());
  });

  return readPid(pidFile);
}

/** Asserts the pid dies, and never leaks it if the cleanup under test failed. */
async function expectReaped(pid: number): Promise<void> {
  expect(pid).toBeGreaterThan(0);
  try {
    await expect.poll(() => isRunning(pid), { timeout: 5000 }).toBe(false);
  } finally {
    if (isRunning(pid)) process.kill(pid, "SIGKILL");
  }
}

describe("renderTranscript", () => {
  it("sends a lone user message as raw text", () => {
    expect(renderTranscript([user("Hello from stdin")])).toBe("Hello from stdin");
  });

  it("renders a multi-turn transcript as labelled blocks", () => {
    expect(
      renderTranscript([user("First question"), assistant("First answer"), user("Follow-up")]),
    ).toBe("User: First question\n\nAssistant: First answer\n\nUser: Follow-up");
  });

  it("labels a lone assistant message", () => {
    expect(renderTranscript([assistant("Only turn")])).toBe("Assistant: Only turn");
  });
});

describe("createBoundedCapture", () => {
  it("truncates at the limit and reports the overflow", () => {
    const capture = createBoundedCapture(4);
    expect(capture.push(Buffer.from("12"))).toBe(true);
    expect(capture.push(Buffer.from("3456"))).toBe(false);
    expect(capture.overflowed()).toBe(true);
    expect(capture.text()).toBe("1234");
  });
});

describe("readCount", () => {
  it("reads a non-negative integer", () => {
    expect(readCount({ tokens: 0 }, "tokens")).toBe(0);
    expect(readCount({ tokens: 42 }, "tokens")).toBe(42);
  });

  it("treats anything else as zero", () => {
    for (const tokens of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "7", null, undefined]) {
      expect(readCount({ tokens }, "tokens")).toBe(0);
    }
    expect(readCount({}, "tokens")).toBe(0);
  });
});

describe("executeCli", () => {
  it("returns stdout and forwards the command and signal to the runner", async () => {
    const seen: Array<{ command: Command; signal?: AbortSignal }> = [];
    const signal = new AbortController().signal;
    const runner: CommandRunner = async (received, receivedSignal) => {
      seen.push({ command: received, signal: receivedSignal });
      return { stdout: "payload", stderr: "", exitCode: 0 };
    };

    const outcome = await executeCli("claude", command, runner, signal);

    expect(outcome).toEqual({ stdout: "payload" });
    expect(seen).toEqual([{ command, signal }]);
  });

  it("maps a missing executable to executable_not_found", async () => {
    const { failure } = await executeCli("claude", command, failingRunner(enoent()));

    expect(failure).toBeInstanceOf(LLMWrapperError);
    expect(failure?.code).toBe("executable_not_found");
    expect(failure?.message).toContain("claude");
    expect(failure?.provider).toBe("claude");
    expect(failure?.flavor).toBe("cli");
    expect(failure?.operation).toBe("generate");
  });

  it("maps any other launch failure to process_failed", async () => {
    const cause = new Error("launch failed");

    const { failure } = await executeCli("openai", command, failingRunner(cause));

    expect(failure?.code).toBe("process_failed");
    expect(failure?.message).toBe("launch failed");
    expect(failure?.status).toBeUndefined();
    expect(failure?.cause).toBe(cause);
  });

  it("maps a non-zero exit to process_failed with the exit code and stderr", async () => {
    const runner = resultRunner({ stdout: "partial", stderr: "  boom\n", exitCode: 17 });

    const { stdout, failure } = await executeCli("claude", command, runner);

    expect(stdout).toBe("partial");
    expect(failure?.code).toBe("process_failed");
    expect(failure?.status).toBe(17);
    expect(failure?.message).toBe("boom");
  });

  it("falls back to a generic message when a failing process writes no stderr", async () => {
    const { failure } = await executeCli("claude", command, resultRunner({ exitCode: 1 }));

    expect(failure?.message).toBe("CLI command failed");
  });

  it("truncates a huge stderr in the process_failed message", async () => {
    const runner = resultRunner({ stderr: "x".repeat(100_000), exitCode: 1 });

    const { failure } = await executeCli("claude", command, runner);

    expect(failure?.message).toBe(`${"x".repeat(4096)}… (truncated)`);
  });

  it("rethrows a caller abort untouched", async () => {
    const controller = new AbortController();
    const reason = new Error("caller aborted");
    const runner: CommandRunner = async (_command, signal) => {
      controller.abort(reason);
      throw signal?.reason;
    };

    await expect(executeCli("claude", command, runner, controller.signal)).rejects.toBe(reason);
  });
});

describe("spawnRunner", () => {
  const node = process.execPath;

  it("pipes stdin, captures both streams, and reports the exit code", async () => {
    const script =
      "let d='';process.stdin.on('data',c=>{d+=c}).on('end',()=>{" +
      "process.stdout.write('in:'+d);process.stderr.write('err');process.exit(3)})";

    const result = await spawnRunner({ executable: node, args: ["-e", script], stdin: "ping" });

    expect(result).toEqual({ stdout: "in:ping", stderr: "err", exitCode: 3 });
  });

  it("reports ENOENT for a missing executable", async () => {
    const missing = { executable: "llmwrapper-command-that-does-not-exist", args: [], stdin: "" };

    await expect(spawnRunner(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an already aborted run without spawning", async () => {
    const controller = new AbortController();
    const reason = new Error("too late");
    controller.abort(reason);

    await expect(
      spawnRunner({ executable: node, args: [], stdin: "" }, controller.signal),
    ).rejects.toBe(reason);
  });

  it.skipIf(process.platform === "win32")(
    "kills grandchildren by signalling the whole process group",
    async () => {
      const pidFile = join(tempDir(), "grandchild.pid");
      const grandchild = "setInterval(()=>{},1000)";
      // Spawns a grandchild — like `claude`/`codex` do — records its pid, stays alive.
      const script =
        "const {spawn}=require('node:child_process');" +
        `const g=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});` +
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));` +
        "setInterval(()=>{},1000)";
      const controller = new AbortController();
      const running = spawnRunner(
        { executable: node, args: ["-e", script], stdin: "" },
        controller.signal,
      );

      await expect.poll(() => readPid(pidFile), { timeout: 2000 }).toBeGreaterThan(0);
      const pid = readPid(pidFile);
      try {
        controller.abort(new Error("cancelled"));
        await expect(running).rejects.toThrow("cancelled");
        await expect.poll(() => isRunning(pid), { timeout: 2000 }).toBe(false);
      } finally {
        // A surviving grandchild is the bug under test; never leak it.
        if (isRunning(pid)) process.kill(pid, "SIGKILL");
      }
    },
    10_000,
  );

  it("resolves when the child exits before reading a multi-megabyte stdin", async () => {
    const result = await spawnRunner({
      executable: node,
      args: ["-e", "process.exit(0)"],
      stdin: "x".repeat(8 << 20),
    });

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  }, 15_000);

  it.skipIf(process.platform === "win32")(
    "settles an aborted run even when an escaped grandchild holds stdout open",
    async () => {
      const pidFile = join(tempDir(), "escapee.pid");
      // `detached` puts the grandchild in its own group, out of reach of the
      // group kill, and it inherits fd 1 so the stdout pipe never closes.
      const script =
        "const {spawn}=require('node:child_process');" +
        "const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)']," +
        "{detached:true,stdio:['ignore',1,'ignore']});g.unref();" +
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));` +
        "setInterval(()=>{},1000)";
      const controller = new AbortController();
      const reason = new Error("cancelled");
      const running = spawnRunner(
        { executable: node, args: ["-e", script], stdin: "" },
        controller.signal,
      );

      await expect.poll(() => readPid(pidFile), { timeout: 5000 }).toBeGreaterThan(0);
      const pid = readPid(pidFile);
      try {
        controller.abort(reason);
        await expect(running).rejects.toBe(reason);
      } finally {
        if (isRunning(pid)) process.kill(pid, "SIGKILL");
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "kills a live detached child when the host process exits",
    async () => {
      await expectReaped(
        await hostExitsMidRun(
          RECORD_PID + LIVE_FOREVER,
          `spawnRunner(command).catch(() => {});\n${EXIT_ONCE_SPAWNED}`,
        ),
      );
    },
    30_000,
  );

  it("escalates to SIGKILL when an aborted child ignores SIGTERM", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const stubborn = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const running = spawnRunner(
      { executable: node, args: ["-e", stubborn], stdin: "" },
      controller.signal,
    );
    setTimeout(() => controller.abort(reason), 150);

    await expect(running).rejects.toBe(reason);
  });
});

describe("streamCli", () => {
  function chunkRunner(chunks: CommandChunk[], error?: unknown): StreamingCommandRunner {
    return async function* () {
      if (error !== undefined) throw error;
      yield* chunks;
    };
  }

  async function collect(lines: AsyncIterable<string>): Promise<string[]> {
    const seen: string[] = [];
    for await (const line of lines) seen.push(line);
    return seen;
  }

  it("yields stdout lines and forwards the command and signal to the runner", async () => {
    const seen: Array<{ command: Command; signal?: AbortSignal }> = [];
    const signal = new AbortController().signal;
    const runner: StreamingCommandRunner = async function* (received, receivedSignal) {
      seen.push({ command: received, signal: receivedSignal });
      yield { type: "line", line: "first" };
      yield { type: "line", line: "second" };
      yield { type: "exit", exitCode: 0, stderr: "" };
    };

    expect(await collect(streamCli("claude", command, runner, signal))).toEqual([
      "first",
      "second",
    ]);
    expect(seen).toEqual([{ command, signal }]);
  });

  it("maps a missing executable to executable_not_found", async () => {
    const lines = streamCli("claude", command, chunkRunner([], enoent()));

    await expect(collect(lines)).rejects.toMatchObject({
      code: "executable_not_found",
      provider: "claude",
      flavor: "cli",
      operation: "generate",
    });
  });

  it("maps any other launch failure to process_failed", async () => {
    const lines = streamCli("openai", command, chunkRunner([], new Error("launch failed")));

    await expect(collect(lines)).rejects.toMatchObject({
      code: "process_failed",
      message: "launch failed",
      status: undefined,
    });
  });

  it("maps a non-zero exit to process_failed after yielding the lines", async () => {
    const seen: string[] = [];
    const lines = streamCli(
      "claude",
      command,
      chunkRunner([
        { type: "line", line: "partial" },
        { type: "exit", exitCode: 17, stderr: "  boom\n" },
      ]),
    );

    await expect(
      (async () => {
        for await (const line of lines) seen.push(line);
      })(),
    ).rejects.toMatchObject({ code: "process_failed", status: 17, message: "boom" });
    expect(seen).toEqual(["partial"]);
  });

  it("truncates a huge stderr in the process_failed message", async () => {
    const lines = streamCli(
      "claude",
      command,
      chunkRunner([{ type: "exit", exitCode: 1, stderr: "x".repeat(100_000) }]),
    );

    await expect(collect(lines)).rejects.toMatchObject({
      message: `${"x".repeat(4096)}… (truncated)`,
    });
  });

  it("falls back to a generic message when a failing process writes no stderr", async () => {
    const lines = streamCli(
      "claude",
      command,
      chunkRunner([{ type: "exit", exitCode: 1, stderr: "" }]),
    );

    await expect(collect(lines)).rejects.toMatchObject({ message: "CLI command failed" });
  });

  it("rethrows a caller abort untouched", async () => {
    const controller = new AbortController();
    const reason = new Error("caller aborted");
    // biome-ignore lint/correctness/useYield: aborting before any output is the case.
    const runner: StreamingCommandRunner = async function* (_command, signal) {
      controller.abort(reason);
      throw signal?.reason;
    };

    await expect(collect(streamCli("claude", command, runner, controller.signal))).rejects.toBe(
      reason,
    );
  });

  it("closes the runner when the consumer breaks early", async () => {
    let closed = false;
    const runner: StreamingCommandRunner = async function* () {
      try {
        yield { type: "line", line: "first" };
        yield { type: "line", line: "second" };
      } finally {
        closed = true;
      }
    };

    for await (const line of streamCli("claude", command, runner)) {
      expect(line).toBe("first");
      break;
    }

    expect(closed).toBe(true);
  });
});

describe("spawnStreamRunner", () => {
  const node = process.execPath;

  async function drain(chunks: AsyncIterable<CommandChunk>): Promise<CommandChunk[]> {
    const seen: CommandChunk[] = [];
    for await (const chunk of chunks) seen.push(chunk);
    return seen;
  }

  it("streams stdout lines, then the exit code and buffered stderr", async () => {
    const script =
      "let d='';process.stdin.on('data',c=>{d+=c}).on('end',()=>{" +
      "process.stdout.write('in:'+d+'\\nsecond\\ntrailing');" +
      "process.stderr.write('err');process.exit(3)})";

    const chunks = await drain(
      spawnStreamRunner({ executable: node, args: ["-e", script], stdin: "ping" }),
    );

    expect(chunks).toEqual([
      { type: "line", line: "in:ping" },
      { type: "line", line: "second" },
      { type: "line", line: "trailing" },
      { type: "exit", exitCode: 3, stderr: "err" },
    ]);
  });

  it("delivers a line before the process exits", async () => {
    const gate = join(tempDir(), "gate");
    // Writes one line, then waits for the consumer to acknowledge it on disk.
    const script =
      "process.stdout.write('first\\n');" +
      `const t=setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(gate)}))` +
      "{clearInterval(t);process.stdout.write('second\\n');process.exit(0)}},20)";

    const seen: string[] = [];
    for await (const chunk of spawnStreamRunner({
      executable: node,
      args: ["-e", script],
      stdin: "",
    })) {
      if (chunk.type === "line") {
        seen.push(chunk.line);
        if (chunk.line === "first") writeFileSync(gate, "go");
      }
    }

    expect(seen).toEqual(["first", "second"]);
  }, 15_000);

  it("reassembles a multi-byte character split across chunk boundaries", async () => {
    // "🐛" is 4 bytes: written one byte at a time, so every chunk boundary
    // falls inside the character and only the StringDecoder can rebuild it.
    const script =
      "const b=Buffer.from('a🐛b\\nc🐛d');" +
      "let i=0;const t=setInterval(()=>{" +
      "if(i>=b.length){clearInterval(t);process.exit(0)}" +
      "process.stdout.write(b.subarray(i,i+1));i++},1)";

    const chunks = await drain(
      spawnStreamRunner({ executable: node, args: ["-e", script], stdin: "" }),
    );

    expect(chunks).toEqual([
      { type: "line", line: "a🐛b" },
      { type: "line", line: "c🐛d" },
      { type: "exit", exitCode: 0, stderr: "" },
    ]);
  }, 15_000);

  it("reports ENOENT for a missing executable", async () => {
    const missing = { executable: "llmwrapper-command-that-does-not-exist", args: [], stdin: "" };

    await expect(drain(spawnStreamRunner(missing))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an already aborted run without spawning", async () => {
    const controller = new AbortController();
    const reason = new Error("too late");
    controller.abort(reason);

    await expect(
      drain(spawnStreamRunner({ executable: node, args: [], stdin: "" }, controller.signal)),
    ).rejects.toBe(reason);
  });

  // Group kill is POSIX-only, as documented for the whole CLI flavor.
  it.skipIf(process.platform === "win32")(
    "throws the abort reason mid-stream and kills the process group",
    async () => {
      const controller = new AbortController();
      const reason = new Error("cancelled");
      const pidFile = join(tempDir(), "grandchild.pid");
      const grandchild = "setInterval(()=>{},1000)";
      // Records a grandchild pid before the line that triggers the abort, so the
      // pid is on disk by the time the run is cancelled.
      const script =
        "const {spawn}=require('node:child_process');" +
        `const g=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});` +
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));` +
        "process.stdout.write('first\\n');setInterval(()=>{},1000)";

      const iterate = async () => {
        for await (const chunk of spawnStreamRunner(
          { executable: node, args: ["-e", script], stdin: "" },
          controller.signal,
        )) {
          if (chunk.type === "line") controller.abort(reason);
        }
      };

      await expect(iterate()).rejects.toBe(reason);
      const pid = readPid(pidFile);
      expect(pid).toBeGreaterThan(0);
      try {
        await expect.poll(() => isRunning(pid), { timeout: 5000 }).toBe(false);
      } finally {
        if (isRunning(pid)) process.kill(pid, "SIGKILL");
      }
    },
    15_000,
  );

  it("rejects when unconsumed output exceeds the bound", async () => {
    const script = "process.stdout.write('x'.repeat(17<<20));setInterval(()=>{},1000)";

    await expect(
      drain(spawnStreamRunner({ executable: node, args: ["-e", script], stdin: "" })),
    ).rejects.toThrow(/exceeds/);
  }, 30_000);

  it("streams far more than the output bound when the consumer keeps up", async () => {
    // 20 MiB in 1 KiB lines: over the 16 MiB cap in total, never in backlog —
    // an agentic `claude` run looks exactly like this.
    const total = 20 << 10;
    const script =
      `const line='x'.repeat(1023)+'\\n';let n=${total};` +
      // Exits by running out of work, never process.exit(): that would drop
      // whatever is still queued on the stdout pipe.
      "const pump=()=>{while(n>0){n--;if(!process.stdout.write(line))" +
      "return process.stdout.once('drain',pump)}};pump()";

    let lines = 0;
    let exit: CommandChunk | undefined;
    for await (const chunk of spawnStreamRunner({
      executable: node,
      args: ["-e", script],
      stdin: "",
    })) {
      if (chunk.type === "line") lines++;
      else exit = chunk;
    }

    expect(lines).toBe(total);
    expect(exit).toEqual({ type: "exit", exitCode: 0, stderr: "" });
  }, 60_000);

  it.skipIf(process.platform === "win32")(
    "kills a child still in its SIGTERM grace period when the host process exits",
    async () => {
      // The consumer breaks, so the generator's finally SIGTERMs a child that
      // ignores it — then the host dies before the SIGKILL escalation lands.
      // Only the exit handler can reap it, and only if the run is still tracked.
      await expectReaped(
        await hostExitsMidRun(
          `process.on('SIGTERM', () => {});${RECORD_PID}process.stdout.write('ready\\n');${LIVE_FOREVER}`,
          "(async () => {\n" +
            "  for await (const chunk of spawnStreamRunner(command)) { void chunk; break; }\n" +
            "  process.exit(0);\n" +
            "})();",
        ),
      );
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "kills the process group when the consumer breaks early",
    async () => {
      const pidFile = join(tempDir(), "grandchild.pid");
      const grandchild = "setInterval(()=>{},1000)";
      const script =
        "const {spawn}=require('node:child_process');" +
        `const g=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});` +
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));` +
        "process.stdout.write('ready\\n');setInterval(()=>{},1000)";

      for await (const chunk of spawnStreamRunner({
        executable: node,
        args: ["-e", script],
        stdin: "",
      })) {
        if (chunk.type === "line") break;
      }

      const pid = readPid(pidFile);
      expect(pid).toBeGreaterThan(0);
      try {
        // Generous: the SIGTERM→SIGKILL grace plus reaping has flaked at 5s under load.
        await expect.poll(() => isRunning(pid), { timeout: 15_000 }).toBe(false);
      } finally {
        if (isRunning(pid)) process.kill(pid, "SIGKILL");
      }
    },
    30_000,
  );
});
