# Plan: llm-driver v2 — SDK generation parity

Source of truth: `SPEC-v2.md` (merges into `SPEC.md` at ship). v1 build plan is in
git history of this file (tag v0.1.0 era). Builders MUST read SPEC-v2's feature
matrix and Backend semantics before touching an adapter — the matrix in
`src/capabilities.ts` is the single source of truth; adapters never hand-roll
support checks.

Standing rules for every task:
- All five gates green before the task is done: `npm run build && npm test && npm run lint && npm run typecheck && npm run test:coverage`.
- Default test suite stays fully offline (injected fetch / fake runner). Real-binary
  facts go in `test/integration.test.ts` behind the existing env-var gates.
- New request features either honored or `unsupported_feature` — never dropped.
- `test/contract.test.ts` grows one neutral fixture per feature tier; extend it in
  the task that lands the tier's last target.

## Dependency graph

```
T1 capability framework (+temperature proving path)
 ├─► T2 remaining sampling params + metadata
 ├─► T3 reasoning effort (4 targets) ─► T4 reasoning stream events
 ├─► T5 structured output (api) ─► T6 structured output (cli)
 ├─► T7 content blocks + images (api) ─► T8 claude/cli images ─► T9 codex/cli images
 └─► T10 tools + loop (anthropic/api) ─► T11 tools (openai/api) ─► T12 tool stream events
                                              └────────► T13 MCP bridge core ─► T14 claude/cli tools ─► T15 codex/cli tools
T16 timeouts/retries (after T1, anytime)
T17 docs + SPEC merge (last)
```

T2–T5, T7, T10, T16 are parallelizable after T1 (independent request fields), but
each touches `types.ts`/`capabilities.ts`/`contract.test.ts` — if run in parallel
use separate sessions per branch and merge sequentially to avoid churn.
High-risk early: T8 (stdin path switch) and T13 (bridge) are the two riskiest;
T13 deliberately has no CLI coupling so it can start early if desired.

## Phase 1 — Foundation

### T1 — Capability framework + `unsupported_feature` + temperature

**Description:** Add `src/capabilities.ts` exporting the feature × target matrix
(SPEC-v2 table, one entry per gated request field) and a
`assertSupported(request, config)` gate called from `validateRequest` in
`src/client.ts`. Add error code `unsupported_feature` to `src/errors.ts`. Add
`Request.temperature` as the proving vertical: validated (finite number), gated
(❌ on both cli targets), mapped in both api adapters (`temperature` passthrough).

**Acceptance criteria:**
- [ ] `temperature` on claude/api + openai/api reaches the wire verbatim (asserted via injected fetch).
- [ ] `temperature` on either cli target throws `LLMDriverError` code `unsupported_feature`, message names feature + `provider/flavor`, thrown before any spawn (fake runner never invoked); streams throw from first `next()`.
- [ ] Matrix is data (single table), gate is generic — adding a field = one matrix row + adapter mapping, no new gate code.

**Verification:** `npx vitest run test/capabilities.test.ts test/anthropic-api.test.ts test/openai-api.test.ts`; full gates.
**Dependencies:** None.
**Files:** `src/capabilities.ts` (new), `src/errors.ts`, `src/types.ts`, `src/client.ts`, `src/backends/anthropic-api.ts`, `src/backends/openai-api.ts`, `test/capabilities.test.ts` (new).
**Scope:** M

### T2 — Remaining sampling params + metadata

**Description:** Matrix rows + validation + api mappings for `topP` (both apis),
`topK` (claude/api only — ❌ openai/api), `stopSequences` (claude/api only),
`metadata.userId` (claude/api `metadata.user_id`; openai/api `safety_identifier`).

**Acceptance criteria:**
- [ ] Each ✅ cell asserted on the wire; each ❌ cell throws `unsupported_feature` (table-driven test iterating the matrix itself).
- [ ] `stopSequences` → `stop_sequences`; Anthropic `stop_reason: "stop_sequence"` normalizes to completionReason `"stop"`.

**Verification:** capability + both api adapter suites; full gates.
**Dependencies:** T1.
**Files:** `src/capabilities.ts`, `src/types.ts`, `src/backends/anthropic-api.ts`, `src/backends/openai-api.ts`, + 3 test files.
**Scope:** S

### Checkpoint 1
- [ ] Five gates green; matrix-driven test proves every cell of the sampling tier.
- [ ] Human review: capability gate ergonomics (error message quality) before scaling to more tiers.

## Phase 2 — Reasoning

### T3 — `reasoning.effort` on all four targets

