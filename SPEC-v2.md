# Spec v2: llm-driver — SDK generation parity

Status: **DRAFT — pending approval.** On approval this merges into SPEC.md (v1 stays
valid; v2 is additive except where marked BREAKING). Implementation follows the
phase plan at the bottom; each phase lands separately with all five gates green.

## Objective

Close the feature gap between `llm-driver` and the official SDKs (Anthropic
Messages API TS SDK, OpenAI Responses API Node SDK) for **core generation**:
everything expressible in a single `generate()`/`generateStream()` call. A call
site written against `llm-driver` should be able to use sampling parameters,
client tool calling, structured output, image input, and reasoning controls —
and keep working across all four provider/flavor targets wherever the target can
honor the feature.

**Out of scope (decided):** platform APIs — batches, files-as-storage,
embeddings, moderation, image/audio generation, token counting, vector stores,
server-side conversation state (`previous_response_id`), admin/usage APIs,
server tools (web search, code execution, computer use), prompt caching
breakpoints (`cache_control`), citations. The library stays a text-generation
driver; transcripts remain client-side.

### Portability policy (decided: strict)

Every new request feature is either honored or rejected — never silently
dropped. A request using a feature the selected target cannot honor throws
`LLMDriverError` with new code **`unsupported_feature`** at `generate()` time
(before any transport work; from first `next()` for streams), with `message`
naming the feature and target. The support matrix below is normative and ships
in README.

Existing exception stays: `maxTokens` remains required and validated on CLI
flavors even though they cannot enforce it (v1 contract, unchanged).

## Feature matrix (normative)

| Feature | claude/api | openai/api | claude/cli | codex/cli |
|---|---|---|---|---|
| `temperature` | ✅ `temperature` | ✅ `temperature` | ❌ | ❌ |
| `topP` | ✅ `top_p` | ✅ `top_p` | ❌ | ❌ |
| `topK` | ✅ `top_k` | ❌ (no equivalent) | ❌ | ❌ |
| `stopSequences` | ✅ `stop_sequences` | ❌ (Responses API has none) | ❌ | ❌ |
| `reasoning.effort` | ✅ `output_config.effort` | ✅ `reasoning.effort` | ✅ `--effort` | ✅ `-c model_reasoning_effort=` |
| `outputSchema` (structured output) | ✅ `output_config.format` | ✅ `text.format` json_schema | ✅ `--json-schema` | ✅ `--output-schema <tmpfile>` |
| `tools` (client tools, handler-based) | ✅ tool loop | ✅ tool loop | ✅ MCP bridge | ✅ MCP bridge |
| `toolChoice` | ✅ | ✅ | ❌ (CLI owns its loop) | ❌ |
| Image input | ✅ `image` block | ✅ `input_image` | ✅ stream-json content block | ✅ `-i <tmpfile>` |
| Document/PDF input | ✅ `document` block | ✅ `input_file` | ❌ (phase 2 if CLI supports) | ❌ |
| `metadata.userId` | ✅ `metadata.user_id` | ✅ `safety_identifier` | ❌ | ❌ |
| `timeoutMs` | ✅ SDK timeout | ✅ SDK timeout | ✅ kill process group | ✅ kill process group |
| `maxRetries` | ✅ SDK retries | ✅ SDK retries | ❌ (re-running an agent is not idempotent) | ❌ |
| Reasoning stream events | ✅ thinking deltas | ✅ reasoning summary deltas | ✅ stream-json thinking | ⚠️ best-effort (`agent_reasoning` events; may be absent) |
| Tool-call stream events | ✅ | ✅ | ✅ (MCP bridge observes calls) | ✅ (MCP bridge observes calls) |

❌ = throws `unsupported_feature`. ⚠️ = emitted when the target reports it; absence is not an error (mirrors v1 delta-granularity stance).

CLI flag mappings above are verified against `claude` (2026-08, has `--json-schema`,
`--effort`, `--mcp-config`, `--strict-mcp-config`, `--tools`, `--allowedTools`,
`--input-format stream-json`) and `codex-cli 0.147.0` (has `--output-schema`,
`-i/--image`, `-c` overrides, `--json`). The opt-in integration test is the
authority for behavior the fixtures cannot prove (see Testing).

## Public API additions

All v1 surface unchanged unless marked BREAKING.

