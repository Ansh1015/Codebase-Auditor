# CLAUDE.md — project guide

Autonomous AI Codebase Auditor. A TypeScript CLI that audits any Git repo like a
Staff Engineer and emits explainable, evidence-grounded findings + verified
patches. See `README.md` for usage and `CONTEXT.md` for the domain language.

## Stack & commands

- **Runtime:** Node 20+, TypeScript (strict, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`), ESM/NodeNext.
- **Test:** `npm test` (vitest). **Typecheck:** `npm run typecheck`.
  **Lint/format:** `npm run lint` / `npm run format` (biome).
  **Build:** `npm run build` (tsc → `dist/`). **Run:** `npm run dev -- <target>`.

## Architecture (pipeline order)

`src/ingest` → `src/mapping` (tree-sitter + dep graph + metrics + clustering) →
`src/llm` (provider abstraction: `api` + `subscription` + cache) →
`src/passes` (triage → deep-dive → cross-cut → ground/dedupe) →
`src/findings` (schema + grounding gate) → `src/patch` (generate + verify) →
`src/report` → `src/cli`.

## Conventions

- **Types are the spec.** Branded types (`src/domain/brand.ts`) and discriminated
  unions (`VerificationStatus`, taxonomy enums) — prefer making illegal states
  unrepresentable over runtime checks. `assertNever` on every union switch.
- **Deterministic core is model-free and tested.** ingest, mapping, grounding,
  and patch verification never call the LLM; they're unit-tested against
  `test/fixtures/{py-sample,ts-sample}`. Write these test-first.
- **The grounding gate is sacrosanct.** Never weaken `src/findings/ground.ts` to
  let more findings through — hallucinated findings are worse than missed ones.
- **Patches stay conservative.** Single-file, small-effort, high-confidence,
  non-architectural only. Never auto-apply something labelled `rejected`.
- **Provider parity.** One `complete()` per pass; both backends behave
  identically. Subscription calls disable agent tools (`--tools ""`).

## Agent skills

### Issue tracker

Local markdown under `.scratch/<feature>/` (solo project, no remote). See
`docs/agents/issue-tracker.md`.

### Triage labels

Canonical five: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root. See `docs/agents/domain.md`.