**Description:** `Request.reasoning?: { effort }` with neutral enum
`"minimal" | "low" | "medium" | "high"`. Mappings: anthropic-api
`output_config.effort`; openai-api `reasoning.effort`; claude-cli argv
`--effort <level>`; codex-cli `-c model_reasoning_effort="<level>"`. Invalid
level values → `invalid_request`. Unknown-to-provider levels pass through
(provider error surfaces as `api_error`/`process_failed`, per SPEC).

**Acceptance criteria:**
- [ ] Wire/argv assertions for all four targets (injected fetch; fake runner argv snapshot).
- [ ] Omitting `reasoning` produces byte-identical argv/body to v1 (no default injected).
- [ ] Contract suite: neutral reasoning request through all four backends, identical shape.

**Verification:** 4 adapter suites + `test/contract.test.ts`; full gates. Integration file gains `--effort` / `model_reasoning_effort` smoke (env-gated).
**Dependencies:** T1.
**Files:** `src/capabilities.ts`, `src/types.ts`, 4 adapter files, `test/*` (4 suites + contract + integration).
**Scope:** M

### T4 — `reasoning` stream events

**Description:** Extend `StreamEvent` with `{ type: "reasoning"; text: string }`.
Emit from: anthropic-api `thinking_delta`, openai-api
`response.reasoning_summary_text.delta`, claude-cli stream-json thinking chunks.
codex-cli: map `agent_reasoning` JSONL events if present, else emit nothing
(matrix ⚠️, absence is legal). `reasoning` text never contributes to
`response.text` or the text-concatenation guarantee.

**Acceptance criteria:**
- [ ] Canned SSE/JSONL fixtures produce interleaved `reasoning` + `text` events in source order; concatenated `text` still equals `done.response.text`.
- [ ] Zero reasoning events when target reports none — no placeholder events.

**Verification:** streaming adapter tests + client-stream + contract; full gates.
**Dependencies:** T3.
**Files:** `src/types.ts`, 4 adapter files, `test/client-stream.test.ts`, adapter stream tests, `test/contract.test.ts`.
**Scope:** M

### Checkpoint 2
- [ ] Reasoning tier fully green across matrix; stream event union change reviewed (consumer-breaking surface — confirm 0.x minor acceptable).

## Phase 3 — Structured output

### T5 — `outputSchema` on api flavors + `response.structured`

**Description:** `Request.outputSchema?: JsonSchema` (plain object). anthropic-api →
`output_config.format = {type:"json_schema", schema}`; openai-api →
`text.format = {type:"json_schema", name:"output", schema, strict:true}`.
When set, adapter JSON-parses final text into `response.structured`; invalid JSON
→ `parse_failed`. `Response.toolCalls`/`structured` additions to types (toolCalls
defaults `[]` everywhere — added now so Response shape changes once).

**Acceptance criteria:**
- [ ] Wire mapping asserted both apis; happy parse fills `structured`; garbage output → `parse_failed` with target identity.
- [ ] `outputSchema` absent → `structured` undefined, behavior identical to v1.

**Verification:** both api suites + contract; full gates.
**Dependencies:** T1.
**Files:** `src/capabilities.ts`, `src/types.ts`, 2 api adapters, their tests, `test/contract.test.ts`.
**Scope:** M

### T6 — `outputSchema` on cli flavors

**Description:** claude-cli: `--json-schema '<schema>'` argv; parse structured
payload from json result (exact field characterized by integration test; unit
fixtures encode current best knowledge). codex-cli: write schema to scratch file
(`fs.mkdtemp` under `os.tmpdir()`), `--output-schema <path>`, delete in `finally`
(also on abort/error). Same `structured`/`parse_failed` semantics.

**Acceptance criteria:**
- [ ] Fake-runner argv snapshots include the flag; codex temp file exists during run, gone after resolve/reject/abort (test hooks the fake runner to check).
- [ ] Contract suite: structured-output fixture through all four targets.
- [ ] Integration test: real `--json-schema` and `--output-schema` runs asserting parseable `structured` (env-gated).

**Verification:** both cli suites + cli.test.ts + contract + integration; full gates.
**Dependencies:** T5.
**Files:** `src/capabilities.ts`, 2 cli adapters, maybe `src/backends/cli.ts` (temp-file helper), their tests, contract, integration.
**Scope:** M

### Checkpoint 3
- [ ] Structured output green on all four targets offline; integration run executed at least once locally by human (billable — ask first).

## Phase 4 — Image input

### T7 — Content blocks + images on api flavors

