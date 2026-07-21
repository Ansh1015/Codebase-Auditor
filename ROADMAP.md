# Roadmap — Codebase Auditor

> **Private planning artifact.** Git-ignored on purpose — not for the public repo.
> Captures the phased plan and the locked decisions behind it.

## Where this is going

**Destination:** an OSS tool, published to npm, that attracts real users.
Consequence: the next phase is about *earning trust on real repos*, not adding
surface area. Validation precedes publication; distribution follows validation.

## Locked decisions

| Branch | Decision |
|---|---|
| Destination | OSS tool — publish + attract users |
| Phase order | Validate quality **first**, then publish, then adoption, then depth |
| Provider (validation) | Subscription (`claude` CLI, Pro/Max OAuth) — env-determined. API path = deferred smoke test (needs a key) |
| Validation corpus | Tight 4: self + 1 mid Python + 1 mid TS/JS + 1 Go repo (degrade path); hand-check every finding |
| Pass/fail bar | Hard trust-gate + soft usefulness target (see below) |
| Regression harness | Hybrid — manual gate + **one invariant-based self-audit replay test** committed; external cassettes kept git-ignored |
| Git hygiene | Baseline commit → feature branches → merge → tag → publish |
| Publish | `npm publish` + committed `examples/` self-audit report + README GIF |
| Adoption surface | GitHub Action (PR review comments + severity-gated check) |
| Depth ordering | More tuned languages first (Go/Rust/Java), then multi-round agentic passes |

### The validation pass/fail bar

**BLOCKING (zero tolerance — blocks publish):**
- Any crash / unhandled error on a real repo.
- Any finding whose cited evidence resolves to a real line but whose *claim is
  false* (substantive hallucination).
- Any patch labelled `verified` that actually breaks behaviour.

**TARGET (tracked, not blocking):**
- ~70%+ of surfaced findings are genuinely useful.
- Severity calibration is sane.
- Cost / runtime are reasonable.

False negatives (missed issues) are logged, not blocking — the project's creed is
*precision over recall: a hallucinated finding is worse than a missed one.*

## Current language support (baseline)

- **Precision path (works well):** Python, JavaScript, TypeScript, JSX, TSX —
  tree-sitter symbols + imports, real intra-repo dependency graph, syntax-verified
  patches.
- **Degraded path (usable, shallower):** Go, Java, Ruby, Rust, C, C++, C#, PHP,
  Swift, Kotlin, Scala, Shell, and unknown text — LLM still produces grounded
  findings, but no precise dep graph / symbols and no `verified` patches.

## Phases

### Phase 0 — Baseline commit *(done as the first commit)*
- First commit of the verified v0.1.0 product, public files only.
- Private files excluded: `ROADMAP.md`, `CLAUDE.md`, `docs/agents/`, `.scratch/`.
- **Exit:** known-good baseline in history; clean public/private split.

### Phase 1 — Real-repo validation *(branch `validate/real-repos`)*
- Run the auditor on all 4 corpus repos via the subscription backend.
- Hand-check every finding against the trust-gate.
- Fix blocking-gate failures; log target-misses as `.scratch/` issues.
- **Tail task:** API-path smoke test (once a key exists) — prerequisite for Phase 4.
- **Exit:** zero blocking-gate failures across all 4 repos.

**Status:** corpus run + hand-check DONE. self PASS; requests/cobra/got each had
substantive hallucinations collapsing into 2 classes (V-003 external-resource,
V-004 thin-context) + V-002 calibration. All three fixed on branch
`fix/context-grounding` (deterministic guards proven: 5/5 known hallucinations
capped, 0 false positives across 194 findings; 86 tests green). Remaining:
fresh end-to-end corpus re-run to confirm the preventive prompt changes, then
merge → Phase 1 exit.

### Phase 2 — Self-audit replay harness
- Offline provider that throws on cache miss.
- Invariant-based end-to-end test on this repo: every evidence ref resolves, zero
  ungrounded findings reach output, no `verified` patch fails re-verification,
  finishes within budget, finding count in a sane band.
- Plus an intentionally-reviewed snapshot (updated on purpose, not auto).
- `npm run record:self` to (re)record cassettes; loud cassette-miss message so a
  stale cassette is a 30-second fix, not a mystery.
- External-repo cassettes kept in a git-ignored fixtures dir for repeatable
  re-validation without committing third-party code.
- **Exit:** deterministic e2e test green in CI.

### Phase 3 — Publish v0.1.0
- `examples/` self-audit `report.md` + a short terminal GIF in the README.
- Tag `v0.1.0`; `npm publish` (`prepublishOnly` runs build + test).
- **Exit:** installable via `npx`; example output visible.

### Phase 4 — GitHub Action (adoption)
- `action.yml` wrapping the CLI → grounded findings as PR review comments +
  optional severity-gated status check → marketplace listing.
- **Constraint — forces the API path:** CI has no `claude` CLI OAuth, so the
  Action requires an `ANTHROPIC_API_KEY` secret and the `api` backend. The
  API-path smoke test (Phase 1 tail) must pass first.
- **Design tension — holistic vs. diff:** audit holistically (the moat = whole-repo
  reasoning) but surface only findings whose evidence *intersects the PR diff* for
  PR comments; full set for scheduled/manual runs. The cache makes repeated
  holistic runs affordable. Keep the architecture compatible with this now.
- **Exit:** Action audits a PR and comments grounded findings.

### Phase 5 — Depth *(ongoing, post-adoption)*
- **First:** promote Go / Rust / Java into the precision tier (grammar + symbol
  & import queries + a resolver). `docs/adding-a-language.md` paves the path.
  Directly widens the addressable user base.
- **Then:** multi-round agentic passes — a pass can request more files across
  rounds, behind the existing provider interface (a quality refinement).
