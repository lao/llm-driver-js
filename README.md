# llmwrapper

`llmwrapper` is a small TypeScript library with one text-generation API and four
switchable targets. Point it at a hosted provider API or at an agent CLI you are
already logged into, and switch between them by changing configuration only —
the `generate` call site never changes. Models are always explicit; the library
never selects or updates one for you.

| Provider | Flavor | Target | Authentication |
| --- | --- | --- | --- |
| `claude` | `api` | Anthropic Messages API | `ANTHROPIC_API_KEY` |
| `claude` | `cli` | Local `claude -p` | Existing Claude CLI login |
| `openai` | `api` | OpenAI Responses API | `OPENAI_API_KEY` |
| `openai` | `cli` | Local `codex exec` | Existing Codex CLI login |

## Install

```bash
npm install llmwrapper
```

Requires Node.js 20.12 or later. Ships dual ESM + CommonJS builds with
TypeScript declarations for both.

## Quick start

```ts
import { createClient, user } from "llmwrapper";

const client = createClient({
  provider: "openai",
  flavor: "cli",
  model: "gpt-5.6-sol",
});

const response = await client.generate({
  system: "Answer concisely.",
  messages: [user("What is dependency inversion?")],
  maxTokens: 1024,
});

console.log(response.text);
```

CommonJS works too:

```js
const { createClient, user } = require("llmwrapper");
```

The response is provider-neutral:

```ts
interface Response {
  id: string; // "" when the target reports none
  model: string;
  text: string;
  usage: Usage; // inputTokens, outputTokens, cachedInputTokens,
  //           cacheCreationInputTokens, reasoningTokens
  completionReason: "stop" | "max_tokens" | "refusal" | "";
  provider: "claude" | "openai";
  flavor: "api" | "cli";
}
```

## Switching targets

Only the config object changes:

```ts
// Claude API
createClient({ provider: "claude", flavor: "api", model: "claude-sonnet-4-5" });

// Local Claude CLI
createClient({ provider: "claude", flavor: "cli", model: "claude-sonnet-4-5" });

// OpenAI API
createClient({ provider: "openai", flavor: "api", model: "gpt-5.6-sol" });

// Local Codex CLI
createClient({ provider: "openai", flavor: "cli", model: "gpt-5.6-sol" });
```

The request and the `generate` call stay identical across all four.

## Authentication and configuration

API flavors use the official provider SDKs. Set `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` in the environment, or pass `apiKey` explicitly:

```ts
const client = createClient({
  provider: "claude",
  flavor: "api",
  model: "claude-sonnet-4-5",
  apiKey: process.env.MY_KEY,
  baseUrl: "https://proxy.internal/anthropic", // optional
  fetch: myInstrumentedFetch, // optional transport override
});
```

`baseUrl` and `fetch` are for proxies, custom transports, and tests. Treat
custom endpoints and transports as trusted application configuration: API
credentials and prompts are sent through them.

CLI flavors reuse the installed tool's existing login — no API key is read.
`cliPath` selects a nonstandard executable and `cliArgs` appends argv verbatim:

```ts
const client = createClient({
  provider: "openai",
  flavor: "cli",
  model: "gpt-5.6-sol",
  cliPath: "/opt/homebrew/bin/codex", // optional
  cliArgs: ["--config", "model_reasoning_effort=high"], // optional
});
```

Prompts are written to the subprocess's stdin and argv is built directly — no
shell is ever invoked. Treat `cliPath` and `cliArgs` as trusted application
configuration, because they control local process execution.

Options are flavor-scoped: passing `apiKey`, `baseUrl`, or `fetch` to a `cli`
client — or `cliPath`/`cliArgs` to an `api` client — is rejected with an
`invalid_config` error rather than silently ignored.

## Error handling

Every failure is an `LLMWrapperError` carrying a stable `code` plus whatever
context the target reported.

```ts
import { createClient, LLMWrapperError, user } from "llmwrapper";

try {
  const response = await client.generate({
    messages: [user("hello")],
    maxTokens: 256,
  });
  console.log(response.text);
} catch (error) {
  if (error instanceof LLMWrapperError) {
    console.error(error.code, error.provider, error.flavor, error.status);
  }
  throw error;
}
```

| `error.code` | Meaning |
| --- | --- |
| `invalid_config` | Bad provider/flavor/model, or an option used with the wrong flavor |
| `invalid_request` | Empty transcript, empty message text, bad role, or non-positive/non-integer `maxTokens` |
| `executable_not_found` | The CLI binary could not be launched |
| `process_failed` | The CLI exited non-zero (`status` is the exit code) |
| `parse_failed` | Target output could not be parsed |
| `api_error` | The provider or CLI reported a failure (`status`, `providerCode` when available) |
| `transport_failed` | Network or transport-level failure |

