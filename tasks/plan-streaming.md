# Plan: streaming support (`generateStream`) — v0.2.0

Source of truth: SPEC.md ("Streaming contract" section). Branch: `feat/streaming`.
Goal: PR against `main` on lao/llmwrapper-js.

Orchestration: Fable authored spec+plan. All remaining phases run as **opus,
effort high** agents (user directive).

## Design decisions (pinned)

- `generateStream` is an **async generator** on the client: request-validation
  errors surface on the first `next()` (async-generator semantics), not at call
  time. Document in README.
- `Backend` interface gains `generateStream(request, signal?): AsyncIterable<StreamEvent>`.
  Adapters implement `generate` and `generateStream` independently — no forced
  shared path.
- Client stamps `provider`/`flavor`/`model` on the `done` event's Response,
  reusing the same stamping as `generate`.
- Internal CLI runner gains a **streaming variant**: same spawn/abort/group-kill
  /bounded-capture semantics, but exposes stdout as an async line iterator while
  stderr stays buffered (for process_failed messages). Buffered runner stays for
  `generate`. The streaming seam is injectable for tests like the existing one.
- Early consumer `break`/`return`: generator `finally` must abort/kill transport.

## Dependency graph

```
ST1 core plumbing ──► ST2 API streaming ──┐
                └────► ST3 CLI streaming ──┴─► ST4 contract+example+docs
                                               ▼
                                 review → fix → simplify → ship personas → PR
```

## Tasks (all opus, effort high)

### ST1 — Core plumbing + stubs
`src/types.ts`: `StreamEvent`, `generateStream` on `Client`. `src/backends/backend.ts`:
extend `Backend`. All four adapters: stub `generateStream` (async generator that
throws not-implemented). `src/client.ts`: validate → delegate → stamp done-event.
`src/index.ts`: export `StreamEvent` type. Tests: validation surfaces
`invalid_request` on first next(); done-event stamping via a fake backend;
barrel export updated (test/package.test.ts).
**Accept:** gate green (existing 127 tests + new; stubs make ST2/ST3 files the only
remaining touch points).

### ST2 — API streaming (anthropic + openai) + tests
Anthropic: SDK streaming (`stream: true` / SDK stream helper) — map
`content_block_delta` text deltas; accumulate id/model/stop_reason/usage from
`message_start`/`message_delta`; done Response identical mapping to `generate`.
OpenAI: Responses streaming — `response.output_text.delta` events; final
`response.completed` → usage/status mapping identical to `generate` (incl.
incomplete/refusal semantics). Both: abort → rethrow `signal.reason`; mid-stream
API error → normalized `api_error`; early break aborts the HTTP stream (pass an
internal AbortController to the SDK, abort in generator `finally`).
Tests: canned SSE `ReadableStream` bodies via injected fetch; cases per SPEC 5a.
**Accept:** gate green; only anthropic-api.ts/openai-api.ts + their test files touched.

### ST3 — CLI streaming (runner + claude + codex) + tests
`src/backends/cli.ts`: add streaming runner (async line iterator over stdout,
16 MiB total bound still enforced, stderr buffered, same ENOENT/exit/abort/
group-kill/exit-handler semantics; kill group in generator cleanup on early break).
Claude: argv = non-streaming argv with `--output-format stream-json
--include-partial-messages` (+ `--verbose` if required — check `claude --help`
output; do NOT run a real generation). Parse JSONL: partial-message text deltas →
`text` events; final `result` event → same parse as json mode → done Response;
absent/failed result → same error semantics as generate.
Codex: keep `exec --json` argv; yield delta events if the JSONL provides them,
else one coarse `text` event from `item.completed` agent_message; `turn.completed`
→ usage; done Response mapping identical to generate; non-zero exit diagnostic
reparse preserved.
Tests: fake streaming runner emitting lines incrementally; cases per SPEC 5a incl.
abort mid-stream and early break killing the group (real-process test allowed via
`process.execPath` like existing suite).
**Accept:** gate green; only cli.ts/claude-cli.ts/codex-cli.ts + test files touched.

### ST4 — Contract, example, docs, integration
`test/contract.test.ts`: streaming leg across all four (faked transports):
deltas concat === done.response.text; done last+unique; provider/flavor stamped.
`examples/switchable.ts`: `--stream` flag → print deltas as they arrive, then usage.
README: streaming section (API, granularity-honesty table per target, abort,
early-break cleanup, validation-on-first-next note). CLAUDE.md: one paragraph.
`test/integration.test.ts`: opt-in streaming smoke per CLI (env-gated as before).
package.json version → 0.2.0.
**Accept:** full gate green; integration skipped by default.

### Post-build (opus high each)
Review (five-axis on the branch diff) → fix findings → simplify (diff scope) →
ship fan-out (reviewer/security/test personas on diff) → fix → push branch →
`gh pr create` vs main with summary + test evidence.