```ts
interface Config {
  // ...v1 fields...
  timeoutMs?: number;       // all flavors; default: SDK default (api) / none (cli)
  maxRetries?: number;      // api flavors only (invalid_config on cli)
}

interface Request {
  system?: string;
  messages: Message[];
  maxTokens: number;

  // Sampling (api flavors; see matrix)
  temperature?: number;         // passed through verbatim; provider range rules apply
  topP?: number;
  topK?: number;                // claude/api only
  stopSequences?: string[];     // claude/api only

  reasoning?: { effort: "minimal" | "low" | "medium" | "high" };
  outputSchema?: JsonSchema;    // structured output; JsonSchema = object (JSON Schema draft the providers accept)
  tools?: Tool[];
  toolChoice?: "auto" | "none" | "required" | { name: string };  // api flavors only
  metadata?: { userId?: string };
}

/** Handler-based client tool. The LIBRARY runs the loop on every target. */
interface Tool {
  name: string;                       // ^[a-zA-Z0-9_-]{1,64}$
  description: string;
  inputSchema: JsonSchema;
  execute(input: unknown, ctx: { signal?: AbortSignal }): Promise<ToolOutput> | ToolOutput;
}
type ToolOutput = string | { text: string; isError?: boolean };

/** Message content grows blocks; string-only messages unchanged. */
interface Message {
  role: Role;
  text?: string;                      // BREAKING (minor): was required; now text XOR content
  content?: ContentBlock[];
}
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { base64: string; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" } | { url: string } }
  | { type: "document"; source: { base64: string; mediaType: "application/pdf" } };  // api flavors only

function user(text: string): Message;                 // unchanged
function user(content: ContentBlock[]): Message;      // new overload
// assistant() gains the same overload.

interface Response {
  // ...v1 fields...
  structured?: unknown;     // parsed JSON when outputSchema was set; parse_failed if output is not valid JSON
  toolCalls: ToolCallRecord[];  // [] when no tools ran; audit trail of the loop
}
interface ToolCallRecord {
  id: string;               // provider call id, or bridge-generated on cli
  name: string;
  input: unknown;
  output: ToolOutput;       // what execute() returned (normalized to object form)
  isError: boolean;
}

type CompletionReason = "stop" | "max_tokens" | "refusal" | "";  // unchanged — tool loops end in a terminal reason

type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }                          // new: thinking/reasoning summary deltas
  | { type: "tool_call"; id: string; name: string; input: unknown }   // new: after inputs are complete, before execute()
  | { type: "tool_result"; id: string; name: string; output: ToolOutput; isError: boolean }  // new
  | { type: "done"; response: Response };                        // unchanged: exactly once, last

type ErrorCode =
  | /* v1 codes */ "invalid_config" | "invalid_request" | "executable_not_found"
  | "process_failed" | "parse_failed" | "api_error" | "transport_failed"
  | "unsupported_feature"   // new
  | "tool_failed";          // new: execute() threw (rejected promise), distinct from isError result
```

Contract notes:

- **v1 text-only concatenation guarantee narrows**: concatenated `text` deltas
  equal `done.response.text` *for the final assistant message*; with tools, text
  produced before tool calls streams as `text` events but only the final
  message's text lands in `response.text` (this generalizes the existing
  `claude`/`cli` scoping to all targets — it becomes the uniform rule when
  `tools` is set; without `tools`, v1 guarantee is unchanged).
- `reasoning` events never contribute to `response.text`.
- `outputSchema` + `tools` together: allowed where both are supported
  (all four targets); the schema constrains the final message.
- Abort contract unchanged: `signal.reason` raw, everywhere — including while an
  `execute()` handler is in flight (handler receives the same signal via `ctx`).
- `execute()` **throw** → the loop stops, `generate` rejects `tool_failed`
  (cause = thrown error). `execute()` *returning* `{isError: true}` → error is
  reported to the model as a failed tool result and the loop continues (SDK
  semantics).
- Tool loop bound: hard cap of 16 rounds per `generate()` on api flavors
  (`api_error` code? no — `tool_failed`? neither: throws `LLMDriverError` code
  `tool_loop_exceeded`? — **Open question 3**). CLI flavors have no client-side
  loop; the CLI owns termination.

## Backend semantics

### API flavors — tool loop

`generate` with `tools` runs the standard agentic loop client-side: send request
→ if response contains tool calls, run each `execute()` (parallel calls run
concurrently), append assistant tool-use turn + tool results to a private copy
of the transcript, resend → repeat until terminal stop. Every round respects
`signal`. `generateStream` streams every round's deltas and emits
`tool_call`/`tool_result` between rounds.

