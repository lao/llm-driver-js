# Spec: llmwrapper (npm) — multi-provider text-generation API

## Objective

TypeScript/npm port of the Go `llmwrapper` library (`/Users/lucas/Projects/claudewrap`).
One small, provider-neutral text-generation API with four switchable targets:

| Provider | Flavor | Transport                                   | Authentication          |
| -------- | ------ | ------------------------------------------- | ----------------------- |
| `claude` | `api`  | Anthropic Messages API (`@anthropic-ai/sdk`) | `ANTHROPIC_API_KEY`     |
| `claude` | `cli`  | Local `claude -p` process                    | Existing Claude CLI login |
| `openai` | `api`  | OpenAI Responses API (`openai`)              | `OPENAI_API_KEY`        |
| `openai` | `cli`  | Local `codex exec` process                   | Existing Codex CLI login |

Primary user: a Node/TypeScript developer who wants to prototype against a locally
authenticated CLI and later switch to the hosted API — or switch providers — by
changing only configuration. Call sites never change.

Package name: `llmwrapper` (verified available on npm, 2026-08-02).

### Public API

The library owns all public types. Neither provider SDK leaks through the boundary.

```ts
import { createClient, user, assistant } from "llmwrapper";

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

Public surface (deliberately small):

```ts
type Provider = "claude" | "openai";
type Flavor = "api" | "cli";
type Role = "user" | "assistant";

interface Config {
  provider: Provider;
  flavor: Flavor;
  model: string;            // required, never defaulted

  apiKey?: string;          // optional; SDK env-var defaults still work
  baseUrl?: string;         // optional proxy/test-server override (api flavor)
  fetch?: typeof fetch;     // optional transport override (api flavor)

  cliPath?: string;         // optional; defaults to "claude" / "codex"
  cliArgs?: string[];       // optional argv escape hatch; never shell-expanded
}

function createClient(config: Config): Client;

interface Client {
  generate(request: Request, options?: { signal?: AbortSignal }): Promise<Response>;
  generateStream(request: Request, options?: { signal?: AbortSignal }): AsyncIterable<StreamEvent>;
}

type StreamEvent =
  | { type: "text"; text: string }        // incremental text delta, possibly coarse
  | { type: "done"; response: Response }; // always the final event, exactly once

interface Request {
  system?: string;
  messages: Message[];      // ≥1 message, non-empty text, valid roles
  maxTokens: number;        // required, positive integer
}

interface Message { role: Role; text: string; }
function user(text: string): Message;
function assistant(text: string): Message;

interface Response {
  id: string;               // "" when target does not report one
  model: string;
  text: string;
  usage: Usage;
  completionReason: "stop" | "max_tokens" | "refusal" | "";
  provider: Provider;
  flavor: Flavor;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
}

class LLMWrapperError extends Error {
  code: ErrorCode;          // stable, for programmatic handling
  provider?: Provider;
  flavor?: Flavor;
  operation?: string;       // e.g. "generate"
  status?: number;          // HTTP status or process exit code
  providerCode?: string;    // provider-reported error code when available
  cause?: unknown;
}

type ErrorCode =
  | "invalid_config"
  | "invalid_request"
  | "executable_not_found"
  | "process_failed"
  | "parse_failed"
  | "api_error"
  | "transport_failed";
