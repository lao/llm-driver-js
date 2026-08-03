# Plan: llm-shim npm package

Source of truth: `SPEC.md`. Go reference implementation: `/Users/lucas/Projects/claudewrap`
(builders MUST read the referenced Go files before porting — argv, parsing, and
error semantics are ported 1:1 unless SPEC.md says otherwise).

Orchestration: Fable authored spec+plan. Build tasks run as Opus subagents —
`effort: high` for scaffold/core/glue ("basic work"), `effort: max` for the four
backend adapters ("heavy work"). Note: harness exposes model alias `opus` only;
version (4.8 vs 5) cannot be pinned per-call.

## Dependency graph

```
T1 scaffold ──► T2 core (types/errors/config/client) ──► T3 API backends ──┐
                                              └────────► T4 CLI backends ──┼──► T5 contract+example
                                                                           ▼
                                              review ──► simplify ──► ship
```

T3 and T4 run in parallel after T2.

## Tasks

### T1 — Scaffold toolchain (opus, high)

package.json (name `llm-shim`, version 0.1.0, MIT, `engines.node >= 20`,
`exports` map for ESM+CJS+types, `files: ["dist"]`, scripts per SPEC Commands),
tsconfig strict NodeNext, biome.json, vitest.config.ts (coverage v8, excludes
integration by default), tsup.config.ts (entry src/index.ts, esm+cjs+dts),
.gitignore, `src/index.ts` placeholder.

**Accept:** `npm install && npm run build && npm run lint && npm run typecheck && npm test` all exit 0 (test may report "no tests" — configure vitest `passWithNoTests`).

### T2 — Core: types, errors, config, client (opus, high)

`src/types.ts`, `src/errors.ts` (LLMShimError per SPEC), `src/config.ts`
(validation incl. cross-flavor option rejection), `src/backends/backend.ts`
(internal `Backend = { generate(request, signal?): Promise<Response> }`),
`src/client.ts` (createClient → validate config → select backend via a 4-entry
switch; generate validates request then delegates, stamps provider/flavor).
Backends stubbed to throw until T3/T4. Tests: `test/config.test.ts`,
`test/request.test.ts` per SPEC Testing 1–2. Port validation rules from Go
`config.go` / `types.go` (read them).

**Accept:** vitest green; all four pairs construct; every invalid case yields LLMShimError with correct `code`.

### T3 — API backends: anthropic-api + openai-api + tests (opus, **max**)

Port `backend_anthropic.go` and `backend_openai.go`. Anthropic Messages via
`@anthropic-ai/sdk` (system → top-level system, maxTokens → max_tokens, usage +
stop_reason mapping); OpenAI Responses via `openai` (system → instructions,
maxTokens → max_output_tokens, usage incl. cached/reasoning tokens,
incomplete/refusal mapping). Both accept `apiKey`, `baseUrl`, `fetch` overrides.
Normalize SDK errors → LLMShimError (`api_error` with status+providerCode;
`transport_failed` for network). Tests per SPEC Testing 3: injected fetch or
local `node:http` server via baseUrl; no network.

**Accept:** request mapping, auth header, response/usage mapping, HTTP 400/401/429/500 normalization all asserted offline.

### T4 — CLI backends: shared runner + claude-cli + codex-cli + tests (opus, **max**)

Port `backend_cli.go`, `backend_claude_cli.go`, `backend_codex_cli.go` exactly:

- Shared runner (`src/backends/cli.ts`): `spawn` (never shell), stdin = rendered
  transcript, bounded stdout/stderr capture (16 MiB), ENOENT →
  `executable_not_found`, non-zero exit → `process_failed` (status=exit code,
  message=trimmed stderr, fallback "CLI command failed"), AbortSignal → SIGTERM
  then SIGKILL after 250 ms grace. Runner injectable for tests
  (internal, not in public API).
- Transcript rendering: single user message → raw text; otherwise
  `User: `/`Assistant: ` blocks joined by blank lines.
- Claude argv: `-p --output-format json --permission-mode default --model <m>`
  `[--append-system-prompt <system>] [...cliArgs]`. Parse single JSON object:
  require `type==="result" && subtype==="success" && !is_error` else `api_error`
  with code from subtype/error fallback chain; map usage
  (cache_read→cachedInputTokens, cache_creation→cacheCreationInputTokens),
  id=session_id.
- Codex argv: `exec --json --sandbox read-only --skip-git-repo-check --model <m>`
  `[--config developer_instructions=<JSON-encoded system>] [...cliArgs] -`.
  Parse JSONL: thread.started→id, item.completed(agent_message)→text,
  turn.completed→usage (cached_input→cached, cache_write→cacheCreation,
  reasoning_output→reasoning), turn.failed/error→`api_error`; missing
  completion/message → `parse_failed`-family errors with codes
  `missing_turn_completion`/`missing_final_message`. On non-zero exit, attempt
  diagnostic parse of stdout for turn_failed/error (port Go logic).

Tests per SPEC Testing 4 with fake runner: exact argv, stdin, parse success,
usage, ENOENT, exit≠0, malformed JSON/JSONL, provider-reported failure, abort.

**Accept:** all above cases asserted; no real process spawned in default suite (fake runner everywhere except one spawn-wrapper test may use `node -e`).

### T5 — Contract suite, example, opt-in integration (opus, high)

`test/contract.test.ts`: same neutral request through all four backends (faked
transports) → identical normalized shape, provider/flavor stamped.
`examples/switchable.ts`: argv parsing via `node:util` parseArgs
(--provider/--flavor/--model/--prompt/--system/--max-tokens), prints text+usage.
`test/integration.test.ts`: describe.skipIf(!env) real-CLI smoke per SPEC.

**Accept:** contract suite green; `npm run example -- --help`-style usage works; integration skipped by default.

### Checkpoint after T5

Full gate: `npm run build && npm test && npm run test:coverage && npm run lint && npm run typecheck` — all green before review phase.

### Post-build phases (tracked in session task list)

- **Review** (opus, max): five-axis review via agent-skills:review; fix FIX findings.
- **Simplify** (opus, high): agent-skills:code-simplify; behavior-preserving; gate stays green.
- **Ship** (Fable + opus high): README per SPEC success criteria; CLAUDE.md via /init;
  `npm pack --dry-run` verification; conventional commits. `npm publish` left to user.
