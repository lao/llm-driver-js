import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { assistant, type Flavor, type Provider, user } from "../src/types.js";

/**
 * End-to-end routing proof: `createClient` must pick the backend that matches
 * `provider`/`flavor`, spawn it, and stamp the response. The fake executables
 * are real files on disk — only `node` is ever spawned, and nothing leaves the
 * machine — so a swapped backend shows up as the wrong argv, not a green suite.
 */
const dir = mkdtempSync(join(tmpdir(), "llmwrapper-routing-"));

const CLAUDE_STDOUT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "routed to claude",
  session_id: "session-routing",
  usage: { input_tokens: 3, output_tokens: 4 },
});

const CODEX_STDOUT = [
  '{"type":"thread.started","thread_id":"thread-routing"}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"routed to codex"}}',
  '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}',
  "",
].join("\n");

interface Invocation {
  argv: string[];
  stdin: string;
}

/** Writes an executable that records how it was called, then prints canned output. */
function fakeCli(name: string, stdout: string): { path: string; read: () => Invocation } {
  const path = join(dir, `${name}.cjs`);
  const record = join(dir, `${name}.invocation.json`);
  writeFileSync(
    path,
    `#!${process.execPath}\n` +
      'const fs = require("node:fs");\n' +
      'let stdin = "";\n' +
      'process.stdin.on("data", (chunk) => { stdin += chunk; });\n' +
      'process.stdin.on("end", () => {\n' +
      `  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));\n` +
      `  process.stdout.write(${JSON.stringify(stdout)});\n` +
      "});\n",
  );
  chmodSync(path, 0o755);
  return { path, read: () => JSON.parse(readFileSync(record, "utf8")) as Invocation };
}

const claudeCli = fakeCli("fake-claude", CLAUDE_STDOUT);
const codexCli = fakeCli("fake-codex", CODEX_STDOUT);

interface Flavour {
  provider: Provider;
  model: string;
  cli: typeof claudeCli;
  args: string[];
  text: string;
  id: string;
}

const flavours: Flavour[] = [
  {
    provider: "claude",
    model: "claude-routing-test",
    cli: claudeCli,
    args: [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "default",
      "--model",
      "claude-routing-test",
      "--append-system-prompt",
      "Be concise.",
    ],
    text: "routed to claude",
    id: "session-routing",
  },
  {
    provider: "openai",
    model: "codex-routing-test",
    cli: codexCli,
    args: [
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--model",
      "codex-routing-test",
      "--config",
      'developer_instructions="Be concise."',
      "-",
    ],
    text: "routed to codex",
    id: "thread-routing",
  },
];

describe.skipIf(process.platform === "win32")("cli routing through createClient", () => {
  for (const flavour of flavours) {
    it(`${flavour.provider}/cli spawns its own binary with its own argv`, async () => {
      const flavor: Flavor = "cli";
      const client = createClient({
        provider: flavour.provider,
        flavor,
        model: flavour.model,
        cliPath: flavour.cli.path,
      });

      const response = await client.generate({
        system: "Be concise.",
        maxTokens: 64,
        messages: [user("hello"), assistant("hi"), user("continue")],
      });

      expect(flavour.cli.read()).toEqual({
        argv: flavour.args,
        stdin: "User: hello\n\nAssistant: hi\n\nUser: continue",
      });
      expect(response.text).toBe(flavour.text);
      expect(response.id).toBe(flavour.id);
      // Stamped by the client, not by the backend.
      expect(response.provider).toBe(flavour.provider);
      expect(response.flavor).toBe("cli");
      expect(response.model).toBe(flavour.model);
    }, 15_000);
  }
});