Mappings: Anthropic `tools[].input_schema` / `tool_use` / `tool_result` blocks;
OpenAI `tools[].type:"function"` / `function_call` / `function_call_output`
items. `toolChoice` maps to `tool_choice` (`required` → Anthropic `any`).

### CLI flavors — MCP bridge

The CLI runs its own agentic loop; the library injects user tools into it as an
MCP server and executes handlers in-process when the CLI calls them.

- Library starts an in-process **streamable-HTTP MCP endpoint** on
  `127.0.0.1:<ephemeral port>` for the duration of the subprocess. Minimal
  JSON-RPC implementation over `node:http` — `initialize`, `tools/list`,
  `tools/call` only. **No new runtime dependency** (the `@modelcontextprotocol/sdk`
  is not needed for three methods; revisit if protocol churn bites).
- Claude argv adds: `--mcp-config '{"mcpServers":{"llmdriver":{"type":"http","url":"http://127.0.0.1:<port>/mcp"}}}'
  --strict-mcp-config --allowedTools mcp__llmdriver__<name>...` (one per tool, so
  no permission prompts; built-in tools stay at their v1 defaults).
- Codex argv adds: `-c mcp_servers.llmdriver.url="http://127.0.0.1:<port>/mcp"`
  (transport key syntax verified in integration test; codex 0.147 supports
  streamable HTTP MCP servers).
- `tools/call` invokes `execute()` in-process; result → MCP content. Bridge
  records `ToolCallRecord`s and (in streaming mode) emits
  `tool_call`/`tool_result` events as calls arrive.
- Server binds loopback only, single-use bearer token in the URL path
  (`/mcp/<random>`) so another local process cannot call handlers. Torn down in
  `finally` alongside the process-group kill.
- `toolChoice` is `unsupported_feature` on cli (the CLI decides when to call).

### Structured output

- claude/api: `output_config.format = {type:"json_schema", schema}`.
- openai/api: `text.format = {type:"json_schema", name:"output", schema, strict:true}`.
- claude/cli: `--json-schema '<schema JSON>'`; result parsed from the json
  result payload (field verified in integration test).
- codex/cli: schema written to a scratch temp file, `--output-schema <path>`,
  file deleted in `finally`.
- All targets: adapter parses final text as JSON into `response.structured`;
  invalid JSON → `parse_failed`.

### Images

- claude/cli: switch stdin to `--input-format stream-json` and send the
  transcript as user messages with content blocks (text + image base64 blocks).
  Text-only requests keep the v1 plain-stdin path byte-for-byte (no regression
  risk).
- codex/cli: base64 images written to scratch temp files, passed via `-i`;
  URL-source images are `unsupported_feature` on codex/cli (no flag for URLs).
  Note `-i` attaches to the *initial prompt* — multi-turn transcripts with
  images in earlier turns are `unsupported_feature` on codex/cli; images only in
  the final user turn.
- API flavors: direct block mapping (base64 + URL both supported).

### Reasoning

- Request `reasoning.effort` maps per the matrix. Values are passed through the
  library's neutral enum; targets that reject a given level surface the
  provider's own error (`api_error`/`process_failed`) — the library does not
  maintain per-model capability tables (same stance as v1 on `model`).
- Streaming: Anthropic thinking deltas, OpenAI reasoning-summary deltas, claude
  stream-json thinking chunks → `reasoning` events. Codex: mapped only if its
  JSONL exposes reasoning events; otherwise none (documented, matrix ⚠️).

## Tech stack

Unchanged (TS strict, tsup dual build, Node ≥ 20, `@anthropic-ai/sdk` + `openai`
only). The MCP bridge uses `node:http` + `node:crypto`. typescript stays ^5.9.

## Commands

Unchanged (v1). Integration test env vars gain nothing new; the same
`LLMWRAPPER_*_CLI_MODEL` gates cover the new CLI paths.

## Project structure (delta)

```text
src/capabilities.ts        feature × target support matrix + strict gate (single source of truth)
src/backends/tool-loop.ts  shared api-flavor tool loop
src/backends/mcp-bridge.ts loopback streamable-HTTP MCP server for cli flavors
```

Everything else stays where v1 put it. Adapters keep SDK imports confined.

## Code style

Unchanged (v1). New rule: the support matrix lives ONLY in `capabilities.ts`;
adapters never hand-roll "is this supported" checks.

## Testing strategy (delta)

All v1 suites stay. New, all offline by default:

1. **Capability gate tests**: every ❌ cell in the matrix throws
   `unsupported_feature` naming the feature; every ✅ cell does not throw at the
   gate. Table-driven from the same matrix data.
