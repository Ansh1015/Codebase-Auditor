# Contributing

Thanks for considering a contribution. This project audits arbitrary repos, so
correctness and honesty of output matter more than feature count — please read
the invariants below before opening a PR.

## Setup

```bash
npm install
npm run dev -- ./some-repo   # run against a target during development
```

Requires Node 20+.

## The loop

| Command            | What it does                                  |
|--------------------|-----------------------------------------------|
| `npm test`         | vitest (deterministic core + pass orchestration) |
| `npm run typecheck`| `tsc --noEmit` (strict)                        |
| `npm run lint`     | biome                                          |
| `npm run format`   | biome write                                    |
| `npm run build`    | `tsc` → `dist/`                                |

All four (`typecheck`, `lint`, `build`, `test`) must pass — CI runs them on
Node 20 and 22. Run `npm run format` before committing.

A live API smoke test runs only when `ANTHROPIC_API_KEY` is set:

```bash
ANTHROPIC_API_KEY=sk-... npm test -- api.integration
```

## Architecture (pipeline order)

```
ingest → mapping (tree-sitter + dep graph + metrics + clustering)
       → llm (provider abstraction: api + subscription + cache)
       → passes (triage → deep-dive → cross-cut → ground/dedupe)
       → findings (schema + grounding gate)
       → patch (generate + verify) → report → cli
```

## Invariants (please don't break these)

- **Types are the spec.** Prefer making illegal states unrepresentable (branded
  types, discriminated unions, `assertNever` on every union switch) over runtime
  checks.
- **The deterministic core is model-free and tested.** `ingest`, `mapping`,
  `findings/ground`, and `patch/verify` never call the LLM; they are unit-tested
  against `test/fixtures/{py-sample,ts-sample}`. Write these tests first.
- **The grounding gate is sacrosanct.** Never weaken `src/findings/ground.ts` to
  let more findings through — a hallucinated finding is worse than a missed one.
- **Patches stay conservative.** Single-file, small-effort, high-confidence,
  non-architectural only. Never auto-apply something labelled `rejected`.
- **Provider parity.** One `complete()` per pass; the `api` and `subscription`
  backends must behave identically.

## Good first contributions

- **Add a precision language** — see [`docs/adding-a-language.md`](docs/adding-a-language.md).
  Today Python and TS/JS get full symbol + dependency precision; other languages
  degrade gracefully. Adding one is a self-contained, well-scoped task.
- New fixture repos with planted issues, under `test/fixtures/`.
- Resolver edge cases (open an issue with a real repo that produces 0 edges).

## Pull requests

- Keep PRs focused. Describe the behaviour change and how you verified it.
- Add or update tests in the same PR as the code.
- If you touched a trust-critical path (grounding, patch verification, the
  resolver), call that out explicitly in the description.