```

Validation rules (ported from Go):

- `provider`/`flavor` must be valid enum values; `model` is required and never
  silently selected or updated by the library.
- `apiKey`/`baseUrl`/`fetch` are rejected for `cli` flavor; `cliPath`/`cliArgs`
  are rejected for `api` flavor (`invalid_config`).
- `messages` must contain ≥1 message, each with non-empty text and a valid role;
  `maxTokens` must be a positive integer (`invalid_request`). CLI flavors validate
  `maxTokens` as part of the portable request even though they cannot enforce it.

### CLI transport contract (ported from Go)

- Claude: `claude -p --output-format json --permission-mode default --model <model>
  [--append-system-prompt <system>] [cliArgs...]`, transcript rendered to stdin,
  single JSON object parsed from stdout.
- Codex: `codex exec --json --sandbox read-only --skip-git-repo-check --model <model>
  [--config developer_instructions=<JSON-encoded system>] [cliArgs...] -`, transcript on
  stdin, JSONL events parsed from stdout (agent message + token usage events).
- Argv built directly, prompts passed via stdin, **no shell ever invoked**.
- Subprocess inherits cwd/env so local authentication works.
- Missing executable → `executable_not_found`; non-zero exit → `process_failed`
  (status = exit code); malformed output → `parse_failed`; provider-reported
  failure in output → `api_error` with `providerCode`.
- `AbortSignal` kills the subprocess group (SIGTERM, then SIGKILL after grace, so
  CLI-spawned helper processes die too) and aborts API requests.
- On abort, `generate` rejects with the abort reason itself — never a wrapped
  `LLMWrapperError` — identically across all four targets.
- Mirror exact flags from Go reference: `backend_claude_cli.go`, `backend_codex_cli.go`.

### Streaming contract (`generateStream`)

Provider-neutral, deliberately weak enough to hold on all four targets:

- Yields **zero or more** `text` events whose concatenated `text` equals the final
  `response.text`, then **exactly one** `done` event carrying the same normalized
  `Response` that `generate` would have produced. Nothing after `done`.
- **Granularity is target-dependent and never part of the contract**: API flavors
  stream token-level deltas; Claude CLI streams partial-message chunks
  (`--output-format stream-json --include-partial-messages`); Codex CLI may yield
  a single coarse `text` event if its JSONL reports only completed messages.
- **`claude`/`cli` scopes the concatenation guarantee to single-message turns.**
  `claude -p` is an agent, not a completion endpoint: `--include-partial-messages`
  emits deltas for *every* assistant message in the turn, while the terminal
  `result` event — and therefore `done.response.text` — carries only the final
  one. So when the CLI runs tools, the concatenated deltas are a superset of
  `done.response.text` (they also contain the intermediate assistant text that
  preceded each tool call). `done.response` remains exactly what `generate`
  returns. The other three targets hold the equality unconditionally. This is a
  property of the CLI's own output, not a library defect; the opt-in integration
  test characterizes it with a tool-forcing prompt.
- Same request validation, same `LLMWrapperError` normalization (errors throw
  from iteration), same abort contract: rejects with `signal.reason` untouched.
- Consumer `break`/early `return` must clean up the transport: abort the HTTP
  stream / kill the CLI process group. No leaked processes or sockets.
- `generate` is unchanged; adapters may implement the two paths independently.
- Claude CLI streaming argv mirrors the non-streaming argv except
  `--output-format stream-json --include-partial-messages` (plus `--verbose` if
  the installed CLI requires it with stream-json in print mode — verify against
  the real binary; the opt-in integration test must cover it). The stream's final
  `result` event is parsed with the same semantics as json mode. Codex CLI keeps
  `exec --json` and streams whatever item/delta events the JSONL provides.

### Scope

In scope: non-streaming and streaming text-only generation; system + multi-turn
user/assistant messages; maxTokens (enforced by API flavors, validated-only by
CLI flavors); normalized response/usage/errors; base-URL/fetch/cliPath/cliArgs
overrides; runnable switchable example (incl. `--stream`).

Out of scope: tool calling, images/audio/files, structured output,
retries, fallback/routing, model catalogs, conversation persistence.

## Tech Stack

- TypeScript strict, ESM source; **tsup** builds dual ESM+CJS with `.d.ts`.
- Node ≥ 20 (`engines`), uses `node:child_process` `spawn` for CLI flavors.
- Runtime deps: `@anthropic-ai/sdk` (Messages API), `openai` (Responses API). Nothing else.
- Dev toolchain: `vitest` (tests + coverage), `@biomejs/biome` (lint+format), `tsc --noEmit` (typecheck), npm as package manager.
- No DI/assertion/CLI frameworks.

## Commands

```bash
npm install
npm run build        # tsup → dist/ (esm + cjs + d.ts)
npm test             # vitest run (offline, no credentials, no real CLIs)
npm run test:coverage
npm run lint         # biome check
npm run typecheck    # tsc --noEmit
npm run example -- --provider openai --flavor cli --model gpt-5.6-sol --prompt "..."
```

Default tests must never contact a real provider or spawn a real agent CLI.
Opt-in integration smoke test (real binaries) gated by env vars
`LLMWRAPPER_CLAUDE_CLI_MODEL` / `LLMWRAPPER_CODEX_CLI_MODEL`, skipped when unset.

## Project Structure

```text
package.json / tsconfig.json / biome.json / vitest.config.ts / tsup.config.ts
src/index.ts              public exports only
src/types.ts              Config, Request, Response, Message, Usage, enums, user()/assistant()
src/errors.ts             LLMWrapperError + ErrorCode
src/config.ts             config validation
src/client.ts             createClient, backend selection, generate + request validation
src/backends/backend.ts   internal Backend interface
src/backends/anthropic-api.ts
src/backends/openai-api.ts
src/backends/claude-cli.ts
src/backends/codex-cli.ts
src/backends/cli.ts       shared runner: spawn wrapper, stdin transcript rendering, abort handling
test/*.test.ts            unit + contract tests (mirrors src layout)
test/integration.test.ts  opt-in real-CLI smoke test
examples/switchable.ts    provider/flavor/model/prompt from argv
README.md / SPEC.md / tasks/plan.md / CLAUDE.md
```

## Code Style

- Idiomatic modern TS: explicit validation, small functions, no classes where a
  function suffices (`createClient` returns a plain object closing over a backend).
- SDK imports confined to their adapter file; everything under `src/backends/` is
  internal and never re-exported.
- Errors always constructed through `LLMWrapperError`; provider SDK errors are
  caught and normalized at the adapter boundary.
- Biome is the formatting authority.

## Testing Strategy

1. Config tests: all four valid pairs, invalid enums, missing model, cross-flavor option misuse.
2. Request tests: empty transcript, empty text, bad role, non-positive/non-integer maxTokens, valid multi-turn.
3. API adapter tests: injected `fetch` (or local HTTP server) + `baseUrl`; verify request mapping, auth headers, response/usage mapping, normalized HTTP/API errors. Offline.
4. CLI adapter tests: injected fake runner; verify exact executable + argv, stdin transcript, Claude JSON parsing, Codex JSONL parsing, usage, ENOENT, non-zero exit, malformed output, provider-reported failure, abort.
5. Contract suite: same neutral request through all four backends (faked transports) asserting identical normalized shape — for both `generate` and `generateStream` (concatenated deltas === done.response.text — for `claude`/`cli` this holds because fixtures are single-message turns, see Streaming contract; done event last and unique).
5a. Streaming adapter tests: canned SSE bodies via injected fetch (API flavors); fake runner emitting incremental JSONL lines (CLI flavors). Cover: multi-delta happy path, zero-delta + done, mid-stream provider error, malformed event, abort mid-stream (rejects with signal.reason, subprocess group killed), early consumer break (transport cleaned up).
6. Example compiles (`tsc --noEmit` covers it).
7. Verification: build + test + coverage + lint + typecheck all green.

## Boundaries

- **Always:** validate public inputs; keep public types provider-neutral; use
  official SDKs for API flavors; keep default tests offline/deterministic; pass
  CLI prompts through stdin; run full verification before commits.
- **Ask first:** streaming/tools/new providers; non-official dependencies;
  publishing to npm (`npm publish` is a user action); real billable API/CLI calls.
- **Never:** commit credentials; interpolate prompts into a shell string;
  silently ignore invalid config; delete failing tests to go green.

## Success Criteria

- `npm pack` produces a publishable package: dual ESM/CJS + types, correct
  `exports` map, files whitelist, metadata (license MIT, repo, keywords).
- One unchanged `generate` call works across all four targets with only config changes.
- All four adapters return the normalized Response and normalized errors.
- `npm run build && npm test && npm run lint && npm run typecheck` green, offline.
- README: install, quick start, four-target matrix, auth setup, CLI/API
  limitations, error handling — easy to follow.
- CLAUDE.md documents project structure and commands.
