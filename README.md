# llm-driver

`llm-driver` is a small TypeScript library with one text-generation API and four
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
npm install llm-driver
```

Requires Node.js 20.12 or later. Ships dual ESM + CommonJS builds with
TypeScript declarations for both.

## Quick start

```ts
import { createClient, user } from "llm-driver";

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
const { createClient, user } = require("llm-driver");
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
  structured?: unknown; // parsed JSON when outputSchema was set
  toolCalls: ToolCallRecord[]; // audit trail; [] when no tools ran
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

## Streaming

`generateStream` takes the same request and returns an async iterable of events:
zero or more `text` deltas (interleaved with `reasoning` deltas, and
`tool_call`/`tool_result` events when `tools` is set), then exactly one final
`done` event carrying the same `Response` `generate` would have returned. Nothing
follows `done`.

```ts
for await (const event of client.generateStream({
  messages: [user("Explain dependency inversion")],
  maxTokens: 1024,
})) {
  if (event.type === "text") {
    process.stdout.write(event.text);
  } else {
    console.log("\n", event.response.usage);
  }
}
```

```ts
type StreamEvent =
  | { type: "text"; text: string } // incremental delta, possibly coarse
  | { type: "reasoning"; text: string } // thinking / reasoning-summary delta
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; output: ToolOutput; isError: boolean }
  | { type: "done"; response: Response }; // always last, exactly once
```