**Description:** `Message` becomes `text` XOR `content: ContentBlock[]` (blocks:
`text`, `image` base64/url, `document` pdf — document api-only). `user()`/
`assistant()` gain block-array overloads. `validateRequest` enforces XOR,
non-empty, block well-formedness. anthropic-api maps `image`/`document` blocks;
openai-api maps `input_image`/`input_file`. Capability rows: images ✅ apis,
documents ✅ apis / ❌ clis (images on clis stay ❌ until T8/T9 flip their cells).

**Acceptance criteria:**
- [ ] Text-only literals (`{role, text}`) compile and behave exactly as v1 (regression suite untouched).
- [ ] Block transcripts map correctly on both apis (wire assertions incl. media types, URL vs base64).
- [ ] XOR violations and empty/unknown blocks → `invalid_request` with index in message.

**Verification:** request + both api suites + contract image fixture (apis only for now); full gates.
**Dependencies:** T1.
**Files:** `src/types.ts`, `src/client.ts`, `src/capabilities.ts`, 2 api adapters, `test/request.test.ts`, 2 api test suites, contract.
**Scope:** M

### T8 — claude/cli image input (stream-json stdin) — HIGH RISK

**Description:** When any message carries blocks, claude-cli switches to
`--input-format stream-json` and writes the transcript as stream-json user/assistant
messages with content-block arrays (text + base64 image blocks). Text-only
requests keep the v1 plain-stdin path **byte-for-byte** (explicit regression
assertion). Flip claude/cli image matrix cell ✅.

**Acceptance criteria:**
- [ ] Fake-runner captures stdin: block transcript → valid stream-json lines with image blocks; text-only → identical bytes to v1 fixture.
- [ ] Argv gains `--input-format stream-json` only when blocks present.
- [ ] Integration test: real claude -p describes a small PNG (env-gated).

**Verification:** claude-cli suite + cli-routing + contract; full gates.
**Dependencies:** T7.
**Files:** `src/backends/claude-cli.ts`, maybe `src/backends/cli.ts` (stdin rendering seam), `src/capabilities.ts`, tests, integration.
**Scope:** M

### T9 — codex/cli image input (temp files + `-i`)

**Description:** Base64 image blocks written to scratch files, passed via
`-i <path>` (repeatable); cleanup in `finally`. Constraints enforced as
`unsupported_feature`: URL-source images; images anywhere except the final user
message (codex `-i` attaches to initial prompt only). Flip codex/cli image cell ✅
(with documented constraints).

**Acceptance criteria:**
- [ ] argv/tempfile assertions incl. multi-image; cleanup on resolve/reject/abort.
- [ ] URL image or non-final-turn image → `unsupported_feature` naming the constraint.

**Verification:** codex-cli suite + contract + integration smoke; full gates.
**Dependencies:** T7.
**Files:** `src/backends/codex-cli.ts`, `src/capabilities.ts`, tests, integration.
**Scope:** S

### Checkpoint 4
- [ ] Image fixture through all four targets in contract suite; v1 stdin regression assertion in place; human review of `Message` type ergonomics (open question 1 resolved for real).

## Phase 5 — Tools on api flavors

### T10 — Tool types + loop on anthropic/api

**Description:** Public `Tool` (name/description/inputSchema/`execute`),
`ToolOutput`, `ToolCallRecord`, `Request.tools`/`toolChoice`, error codes
`tool_failed` + `tool_loop_exceeded` (cap 16 rounds). New
`src/backends/tool-loop.ts`: generic loop over an adapter-provided "one round"
function — send, collect tool calls, run `execute()`s concurrently (each gets
`{signal}`), append tool_use/tool_result turns to private transcript copy,
repeat until terminal stop. Wire it into anthropic-api `generate` (non-streaming).
`execute` throw → reject `tool_failed`; `{isError:true}` return → reported to
model, loop continues. Records appended to `response.toolCalls`.

**Acceptance criteria:**
- [ ] Injected-fetch script: 2-round loop with parallel calls resolves; transcript sent on round 2 contains tool_use + tool_result blocks exactly per Messages API shape.
- [ ] `execute` rejection → `tool_failed` (cause preserved); 17th round → `tool_loop_exceeded`; abort mid-`execute` rejects with raw `signal.reason`.
- [ ] No `tools` in request → zero behavior change (loop not entered).

**Verification:** `test/tool-loop.test.ts` (new) + anthropic suite; full gates.
**Dependencies:** T1 (parallel-safe with T5/T7 but rebases on shared types).
**Files:** `src/types.ts`, `src/errors.ts`, `src/capabilities.ts`, `src/backends/tool-loop.ts` (new), `src/backends/anthropic-api.ts`, `test/tool-loop.test.ts` (new), anthropic tests.
**Scope:** M

