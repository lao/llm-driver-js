# TODO: llm-driver v2 — SDK generation parity

Details per task: `tasks/plan.md`. Spec: `SPEC.md`. Every task ends with all
five gates green (`build`, `test`, `lint`, `typecheck`, `test:coverage`).

## Phase 1 — Foundation
- [ ] T1 Capability framework + `unsupported_feature` + `temperature` (M)
- [ ] T2 `topP` / `topK` / `stopSequences` / `metadata` (S)
- [ ] Checkpoint 1: matrix-driven tests, human review of gate ergonomics

## Phase 2 — Reasoning
- [ ] T3 `reasoning.effort` on all four targets (M)
- [ ] T4 `reasoning` stream events (M)
- [ ] Checkpoint 2: reasoning tier green, StreamEvent widening reviewed

## Phase 3 — Structured output
- [ ] T5 `outputSchema` on api flavors + `response.structured` (M)
- [ ] T6 `outputSchema` on cli flavors (`--json-schema` / `--output-schema` tmpfile) (M)
- [ ] Checkpoint 3: four-target structured output; human runs integration (billable)

## Phase 4 — Image input
- [ ] T7 Content blocks + images on api flavors (M)
- [ ] T8 claude/cli images via stream-json stdin — HIGH RISK (M)
- [ ] T9 codex/cli images via temp files + `-i` (S)
- [ ] Checkpoint 4: image fixture all four targets; v1 stdin regression pinned

## Phase 5 — Tools (api)
- [ ] T10 Tool types + loop on anthropic/api (`tool_failed`, cap 16) (M)
- [ ] T11 Tool loop on openai/api (S)
- [ ] T12 `tool_call` / `tool_result` stream events (M)
- [ ] Checkpoint 5: human review of loop semantics before bridge

## Phase 6 — MCP bridge (cli tools)
- [ ] T13 Bridge core: loopback HTTP MCP server, no CLI coupling (M)
- [ ] T14 claude/cli tools via bridge (M)
- [ ] T15 codex/cli tools via bridge (verify `-c mcp_servers` syntax FIRST) (M)
- [ ] Checkpoint 6: full matrix green; teardown leak check; human integration runs

## Phase 7 — Polish + ship
- [x] T16 `timeoutMs` (all) + `maxRetries` (api) (M)
- [x] T17 Docs: SPEC merge, README matrix, example flags, CLAUDE.md (M)
- [ ] Final checkpoint: every matrix cell tested, review + simplify, bump 0.2.0

## Pre-start vetoes (answer before the task starts)
- [x] `tool_loop_exceeded` dedicated error code? (before T10; plan assumes yes) — YES, dedicated code, cap 16
- [x] `Message.text` XOR `content` design? (before T7; plan assumes yes) — YES, text XOR content