The concatenated `text` deltas equal `done.response.text` when no tools run.
`reasoning` deltas carry the target's thinking and never contribute to
`response.text`; a target that reports none emits none. When `tools` are set,
text produced before a tool call still streams but only the final message's text
lands in `response.text`, so the deltas become a superset (see
[Tools](#tools)). **Granularity
is not part of the contract** — it is whatever the target reports, and a target
may report nothing until the end:

| Target | Granularity |
| --- | --- |
| `claude`/`api` | Token-level deltas (Messages API SSE) |
| `openai`/`api` | Token-level deltas (Responses API SSE) |
| `claude`/`cli` | Partial-message chunks (`--output-format stream-json --include-partial-messages`) |
| `openai`/`cli` | One coarse delta: `codex exec --json` reports completed messages only |

> **`claude`/`cli` caveat.** `claude -p` is an agent, not a completion endpoint.
> It streams deltas for every assistant message in the turn, but its final
> `result` event — the one that becomes `done.response` — reports only the last
> message. The concatenation therefore equals `done.response.text` for a
> single-message turn; if the CLI runs tools, the deltas additionally contain the
> intermediate assistant text spoken before each tool call. `done.response` is
> always exactly what `generate` would have returned. Treat `done.response.text`
> as the answer and the deltas as progress output. The other three targets hold
> the equality unconditionally.

Errors and aborts work exactly as with `generate`, except that they surface from
the iteration rather than from the call:

- Request validation happens on the first `next()`, not when `generateStream` is
  called — standard async-generator semantics. `const it = client.generateStream(bad)`
  does not throw; the `for await` that drives it does.
- A failure throws an `LLMDriverError` from the loop; an abort throws the
  signal's own reason untouched, identically across all four targets.
- Stopping early cleans up the transport. `break`, `return`, or `throw` inside
  the loop aborts the HTTP stream, or signals the CLI process group (SIGTERM,
  then SIGKILL after a short grace period) — the iteration does not wait around
  to reap the process, it only guarantees the teardown is under way.
- That cleanup runs in the generator's `finally`, which `for await` triggers for
  you. A **manual iterator** must call `.return()` itself (or the `finally` never
  runs and the transport leaks). Note that `.return()` cannot preempt a pending
  `next()`: it is queued behind it, so a stalled stream is only preempted by the
  `AbortSignal`.

```ts
for await (const event of client.generateStream(request, {
  signal: AbortSignal.timeout(30_000),
})) {
  if (event.type === "text" && event.text.includes("STOP")) break; // transport torn down
}
```

## Generation features

Beyond plain text, the same `generate`/`generateStream` call takes reasoning
controls, structured output, images, and client tools. Each works on every target
that can honor it — and **throws where it cannot, never silently drops it** (see
[Feature support](#feature-support)).

### Sampling and reasoning

```ts
await client.generate({
  messages: [user("Prove there are infinitely many primes.")],
  maxTokens: 2048,
  temperature: 0.2, // api flavors only
  reasoning: { effort: "high" }, // all four targets
});
```

`reasoning.effort` is one of `"minimal" | "low" | "medium" | "high"`, mapped per
target (`output_config.effort`, `reasoning.effort`, `--effort`,
`-c model_reasoning_effort=`). Levels a given provider rejects surface the
provider's own error rather than being rejected by the library. In streaming mode,
thinking arrives as `reasoning` events. `temperature`/`topP` are api-only; `topK`
and `stopSequences` are `claude`/`api` only.

### Structured output

Pass a JSON Schema and read the parsed value from `response.structured`:

```ts
const response = await client.generate({
  messages: [user("Give me a point as JSON.")],
  maxTokens: 512,
  outputSchema: {
    type: "object",
    properties: { x: { type: "number" }, y: { type: "number" } },
    required: ["x", "y"],
  },
});
console.log(response.structured); // { x: 3, y: 4 } — already parsed
```

Supported on all four targets (api via the provider's `json_schema` format, CLI
via `--json-schema` / `--output-schema`). Output that is not valid JSON throws
`parse_failed`.

### Images

Build a message from content blocks instead of a string:

```ts
await client.generate({
  messages: [
    user([
      { type: "text", text: "What is in this image?" },
      { type: "image", source: { base64: pngBase64, mediaType: "image/png" } },
    ]),
  ],
  maxTokens: 1024,
});
```

Honored on all four targets. API flavors also accept `{ url }` image sources and
`document` (PDF) blocks; on CLI flavors URL images and documents throw
`unsupported_feature`, and Codex accepts images only in the final user turn.

### Tools

Pass handler-based tools; the library runs the agentic loop and calls `execute`
in-process on every target, then returns an audit trail in `response.toolCalls`:

```ts
const response = await client.generate({
  messages: [user("What is the weather in Paris?")],
  maxTokens: 1024,
  tools: [
    {
      name: "get_weather",
      description: "Current weather for a city",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
      async execute(input) {
        const { city } = input as { city: string };
        return `18°C and clear in ${city}`;
      },
    },
  ],
});
console.log(response.text, response.toolCalls);
```

- API flavors run the loop client-side (hard cap 16 rounds → `tool_loop_exceeded`)
  and honor `toolChoice` (`"auto" | "none" | "required" | { name }`).
- CLI flavors inject the tools into the CLI's own loop over a loopback HTTP MCP
  bridge; `toolChoice` throws `unsupported_feature` there (the CLI owns its loop).
- An `execute` that **throws** stops the loop with `tool_failed` (the thrown error
  is `error.cause`); returning `{ text, isError: true }` reports a failed result to
  the model and lets it continue. Handlers receive `ctx.signal` mirroring the
  request abort.

## Feature support

Each request feature is honored on the targets below and throws
`unsupported_feature` everywhere else — features are never silently dropped. The
authoritative copy of this matrix lives in `src/capabilities.ts`.

| Feature | claude/api | openai/api | claude/cli | openai/cli |
| --- | :-: | :-: | :-: | :-: |
| `temperature`, `topP` | ✅ | ✅ | ❌ | ❌ |
| `topK`, `stopSequences` | ✅ | ❌ | ❌ | ❌ |
| `metadata.userId` | ✅ | ✅ | ❌ | ❌ |
| `reasoning.effort` | ✅ | ✅ | ✅ | ✅ |
| `outputSchema` | ✅ | ✅ | ✅ | ✅ |
| `tools` | ✅ | ✅ | ✅ | ✅ |
| `toolChoice` | ✅ | ✅ | ❌ | ❌ |
| Image input | ✅ | ✅ | ✅ | ✅ |
| Document/PDF input | ✅ | ✅ | ❌ | ❌ |
| `timeoutMs` | ✅ | ✅ | ✅ | ✅ |
| `maxRetries` | ✅ | ✅ | ❌ | ❌ |

`unsupported_feature` is thrown at `generate()` time, before any transport work
(from the first `next()` for streams), with a message naming the feature and
target.

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

Options are flavor-scoped: passing `apiKey`, `baseUrl`, `fetch`, or `maxRetries`
to a `cli` client — or `cliPath`/`cliArgs` to an `api` client — is rejected with
an `invalid_config` error rather than silently ignored.

`timeoutMs` and `maxRetries` bound each call:

```ts
createClient({
  provider: "claude",
  flavor: "api",
  model: "claude-sonnet-4-5",
  timeoutMs: 30_000, // all flavors: api → SDK request timeout; cli → kill the process group
  maxRetries: 2, // api flavors only; re-running an agent CLI is not idempotent, so it is rejected there
});
```

## Error handling

Every failure is an `LLMDriverError` carrying a stable `code` plus whatever
context the target reported.

```ts
import { createClient, LLMDriverError, user } from "llm-driver";

try {
  const response = await client.generate({
    messages: [user("hello")],
    maxTokens: 256,
  });
  console.log(response.text);
} catch (error) {
  if (error instanceof LLMDriverError) {
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
| `unsupported_feature` | A request feature the selected target cannot honor (see [Feature support](#feature-support)) |
| `tool_failed` | A tool `execute` handler threw; the thrown error is `error.cause` |
| `tool_loop_exceeded` | The api-flavor tool loop hit its 16-round cap |

Other fields: `provider`, `flavor`, `operation` (e.g. `"generate"`), `status`
(HTTP status or process exit code), `providerCode`, and `cause`.

Abort is deliberately different. Pass an `AbortSignal` and, when it fires,
`generate` rejects with the signal's abort reason itself — never a wrapped
`LLMDriverError` — identically across all four targets:

```ts
const response = await client.generate(
  { messages: [user("hello")], maxTokens: 256 },
  { signal: AbortSignal.timeout(30_000) },
);
```

There is no default timeout: without a signal or `timeoutMs`, `generate` waits as
long as the target takes. Pass `AbortSignal.timeout(ms)` per call, or set
`timeoutMs` on the client, if you need a deadline.

## Scope and CLI differences

The shared contract is single-call generation, streaming or not: system text,
multi-turn user/assistant messages, the generation features above (per the
[feature matrix](#feature-support)), normalized text, and usage when reported.

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

Client tools, images, structured output, reasoning controls, and API-flavor
retries are supported per the [feature matrix](#feature-support). Automatic
fallback/routing, model catalogs, persisted conversations, document input on CLI
flavors, and platform APIs (batches, embeddings, moderation, image/audio
generation, server-side tools) are outside this library's scope.

## Example

The bundled example takes the target and model from command-line flags:

```bash
npm run example -- \
  --provider openai \
  --flavor cli \
  --model gpt-5.6-sol \
  --prompt "Explain dependency inversion in one paragraph"
```

Optional flags: `--system <text>`, `--max-tokens <n>` (default `1024`),
`--stream` to print deltas as they arrive followed by the usage line,
`--effort <minimal|low|medium|high>` to set reasoning effort, `--schema <path>`
to load a JSON Schema and print `response.structured`, and `--tool` to register a
demo `get_time` tool the model can call. Swap in `--provider claude --flavor api
--model claude-sonnet-4-5` and the example's generation code is unchanged.

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