### T11 — Tool loop on openai/api

**Description:** Same loop, openai round function: `tools[].type:"function"`,
`function_call` output items → calls, `function_call_output` input items →
results; `toolChoice` mapping (`required` → `"required"`, named →
`{type:"function", name}`; anthropic side `required` → `any` landed in T10).

**Acceptance criteria:**
- [ ] Mirror of T10 assertions on Responses API shapes; contract suite gains neutral tool fixture through both apis asserting identical `toolCalls` records and final text.

**Verification:** openai suite + tool-loop + contract; full gates.
**Dependencies:** T10.
**Files:** `src/backends/openai-api.ts`, `src/capabilities.ts`, tests, contract.
**Scope:** S

### T12 — Tool events in api streaming

**Description:** `StreamEvent` gains `tool_call` / `tool_result`.
`generateStream` on both api adapters streams every round: text deltas as they
come, `tool_call` when a call's input json completes, `tool_result` after
`execute()`. Text-concatenation contract narrows per SPEC-v2: with `tools` set,
concatenated `text` equals final message text only (pre-tool text streams but is
not in `response.text`); without `tools`, v1 guarantee untouched.

**Acceptance criteria:**
- [ ] Canned multi-round SSE: event order text* → tool_call → tool_result → text* → done; `tool_call` always precedes its `tool_result` (matched by `id`).
- [ ] Consumer `break` mid-loop aborts transport AND in-flight `execute` (signal observed).

**Verification:** both api stream tests + client-stream + contract stream fixture; full gates.
**Dependencies:** T10, T11.
**Files:** `src/types.ts`, `src/backends/tool-loop.ts`, 2 api adapters, stream tests, contract.
**Scope:** M

### Checkpoint 5
- [ ] Tools fully proven on api flavors (the shape MCP bridge must reproduce); human review of loop semantics + event ordering before bridge work.

## Phase 6 — MCP bridge (cli tools)

### T13 — Bridge core (no CLI coupling)

**Description:** `src/backends/mcp-bridge.ts`: loopback-only `node:http` server,
streamable-HTTP MCP JSON-RPC — `initialize`, `tools/list` (from `Tool[]`),
`tools/call` (runs `execute()` in-process, normalizes ToolOutput/isError to MCP
content, records `ToolCallRecord`, invokes an `onCall` observer for stream
events). Unguessable path `/mcp/<crypto.randomUUID()>`; non-matching path → 404;
non-loopback bind never. `start()` → `{ url, records, close() }`; `close()`
idempotent, called from adapter `finally`.

**Acceptance criteria:**
- [ ] Real HTTP round-trip test: initialize/list/call lifecycle against live server; call executes handler and returns MCP-shaped result; `isError` mapped.
- [ ] Wrong token path 404s without invoking anything; server closed after `close()` (connection refused); abort signal propagates to in-flight `execute`.

**Verification:** `test/mcp-bridge.test.ts` (new, real sockets on 127.0.0.1, still "offline"); full gates.
**Dependencies:** T10 (Tool types) — no CLI dependency; can start any time after T10.
**Files:** `src/backends/mcp-bridge.ts` (new), `test/mcp-bridge.test.ts` (new).
**Scope:** M

### T14 — claude/cli tools via bridge

**Description:** claude-cli with `tools`: start bridge, add argv
`--mcp-config '{"mcpServers":{"llmdriver":{"type":"http","url":"<bridge url>"}}}'
--strict-mcp-config --allowedTools mcp__llmdriver__<name>` (one per tool), tear
bridge down in `finally` (all exits: done, error, abort, consumer break).
`toolCalls` from bridge records; stream mode emits `tool_call`/`tool_result` via
`onCall`. `toolChoice` stays ❌ on cli. Flip claude/cli tools cell ✅.

**Acceptance criteria:**
- [ ] Fake-runner test: argv snapshot (config JSON parsed + asserted, not string-matched), bridge reachable during run, closed after resolve/reject/abort/break.
- [ ] Fake runner acting as CLI calls the real bridge over HTTP mid-"turn": records + stream events land, response.toolCalls populated.
- [ ] Integration: real claude -p calls a trivial in-process tool (env-gated).

**Verification:** claude-cli suite + mcp-bridge + contract tool fixture (3 targets now); full gates.
**Dependencies:** T13 (+T12 for events).
**Files:** `src/backends/claude-cli.ts`, `src/capabilities.ts`, tests, contract, integration.
**Scope:** M