Other fields: `provider`, `flavor`, `operation` (e.g. `"generate"`), `status`
(HTTP status or process exit code), `providerCode`, and `cause`.

Abort is deliberately different. Pass an `AbortSignal` and, when it fires,
`generate` rejects with the signal's abort reason itself — never a wrapped
`LLMWrapperError` — identically across all four targets:

```ts
const response = await client.generate(
  { messages: [user("hello")], maxTokens: 256 },
  { signal: AbortSignal.timeout(30_000) },
);
```

There is no default timeout: without a signal, `generate` waits as long as the
target takes. Pass `AbortSignal.timeout(ms)` if you need a deadline.

## Scope and CLI differences

The shared contract is non-streaming, text-only generation: system text,
multi-turn user/assistant messages, normalized text, and usage when reported.

The CLI flavors intentionally wrap agent CLIs. They are not byte-for-byte
equivalents of the hosted APIs:

- API flavors map and enforce `maxTokens`. CLI flavors validate it as part of
  the portable request but have no reliable equivalent flag, so it is not
  enforced.
- Claude CLI runs in single-shot print mode with the default permission mode, so
  a headless run cannot approve tool actions that need approval — but tools that
  are allowed by default still run (see the security note below). Codex runs with
  a read-only sandbox. Agent CLI behavior can still differ from a hosted model
  endpoint.
- System text is passed through Claude's `--append-system-prompt` flag and
  Codex's per-invocation `developer_instructions` config. Conversation text
  stays on stdin. System text may therefore be visible to local process
  inspection.
- CLI subprocesses inherit the application's working directory and environment
  so local authentication works. **Do not send untrusted prompts to a CLI
  flavor without isolating the host process.** Codex's read-only sandbox
  prevents writes, not reads. `claude -p` runs in the default permission mode,
  which still lets the agent use its default-allowed read tools (`Read`,
  `Glob`, `Grep`) without prompting, in the inherited working directory — a
  prompt-injected run can read local files even though it cannot write them.
  Run the host process in a sandbox or a directory with nothing sensitive in
  it, and use `cliArgs` to tighten the CLI's own limits, e.g.
  `cliArgs: ["--disallowed-tools", "Read,Glob,Grep"]`.
- Usage fields are populated only when a target reports them; everything else
  is `0`.
- Process-group cleanup on abort is POSIX-only: the subprocess is spawned
  detached and aborting signals the whole group (SIGTERM, then SIGKILL after a
  grace period) so CLI-spawned helpers die too. On Windows only the direct child
  is killed, and the CLI flavors are untested there — `.cmd` shims are not
  resolved, so pass an explicit `cliPath`.
- Being detached also means a terminal Ctrl-C does not reach the CLI child: the
  signal goes to your process group, not its own. A live child is killed by an
  explicit `AbortSignal`, or by the library's `process.on("exit")` handler when
  the host shuts down normally. A host killed outright (`SIGKILL`, or a signal
  it does not handle) leaves the CLI running until it finishes on its own.

Streaming, tool/function calling, images, structured output, retries, automatic
fallback, and persisted conversations are outside this library's current scope.

## Example

The bundled example takes the target and model from command-line flags:

```bash
npm run example -- \
  --provider openai \
  --flavor cli \
  --model gpt-5.6-sol \
  --prompt "Explain dependency inversion in one paragraph"
```

Optional flags: `--system <text>` and `--max-tokens <n>` (default `1024`).
Swap in `--provider claude --flavor api --model claude-sonnet-4-5` and the
example's generation code is unchanged.

## Development

```bash
npm install
npm run build        # tsup → dist/ (ESM + CJS + .d.ts)
npm test             # vitest run
npm run test:coverage
npm run lint         # biome check
npm run typecheck    # tsc --noEmit
```

The default test suite is offline: it uses injected fetch/HTTP test servers and
a fake process runner, never provider credentials or real agent CLIs.

That also means the CLI flavors' real flags (`claude -p --output-format json …`
and `codex exec --json …`) cannot be validated offline. An opt-in smoke test
launches the real binaries so a renamed or removed flag surfaces in the suite
instead of only at runtime. It skips unless the model env vars are set:

```bash
LLMWRAPPER_CLAUDE_CLI_MODEL=claude-sonnet-4-5 \
LLMWRAPPER_CODEX_CLI_MODEL=gpt-5.6-sol \
  npm test
```

## License

MIT — see [LICENSE](LICENSE).
