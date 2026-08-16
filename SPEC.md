# Spec: llm-driver (npm) — multi-provider text-generation API

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

Package name: `llm-driver` (verified available on npm, 2026-08-02).

The library closes the feature gap with the official SDKs for **core generation** —
everything expressible in a single `generate()`/`generateStream()` call: sampling
parameters, reasoning controls, structured output, image input, and client tool
calling. Each feature works on every target that can honor it, and throws where it
cannot (see [Portability policy](#portability-policy-strict)). Platform APIs stay
out of scope (see [Scope](#scope)).

### Public API

The library owns all public types. Neither provider SDK leaks through the boundary.

```ts
import { createClient, user, assistant } from "llm-driver";

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
type ReasoningEffort = "minimal" | "low" | "medium" | "high";

interface Config {
  provider: Provider;
  flavor: Flavor;
  model: string;            // required, never defaulted

  apiKey?: string;          // optional; SDK env-var defaults still work
  baseUrl?: string;         // optional proxy/test-server override (api flavor)
  fetch?: typeof fetch;     // optional transport override (api flavor)

  cliPath?: string;         // optional; defaults to "claude" / "codex"
  cliArgs?: string[];       // optional argv escape hatch; never shell-expanded

  timeoutMs?: number;       // all flavors; SDK default (api) / none (cli)
  maxRetries?: number;      // api flavors only; invalid_config on cli (default 0)
}

function createClient(config: Config): Client;

interface Client {
  generate(request: Request, options?: { signal?: AbortSignal }): Promise<Response>;
  generateStream(request: Request, options?: { signal?: AbortSignal }): AsyncIterable<StreamEvent>;
}

interface Request {
  system?: string;
  messages: Message[];      // ≥1 message, each text XOR content, valid roles
  maxTokens: number;        // required, positive integer

  // Sampling (see feature matrix for per-target support)
  temperature?: number;     // passed through verbatim; provider range rules apply
  topP?: number;
  topK?: number;            // claude/api only
  stopSequences?: string[]; // claude/api only
  metadata?: { userId?: string };  // api flavors only

  reasoning?: { effort: ReasoningEffort };  // all four targets
  outputSchema?: JsonSchema;                // structured output; all four targets
  tools?: Tool[];                           // client tools; all four targets
  toolChoice?: ToolChoice;                  // api flavors only; requires tools
}

interface Message {
  role: Role;
  text?: string;            // plain-text turn; XOR with content
  content?: ContentBlock[]; // structured blocks; XOR with text
}
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { base64: string; mediaType: ImageMediaType } | { url: string } }
  | { type: "document"; source: { base64: string; mediaType: "application/pdf" } };
type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

function user(text: string): Message;
function user(content: ContentBlock[]): Message;      // block overload
function assistant(text: string): Message;
function assistant(content: ContentBlock[]): Message; // block overload

type JsonSchema = Record<string, unknown>;            // JSON Schema draft providers accept

interface Tool {
  name: string;             // ^[a-zA-Z0-9_-]{1,64}$
  description: string;
  inputSchema: JsonSchema;
  execute(input: unknown, ctx: { signal?: AbortSignal }): Promise<ToolOutput> | ToolOutput;
}
type ToolOutput = string | { text: string; isError?: boolean };
type ToolChoice = "auto" | "none" | "required" | { name: string };

interface Response {
  id: string;               // "" when target does not report one
  model: string;
  text: string;
  usage: Usage;
  completionReason: "stop" | "max_tokens" | "refusal" | "";
  provider: Provider;
  flavor: Flavor;
  structured?: unknown;     // parsed JSON when outputSchema was set; else absent
  toolCalls: ToolCallRecord[];  // audit trail; [] when no tools ran
}

interface ToolCallRecord {
  id: string;               // provider call id, or bridge-generated on cli
  name: string;
  input: unknown;
  output: ToolOutput;       // what execute() returned, normalized to object form
  isError: boolean;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
}

type StreamEvent =
  | { type: "text"; text: string }        // incremental text delta, possibly coarse
  | { type: "reasoning"; text: string }   // thinking / reasoning-summary delta
  | { type: "tool_call"; id: string; name: string; input: unknown }  // inputs complete, before execute()
  | { type: "tool_result"; id: string; name: string; output: ToolOutput; isError: boolean }
  | { type: "done"; response: Response }; // always the final event, exactly once

class LLMDriverError extends Error {
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
  | "transport_failed"
  | "unsupported_feature"   // a request feature the target cannot honor
  | "tool_failed"           // an execute() handler threw
  | "tool_loop_exceeded";   // api tool loop hit the round cap
```

Validation rules (ported from Go, plus the v2 capability gate):

- `provider`/`flavor` must be valid enum values; `model` is required and never
  silently selected or updated by the library.
- `apiKey`/`baseUrl`/`fetch`/`maxRetries` are rejected for `cli` flavor;
  `cliPath`/`cliArgs` are rejected for `api` flavor (`invalid_config`).
- `messages` must contain ≥1 message; each carries exactly one of `text`
  (non-empty) or `content` (non-empty blocks); role must be valid. `maxTokens`
  must be a positive integer (`invalid_request`). CLI flavors validate
  `maxTokens` as part of the portable request even though they cannot enforce it.
- Every gated request feature is checked against the [feature matrix](#feature-matrix-normative)
  before any transport work; an unsupported feature throws `unsupported_feature`
  (see [Portability policy](#portability-policy-strict)).

### Portability policy (strict)

Every request feature is either honored or rejected — **never silently dropped**.
A request that uses a feature the selected target cannot honor throws
`LLMDriverError` with code `unsupported_feature` at `generate()` time (before any
transport work; from the first `next()` for streams), with `message` naming the
feature and target.

The matrix below is the normative contract. It lives in exactly one place in the
code — `src/capabilities.ts` — which is the single source of truth; adapters map a
supported feature onto the wire but never decide support. Adding a feature is one
row in that table plus its adapter mapping.

Existing exception stays: `maxTokens` remains required and validated on CLI
flavors even though they cannot enforce it (v1 contract, unchanged).

### Feature matrix (normative)

| Feature | claude/api | openai/api | claude/cli | openai/cli (codex) |
|---|---|---|---|---|
| `temperature` | ✅ `temperature` | ✅ `temperature` | ❌ | ❌ |
| `topP` | ✅ `top_p` | ✅ `top_p` | ❌ | ❌ |
| `topK` | ✅ `top_k` | ❌ (no equivalent) | ❌ | ❌ |
| `stopSequences` | ✅ `stop_sequences` | ❌ (Responses API has none) | ❌ | ❌ |
| `metadata.userId` | ✅ `metadata.user_id` | ✅ `safety_identifier` | ❌ | ❌ |
| `reasoning.effort` | ✅ `output_config.effort` | ✅ `reasoning.effort` | ✅ `--effort` | ✅ `-c model_reasoning_effort=` |
| `outputSchema` (structured output) | ✅ `output_config.format` | ✅ `text.format` json_schema | ✅ `--json-schema` | ✅ `--output-schema <tmpfile>` |
| `tools` (client tools, handler-based) | ✅ tool loop | ✅ tool loop | ✅ MCP bridge | ✅ MCP bridge |
| `toolChoice` | ✅ | ✅ | ❌ (CLI owns its loop) | ❌ |
| Image input | ✅ `image` block | ✅ `input_image` | ✅ stream-json content block | ✅ `-i <tmpfile>` |
| Document/PDF input | ✅ `document` block | ✅ `input_file` | ❌ | ❌ |
| `timeoutMs` | ✅ SDK timeout | ✅ SDK timeout | ✅ kill process group | ✅ kill process group |
| `maxRetries` | ✅ SDK retries | ✅ SDK retries | ❌ (re-running an agent is not idempotent) | ❌ |
| Reasoning stream events | ✅ thinking deltas | ✅ reasoning-summary deltas | ✅ stream-json thinking | ⚠️ best-effort (`agent_reasoning`; may be absent) |
| Tool-call stream events | ✅ | ✅ | ✅ (bridge observes calls) | ✅ (bridge observes calls) |

❌ = throws `unsupported_feature`. ⚠️ = emitted when the target reports it;
absence is not an error (same stance as v1 delta granularity).

CLI flag mappings are verified against `claude` (2026-08: `--json-schema`,
`--effort`, `--mcp-config`, `--strict-mcp-config`, `--allowedTools`,
`--input-format stream-json`) and `codex-cli 0.147.0` (`--output-schema`,
`-i/--image`, `-c` overrides, `--json`). The opt-in integration test is the
authority for behavior fixtures cannot prove (see Testing).

### CLI transport contract (ported from Go)

- Claude: `claude -p --output-format json --permission-mode default --model <model>
  [--append-system-prompt <system>] [feature flags] [cliArgs...]`, transcript
  rendered to stdin, single JSON object parsed from stdout.
- Codex: `codex exec --json --sandbox read-only --skip-git-repo-check --model <model>
  [--config developer_instructions=<JSON-encoded system>] [feature flags] [cliArgs...] -`,
  transcript on stdin, JSONL events parsed from stdout (agent message + token usage events).
- Argv built directly, prompts passed via stdin, **no shell ever invoked**.
- Subprocess inherits cwd/env so local authentication works.
- Missing executable → `executable_not_found`; non-zero exit → `process_failed`
  (status = exit code); malformed output → `parse_failed`; provider-reported
  failure in output → `api_error` with `providerCode`.
- `AbortSignal` kills the subprocess group (SIGTERM, then SIGKILL after grace, so
  CLI-spawned helper processes die too) and aborts API requests.
- On abort, `generate` rejects with the abort reason itself — never a wrapped
  `LLMDriverError` — identically across all four targets.
- Mirror exact flags from Go reference: `backend_claude_cli.go`, `backend_codex_cli.go`.

### Streaming contract (`generateStream`)

Provider-neutral, deliberately weak enough to hold on all four targets:

- Yields **zero or more** `text` events, any number of `reasoning` events, and —
  when `tools` is set — `tool_call`/`tool_result` pairs, then **exactly one**
  `done` event carrying the same normalized `Response` that `generate` would have
  produced. Nothing after `done`.
- **Text concatenation guarantee**: concatenated `text` deltas equal
  `done.response.text` *for the final assistant message*. Without `tools`, that is
  the whole response (v1 guarantee, unchanged). With `tools`, text produced before
  a tool call still streams as `text` events but only the final message's text
  lands in `response.text` — the deltas become a superset. `reasoning` deltas
  never contribute to `response.text`.
- **Granularity is target-dependent and never part of the contract**: API flavors
  stream token-level deltas; Claude CLI streams partial-message chunks
  (`--output-format stream-json --include-partial-messages`); Codex CLI may yield
  a single coarse `text` event if its JSONL reports only completed messages.
- **`claude`/`cli` scopes the concatenation guarantee to single-message turns**
  even without user `tools`. `claude -p` is an agent, not a completion endpoint:
  `--include-partial-messages` emits deltas for *every* assistant message in the
  turn, while the terminal `result` event — and therefore `done.response.text` —
  carries only the final one. So once the CLI runs any tool (its own or a bridged
  one), the concatenated deltas are a superset of `done.response.text`.
  `done.response` remains exactly what `generate` returns. The other three targets
  hold the equality whenever `tools` is unset. This is a property of the CLI's own
  output, not a library defect; the opt-in integration test characterizes it with
  a tool-forcing prompt.
- `reasoning` events carry the target's thinking / reasoning-summary text; a
  target that reports none emits none (no placeholder events).
- `tool_call` is emitted once a call's input is complete and before its handler
  runs; the matching `tool_result` (same `id`) follows once `execute` returns.
- Same request validation, same `LLMDriverError` normalization (errors throw from
  iteration), same abort contract: rejects with `signal.reason` untouched.
- Consumer `break`/early `return` must clean up the transport: abort the HTTP
  stream / kill the CLI process group. No leaked processes or sockets.
- `generate` is unchanged; adapters may implement the two paths independently.
- Claude CLI streaming argv mirrors the non-streaming argv except
  `--output-format stream-json --include-partial-messages` (plus `--verbose` if
  the installed CLI requires it with stream-json in print mode — verified against
  the real binary in the opt-in test). The stream's final `result` event is parsed
  with the same semantics as json mode. Codex CLI keeps `exec --json` and streams
  whatever item/delta events the JSONL provides.

### Backend semantics — tools

Client tools are **handler-based and uniform across all four targets**: the caller
passes `Tool[]` with an in-process `execute`, and the library ensures every tool
call routes back to that handler. `Response.toolCalls` is the audit trail; in
streaming mode calls surface as `tool_call`/`tool_result` events.

Error semantics:

- `execute()` **throws** (rejected promise) → the loop stops and `generate`
  rejects `tool_failed` (`cause` = thrown error).
- `execute()` **returns** `{ isError: true }` → reported to the model as a failed
  tool result and the loop continues (SDK semantics).
- Abort is unchanged: `signal.reason` raw, everywhere — including while a handler
  is in flight (the handler receives the same signal via `ctx.signal`).

#### API flavors — tool loop

`generate` with `tools` runs the standard agentic loop client-side: send request →
if the response contains tool calls, run each `execute()` (parallel calls run
concurrently) → append the assistant tool-use turn + tool results to a private copy
of the transcript → resend → repeat until a terminal stop. Every round respects
`signal`. `generateStream` streams each round's deltas and emits
`tool_call`/`tool_result` between rounds.

Hard cap: **16 rounds** per `generate()`; exceeding it throws `tool_loop_exceeded`
(dedicated code — resolves open question 3). Mappings: Anthropic
`tools[].input_schema` / `tool_use` / `tool_result` blocks; OpenAI
`tools[].type:"function"` / `function_call` / `function_call_output` items.
`toolChoice` maps to `tool_choice` (`required` → Anthropic `any`).

#### CLI flavors — MCP bridge

The CLI runs its own agentic loop; the library injects user tools into it as an
MCP server and executes handlers in-process when the CLI calls them. There is no
client-side loop, so the 16-round cap and `toolChoice` do not apply
(`toolChoice` is `unsupported_feature` on cli — the CLI decides when to call).

- The library starts an in-process **streamable-HTTP MCP endpoint** on
  `127.0.0.1:<ephemeral port>` for the duration of the subprocess. A minimal
  JSON-RPC implementation over `node:http` — `initialize`, `tools/list`,
  `tools/call` only. **No new runtime dependency.**
- Claude argv adds: `--mcp-config '{"mcpServers":{"llmdriver":{"type":"http","url":"http://127.0.0.1:<port>/mcp/<token>"}}}'
  --strict-mcp-config --allowedTools mcp__llmdriver__<name>` (one per tool, so no
  permission prompts; built-in tools stay at their v1 defaults).
- Codex argv adds: `-c mcp_servers.llmdriver.url="http://127.0.0.1:<port>/mcp/<token>"`
  (streamable HTTP MCP; the exact dotted-key syntax for codex 0.147 is the last
  billable verification owed — see open question 4).
- `tools/call` invokes `execute()` in-process; the result becomes MCP content. The
  bridge records `ToolCallRecord`s and (in streaming mode) emits
  `tool_call`/`tool_result` events as calls arrive.
- The server binds loopback only, with a single-use unguessable token in the URL
  path (`/mcp/<token>`) so another local process cannot call handlers. It is torn
  down in `finally` alongside the process-group kill.

### Backend semantics — structured output

- claude/api: `output_config.format = {type:"json_schema", schema}`.
- openai/api: `text.format = {type:"json_schema", name:"output", schema, strict:true}`.
- claude/cli: `--json-schema '<schema JSON>'`; result parsed from the json result payload.
- codex/cli: schema written to a scratch temp file, `--output-schema <path>`, file
  deleted in `finally`.
- All targets: the adapter parses the final text as JSON into `response.structured`;
  invalid JSON → `parse_failed`. `outputSchema` + `tools` together is allowed
  wherever both are supported (all four targets); the schema constrains the final
  message.

### Backend semantics — images

- API flavors: direct block mapping (base64 and URL both supported).
- claude/cli: stdin switches to `--input-format stream-json`, sending the
  transcript as user messages with content blocks (text + image base64). Text-only
  requests keep the v1 plain-stdin path byte-for-byte (no regression risk).
- codex/cli: base64 images written to scratch temp files, passed via `-i`, deleted
  in `finally`. URL-source images are `unsupported_feature` (no flag for URLs).
  `-i` attaches to the *initial prompt*, so images in earlier turns of a multi-turn
  transcript are `unsupported_feature` — images may appear only in the final user turn.
- Document/PDF blocks are api-only (`document` block on claude, `input_file` on
  openai); on CLI flavors they throw `unsupported_feature`. (claude/cli stream-json
  may accept documents; if a future integration run proves it, the matrix cell
  flips in a follow-up — resolves open question 5.)

### Backend semantics — reasoning

- Request `reasoning.effort` maps per the matrix. Values pass through the library's
  neutral enum; targets that reject a given level surface the provider's own error
  (`api_error`/`process_failed`). The library keeps no per-model capability tables
  (same stance as v1 on `model`).
- Streaming: Anthropic thinking deltas, OpenAI reasoning-summary deltas, and claude
  stream-json thinking chunks map to `reasoning` events. Codex maps them only if
  its JSONL exposes reasoning events; otherwise none (matrix ⚠️).

### Scope

In scope: non-streaming and streaming generation; system + multi-turn
user/assistant messages; `maxTokens` (enforced by API flavors, validated-only by
CLI flavors); sampling parameters, reasoning effort, structured output, image
input, and handler-based client tools per the feature matrix; normalized
response/usage/errors; base-URL/fetch/cliPath/cliArgs/timeoutMs/maxRetries
overrides; runnable switchable example (incl. `--stream`, `--effort`, `--schema`,
`--tool`).

Out of scope: platform APIs — batches, files-as-storage, embeddings, moderation,
image/audio generation, token counting, vector stores, server-side conversation
state (`previous_response_id`), admin/usage APIs, server tools (web search, code
execution, computer use), prompt-caching breakpoints (`cache_control`), citations.
Also out: automatic fallback/routing, model catalogs, conversation persistence,
document input on CLI flavors, handler-less "return the tool_use to the caller"
tool mode (open question 2 — deliberately omitted; the uniform handler-based
contract is what keeps call sites target-portable). The library stays a
text-generation driver; transcripts remain client-side.

## Tech Stack

- TypeScript strict, ESM source; **tsup** builds dual ESM+CJS with `.d.ts`.
- Node ≥ 20 (`engines`), uses `node:child_process` `spawn` for CLI flavors and
  `node:http` + `node:crypto` for the MCP bridge.
- Runtime deps: `@anthropic-ai/sdk` (Messages API), `openai` (Responses API).
  Nothing else — the MCP bridge is hand-rolled, no `@modelcontextprotocol/sdk`.
- Dev toolchain: `vitest` (tests + coverage), `@biomejs/biome` (lint+format),
  `tsc --noEmit` (typecheck), npm as package manager.
- `typescript` pinned to ^5.9 (typescript@7 breaks tsup's dts pipeline).
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
src/types.ts              Config, Request, Response, Message, ContentBlock, Tool, enums, user()/assistant()
src/errors.ts             LLMDriverError + ErrorCode
src/capabilities.ts       feature × target support matrix + strict gate (single source of truth)
src/config.ts             config validation
src/client.ts             createClient, backend selection, generate + request validation
src/backends/backend.ts   internal Backend interface
src/backends/anthropic-api.ts
src/backends/openai-api.ts
src/backends/claude-cli.ts
src/backends/codex-cli.ts
src/backends/cli.ts        shared runner: spawn wrapper, stdin transcript rendering, abort handling
src/backends/tool-loop.ts  shared api-flavor agentic tool loop
src/backends/mcp-bridge.ts loopback streamable-HTTP MCP server for cli-flavor tools
test/*.test.ts             unit + contract tests (mirrors src layout)
test/integration.test.ts   opt-in real-CLI smoke test
examples/switchable.ts     provider/flavor/model/prompt from argv
README.md / SPEC.md / tasks/plan.md / CLAUDE.md
```

## Code Style

- Idiomatic modern TS: explicit validation, small functions, no classes where a
  function suffices (`createClient` returns a plain object closing over a backend).
- SDK imports confined to their adapter file; everything under `src/backends/` is
  internal and never re-exported.
- The support matrix lives ONLY in `capabilities.ts`; adapters never hand-roll an
  "is this supported" check.
- Errors always constructed through `LLMDriverError`; provider SDK errors are
  caught and normalized at the adapter boundary.
- Biome is the formatting authority.

## Testing Strategy

1. Config tests: all four valid pairs, invalid enums, missing model, cross-flavor option misuse, `maxRetries` on cli.
2. Request tests: empty transcript, empty text, text+content both set / neither set, bad role, non-positive/non-integer maxTokens, valid multi-turn.
3. Capability gate tests: every ❌ cell throws `unsupported_feature` naming the feature+target; every ✅ cell does not throw at the gate. Table-driven from the matrix data.
4. API adapter tests: injected `fetch` (or local HTTP server) + `baseUrl`; verify request mapping, auth headers, response/usage mapping, normalized HTTP/API errors. Offline.
5. CLI adapter tests: injected fake runner; verify exact executable + argv, stdin transcript, Claude JSON parsing, Codex JSONL parsing, usage, ENOENT, non-zero exit, malformed output, provider-reported failure, abort.
6. Tool loop (api): injected fetch returning tool_use → tool_result round trips; parallel calls; `execute` throw → `tool_failed`; `isError` result continues; loop cap → `tool_loop_exceeded`; abort mid-handler.
7. MCP bridge: real `node:http` server + fake runner acting as the CLI — drives `initialize`/`tools/list`/`tools/call` against the live loopback endpoint; asserts argv (`--mcp-config`/`--strict-mcp-config`/`--allowedTools` and `-c mcp_servers…`), token-gated path, teardown on done, abort, and consumer break.
8. Structured output: four targets, valid parse → `structured`, invalid → `parse_failed`; codex temp-file cleanup.
9. Images: block mapping per target; claude/cli stream-json stdin rendering; codex temp-file + `-i` argv; text-only path byte-identical to v1 stdin.
10. Contract suite: same neutral request through all four backends (faked transports) asserting identical normalized shape — for `generate` and `generateStream`, plus one request per new feature tier (reasoning, structured output, tools) through every supporting target, asserting `toolCalls` records and stream event ordering (`tool_call` before its `tool_result`; `done` last, once). For `claude`/`cli` the delta-concatenation equality holds because fixtures are single-message turns (see Streaming contract).
11. Streaming adapter tests: canned SSE bodies via injected fetch (API flavors); fake runner emitting incremental JSONL lines (CLI flavors). Cover multi-delta happy path, zero-delta + done, reasoning deltas, mid-stream provider error, malformed event, abort mid-stream (rejects with signal.reason, subprocess group killed), early consumer break (transport cleaned up).
12. Example compiles (`tsc --noEmit` covers it).
13. Verification: build + test + coverage + lint + typecheck all green.
14. Integration (opt-in, real binaries) must characterize what fixtures cannot: claude `--json-schema` result field, codex `--output-schema`, both MCP bridge handshakes, claude stream-json image input, `--effort`/`model_reasoning_effort` acceptance.

## Boundaries

- **Always:** validate public inputs; matrix-gate before transport; keep public
  types provider-neutral; use official SDKs for API flavors; keep default tests
  offline/deterministic; pass CLI prompts through stdin; scratch files in
  `os.tmpdir()` with cleanup in `finally`; loopback-only bridge with unguessable
  path; run full verification before commits.
- **Ask first:** new providers/flavors; non-official dependencies (incl.
  `@modelcontextprotocol/sdk` if the minimal bridge proves brittle); relaxing the
  strict portability policy; document input on CLI flavors (needs binary
  verification first); publishing to npm (`npm publish` is a user action); real
  billable API/CLI calls.
- **Never:** commit credentials; interpolate prompts into a shell string; silently
  drop or ignore a request feature; expose SDK types publicly; auto-execute tools
  the user did not pass; bind the bridge to a non-loopback interface; delete
  failing tests to go green.

## Success Criteria

- `npm pack` produces a publishable package: dual ESM/CJS + types, correct
  `exports` map, files whitelist, metadata (license MIT, repo, keywords).
- One unchanged `generate` call — including one using tools + structured output +
  reasoning — works across every supporting target with only config changes.
- Every ✅ matrix cell has an offline test; every ❌ cell throws
  `unsupported_feature` with an actionable message.
- v1 call sites compile and behave identically (the only breaking change is
  `Message.text` becoming optional in favor of `text` XOR `content` — plain
  `{ role, text }` object literals never see it; resolves open question 1).
- `npm run build && npm test && npm run lint && npm run typecheck` green, offline.
- README documents the four-target matrix, the strict policy, auth setup, CLI/API
  limitations, and error handling — easy to follow.
- CLAUDE.md documents project structure and commands.

## Reference

This library is a deliberate 1:1 port of the Go library at
`github.com/lao/llmwrapper`: CLI argv construction, JSON/JSONL parsing,
usage-field mappings, and error fallback chains mirror the Go source. The v2
generation-parity features (capability matrix, tools, structured output, images,
reasoning) extend that base for the TypeScript SDK surface. Do not change ported
semantics without updating this spec first.
