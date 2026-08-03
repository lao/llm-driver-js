# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build            # tsup → dist/ (ESM + CJS + .d.ts/.d.cts)
npm test                 # vitest run — fully offline, no credentials, no real CLIs
npx vitest run test/config.test.ts   # single test file
npm run test:coverage    # v8 coverage
npm run lint             # biome check .
npm run typecheck        # tsc --noEmit
npm run example -- --provider claude --flavor cli --model <model> --prompt "..."
```

All five gates (build, test, lint, typecheck, coverage) must pass before committing.

Opt-in integration smoke test (spawns real `claude`/`codex` binaries): set
`LLMWRAPPER_CLAUDE_CLI_MODEL` and/or `LLMWRAPPER_CODEX_CLI_MODEL`, then `npm test`.
It is `describe.skipIf`-gated and skips by default — keep it that way.

## Source of truth

`SPEC.md` defines the public API and semantics; `tasks/plan.md` records the per-file
contract. This library is a deliberate 1:1 port of the Go library at
`github.com/lao/llmwrapper` — CLI argv construction, JSON/JSONL parsing, usage-field
mappings, and error fallback chains mirror the Go source. Do not "improve" those
semantics without updating SPEC.md first.

## Architecture

One provider-neutral `generate()` API over four backends selected purely by config
(`provider` × `flavor`): Anthropic Messages API, OpenAI Responses API, `claude -p`
subprocess, `codex exec` subprocess.

- `src/types.ts` / `src/errors.ts` own every public type. Provider SDK types must
  never appear in the public surface; `src/index.ts` exports only what SPEC.md lists.
- `src/client.ts` — `createClient` validates config, takes a **frozen snapshot** of it
  (caller mutation after construction must be inert — there is a test for this), and
  selects a backend via an exhaustive `provider/flavor` switch. `generate` validates
  the request, delegates, then stamps `provider`/`flavor`/`model` fallback.
- `src/backends/*.ts` are internal. SDK imports stay confined to their adapter file.
  All adapters normalize failures into `LLMWrapperError` with a stable `code`; the one
  exception is abort: on `AbortSignal`, `generate` rejects with the raw abort reason,
  never a wrapped error, identically across all four targets.
- `generateStream` is the streaming half of the same contract: zero or more `text`
  deltas whose concatenation equals `done.response.text`, then exactly one `done`
  event carrying the Response `generate` would have returned. Granularity is
  target-dependent and deliberately unspecified (API flavors stream token deltas,
  `claude -p` streams partial messages, `codex exec` yields one coarse delta —
  `generateStream` there just delegates to `generate`).
  The concatenation guarantee is **scoped for `claude`/`cli`**: `claude -p` emits
  deltas for every assistant message in the turn while `done.response` comes from
  the final `result` event only, so the equality holds for single-message turns
  and the deltas are a superset once the CLI runs tools. Not fixable in the
  adapter (the deltas are already emitted by the time the turn goes agentic);
  documented in SPEC.md and README, characterized in `test/integration.test.ts`.
  Each adapter implements `generateStream` next to its `generate` — client-side
  validation and stamping live in `src/client.ts` (validation surfaces on the
  first `next()`), the CLI streaming runner in `src/backends/cli.ts`
  (`spawnStreamRunner`/`streamCli`). Consumer `break` must tear the transport
  down, so every adapter aborts or kills in the generator's `finally`.
- `src/backends/cli.ts` is the shared subprocess runner: argv array + stdin transcript,
  never a shell; 16 MiB bounded stdout/stderr capture that kills on overflow; detached
  spawn on POSIX so aborts kill the whole process group (SIGTERM, then SIGKILL after
  250 ms). The runner is injectable via an optional factory parameter — that seam is
  how all CLI tests run offline, and it stays out of the public API.

## Testing discipline

The default suite never touches the network or spawns a provider CLI: API adapter
tests inject `fetch`/`baseUrl`, CLI adapter tests inject a fake runner (the only real
spawns use `process.execPath -e`). `test/contract.test.ts` pushes one neutral request
through all four backends and asserts the identical normalized shape — extend it when
touching any adapter.

## Constraints

- `typescript` is pinned to ^5.9 — typescript@7 breaks tsup's dts pipeline
  (`rollup-plugin-dts` crash). Do not bump until tsup supports it.
- Windows: the CLI flavor is effectively POSIX-only (no `.cmd` shim resolution,
  process-group kill is POSIX). Documented in README; don't silently add `shell: true`
  to "fix" it — that reopens the injection surface SPEC.md forbids.