2. **Tool loop (api)**: injected fetch returning tool_use → tool_result round
   trips; parallel calls; `execute` throw → `tool_failed`; `isError` result
   continues loop; loop cap; abort mid-handler.
3. **MCP bridge**: real `node:http` server + fake runner acting as the CLI —
   drives `initialize`/`tools/list`/`tools/call` against the live loopback
   endpoint; asserts argv (`--mcp-config`, `--strict-mcp-config`,
   `--allowedTools` / `-c mcp_servers…`), token-gated path, teardown on done,
   abort, and consumer break.
4. **Structured output**: four targets, valid parse → `structured`, invalid →
   `parse_failed`; codex temp-file cleanup.
5. **Images**: block mapping per target; claude/cli stream-json stdin rendering;
   codex temp-file + `-i` argv; text-only path byte-identical to v1 stdin.
6. **Contract suite extension**: one neutral request per new feature tier
   (reasoning, structured output, tools) through every supporting target,
   asserting identical normalized shape, `toolCalls` records, and stream event
   ordering (`tool_call` before its `tool_result`; `done` last, once).
7. **Integration (opt-in, real binaries)** must newly characterize:
   claude `--json-schema` result field, codex `--output-schema`, both MCP bridge
   handshakes, claude stream-json image input, `--effort`/`model_reasoning_effort`
   acceptance. These are the truths fixtures cannot prove.

## Boundaries

- **Always:** matrix-gate before transport; keep new public types provider-neutral;
  scratch files in `os.tmpdir()` with cleanup in `finally`; loopback-only bridge
  with unguessable path; five gates green per phase.
- **Ask first:** adding `@modelcontextprotocol/sdk` (only if the minimal bridge
  proves brittle); any new provider/flavor; relaxing the strict policy; document
  support on CLI flavors (needs binary verification first).
- **Never:** silently drop a request feature; expose SDK types publicly; shell
  interpolation (unchanged); auto-execute tools the user did not pass; bind the
  bridge to a non-loopback interface.

## Phase plan (implementation order)

Each phase = separately mergeable, gates green, SPEC.md + README matrix updated.

1. **Capability framework** — `capabilities.ts`, `unsupported_feature`, request
   fields + validation for temperature/topP/topK/stopSequences/metadata,
   api-flavor mappings. Small; establishes the pattern.
2. **Reasoning effort** — all four targets + `reasoning` stream events for the
   three that report them.
3. **Structured output** — all four targets, `response.structured`.
4. **Image input** — content blocks, `user()` overload, four-target mappings
   (claude/cli stream-json stdin switch is the risky bit).
5. **Tools on api flavors** — `Tool`/`execute`, shared tool loop, `toolCalls`,
   `tool_call`/`tool_result` events, `tool_failed`.
6. **MCP bridge** — cli-flavor tools. Heaviest; lands last, behind everything
   already proven on api flavors.
7. **Config polish** — `timeoutMs` (all), `maxRetries` (api). Optional tail.

Dependencies: 1 → everything; 5 → 6; others independent after 1.

## Success criteria

- Every ✅ cell in the matrix demonstrably works (offline test per cell;
  integration test for CLI cells).
- Every ❌ cell throws `unsupported_feature` with an actionable message.
- One call site using tools + structured output + reasoning runs unmodified on
  all four targets (the new contract test IS this criterion).
- v1 call sites compile and behave identically (no breaking changes except the
  documented `Message.text` optionality, which plain object literals never see).
- Five gates green; README documents the matrix and the strict policy.

## Open questions

1. **`Message.text` optionality** is technically breaking for code that reads
   `message.text` expecting `string`. Acceptable at 0.x? Alternative: keep
   `text: string` required and put blocks in a separate `attachments` field
   (uglier, fully compatible).
2. **Handler-less tools on api flavors** (SDK low-level mode: return `tool_use`
   to the caller instead of looping). Deliberately omitted — the uniform
   handler-based contract is what keeps call sites target-portable. Add later
   only if a real consumer needs single-round control.
3. **Tool-loop cap exceeded**: which error code — reuse `tool_failed`, or a
   dedicated `tool_loop_exceeded`? Draft says dedicated code is cleaner;
   confirm.
4. **Codex MCP config keys**: exact `-c mcp_servers.*` syntax for streamable
   HTTP in codex 0.147 needs binary verification before phase 6 argv freezes.
5. **PDF/document input on claude/cli**: stream-json input may accept `document`
   blocks; if the integration test proves it, the matrix cell flips to ✅ in a
   follow-up.