### T15 — codex/cli tools via bridge

**Description:** Same for codex: `-c mcp_servers.llmdriver.url="<bridge url>"`
(exact key syntax for streamable HTTP in codex 0.147 verified by integration test
BEFORE argv freezes — SPEC-v2 open question 4; if codex needs stdio-only MCP,
stop and re-plan this task). Flip codex/cli tools cell ✅. Contract tool fixture
through all four targets — the spec's headline success criterion.

**Acceptance criteria:**
- [ ] Same trio as T14 (argv, live bridge round-trip, teardown).
- [ ] Contract suite: one call site with tools + outputSchema + reasoning runs unmodified on all four targets.
- [ ] Integration: real codex exec calls the tool (env-gated).

**Verification:** codex suite + contract + integration; full gates.
**Dependencies:** T13, T14 (pattern), integration verification of config syntax.
**Files:** `src/backends/codex-cli.ts`, `src/capabilities.ts`, tests, contract, integration.
**Scope:** M

### Checkpoint 6
- [ ] Full matrix green offline; both CLI integration runs executed by human (billable); teardown leak check (`lsof` no listener after suite).

## Phase 7 — Polish + ship

### T16 — `timeoutMs` + `maxRetries`

**Description:** `Config.timeoutMs`: api flavors → SDK timeout option; cli
flavors → timer that kills process group (reuses abort path), rejects
`process_failed` with timeout message. `Config.maxRetries`: api flavors → SDK
option; on cli → `invalid_config`.

**Acceptance criteria:**
- [ ] cli timeout kills group and rejects (fake runner with hung process, real `node -e` sleep for the spawn-path test); api options passed to SDK constructors (asserted via injected fetch behavior or constructor spy).
- [ ] Timeout races abort correctly: user abort still rejects with raw `signal.reason`.

**Verification:** config + cli + both api suites; full gates.
**Dependencies:** T1.
**Files:** `src/types.ts`, `src/config.ts`, `src/backends/cli.ts`, 2 api adapters, tests.
**Scope:** M

### T17 — Docs + SPEC merge + example

**Description:** Merge SPEC-v2 into SPEC.md (feature matrix normative, v2
sections integrated, SPEC-v2.md deleted). README: matrix, strict policy, tools
quick start, structured output, images, reasoning. `examples/switchable.ts`
gains `--schema`/`--effort`/demo tool flag. Update CLAUDE.md architecture notes
(capabilities.ts, tool-loop, mcp-bridge). Resolve remaining SPEC open questions
in text.

**Acceptance criteria:**
- [ ] SPEC.md is the single spec again; README matrix matches `capabilities.ts` (eyeball or generated).
- [ ] Example runs against at least one real target with new flags (human, billable).

**Verification:** full gates + `npm pack --dry-run`.
**Dependencies:** everything.
**Files:** `SPEC.md`, `SPEC-v2.md` (delete), `README.md`, `CLAUDE.md`, `examples/switchable.ts`.
**Scope:** M

### Final checkpoint
- [ ] Every ✅ matrix cell has an offline test; every ❌ cell has an `unsupported_feature` test.
- [ ] v1 call sites: full v0.1.0 test suite passes unmodified (except deliberate StreamEvent union widening).
- [ ] Five gates + coverage green; review (five-axis) + simplify passes before release commit; semver: minor bump (0.2.0).

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| claude/cli stream-json stdin breaks v1 text path | High | T8 keeps plain path byte-for-byte, asserted against frozen v1 fixture |
| codex MCP-over-HTTP config syntax wrong/unsupported | High (blocks T15) | Verify against real binary at T13 completion, before T15 argv freezes; fallback = re-plan T15 (stdio bridge subprocess) |
| Hand-rolled MCP endpoint vs protocol drift | Med | Only 3 methods; integration tests pin real-binary compat; escalate to official SDK dep only if it breaks (ask first) |
| `StreamEvent` union widening breaks exhaustive switches downstream | Low (0.x) | Document in README changelog; single minor bump |
| `--json-schema` result field shape assumption | Med | Unit fixtures marked "characterized by integration"; T6 integration run required before checkpoint 3 sign-off |
| Parallel tasks colliding on types.ts/capabilities.ts | Med | Merge sequentially; matrix rows are append-only |

## Open questions (carried from SPEC-v2)

- `tool_loop_exceeded` as dedicated code — plan assumes YES (T10); veto before T10 starts.
- `Message.text` optionality vs `attachments` field — plan assumes XOR design (T7); veto before T7.
- Handler-less tool mode — excluded; revisit only on real consumer demand.
