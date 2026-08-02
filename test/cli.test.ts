import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Command,
  type CommandRunner,
  createBoundedCapture,
  executeCli,
  readCount,
  renderTranscript,
  spawnRunner,
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
      const pidFile = join(mkdtempSync(join(tmpdir(), "llmwrapper-")), "grandchild.pid");
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
