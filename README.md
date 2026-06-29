# Codebase Auditor

An autonomous AI codebase auditor that reviews a whole Git repository the way an
experienced Staff Software Engineer would — reasoning about architecture,
cross-component relationships, maintainability, security posture, testing
strategy, duplication, complexity, and technical debt — and emits an
**explainable engineering report** plus **machine-generated, verified patches**.

It is repository-agnostic and runs on **either** an Anthropic API key **or** a
Claude Pro/Max subscription (via the `claude` CLI — no API key required).

```
auditor ./my-repo
auditor https://github.com/org/repo
```

## Why it's not a linter

- **Holistic, not file-by-file.** A deterministic pass builds a structural *repo
  map* (tree-sitter symbols, an import dependency graph, churn/complexity
  metrics, importance ranking, component clustering). The LLM reasons over that
  whole-system view, then reads source on demand — so it understands intent and
  relationships, not just lines.
- **Explainable.** Every finding carries engineering *reasoning*, *impact* (+
  effort), *confidence*, *severity*, *affected components*, and *remediation*.
- **Grounded — it doesn't hallucinate.** Every finding must cite a real
  `file:line` that resolves in the repo. Ungrounded findings are **dropped**;
  partially-grounded ones are **down-confidenced**. (See `src/findings/ground.ts`.)
- **Actionable.** For conservative, single-file, high-confidence issues it
  generates a unified-diff patch, syntax-checks it, optionally runs it through a
  verify command in a sandbox, and labels it `verified` / `proposed-unverified`
  / `rejected`.

## Install

```bash
npm install
npm run build          # or use `npm run dev -- <target>` during development
```

Requires Node 20+. For parsing, grammars ship via `tree-sitter-wasms` (Python +
JS/TS are precision-tuned; other languages degrade gracefully).

## Providers

| Provider        | Auth                                   | When |
|-----------------|----------------------------------------|------|
| `subscription`  | `claude` CLI (Pro/Max OAuth)           | No API key needed. Default when `ANTHROPIC_API_KEY` is unset. |
| `api`           | `ANTHROPIC_API_KEY`                    | Exact model tiers, prompt caching. Best for large/enterprise repos. |
| `auto` (default)| picks `api` if a key is set, else `subscription` | |

Model tiers map to **Haiku** (triage), **Sonnet** (deep-dives/patches), and
**Opus** (cross-cutting/synthesis). The subscription backend can't select Haiku
and only reaches Opus on Max, so it degrades gracefully and records every
substitution in the run manifest.

## Usage

```bash
auditor <path|git-url> [options]

  -o, --out <dir>            output directory (default: audit-output)
  --provider <kind>         auto | api | subscription
  --severity-threshold <s>  critical | high | medium | low | info
  --max-components <n>      cap deep-dives (scale control)
  --concurrency <n>         parallel deep-dives
  --max-cost <usd>          abort once estimated spend exceeds this many USD
  --max-calls <n>           abort once this many provider calls are made
  --no-cross-cut            skip the holistic cross-cutting pass
  --no-patches              skip machine-generated patches
  --apply                   apply non-rejected patches to the working tree (local targets)
  --verify-command <cmd>    run this in a sandbox to verify patches (e.g. "pytest -q")
  --no-cache                disable the content-addressed response cache
  --config <path>           path to auditor.toml
```

## Output

Written to `audit-output/`:

- `report.md` — executive summary, architecture overview, findings by severity,
  proposed improvements, appendix (coverage, analysis, cost).
- `findings.json` — the machine-readable source of truth (the Markdown is
  rendered from it).
- `patches/*.patch` — generated unified diffs, linked to their findings.
- `run-manifest.json` — provider, models, token/cost totals, coverage.

## Exit codes

| Code | Meaning |
|------|---------|
| `0`  | Success — including a clean "no analyzable source" result |
| `1`  | Unexpected runtime error |
| `2`  | Bad target (not a directory / `git clone` failed) |
| `3`  | No provider available (set `ANTHROPIC_API_KEY` or log in to the `claude` CLI) |
| `4`  | Budget cap reached (raise with `--max-cost` / `--max-calls`) |

## How it works

```
ingest ─► map (tree-sitter + dep graph + metrics + clustering)
       ─► triage (Haiku: architectural model + priorities)
       ─► deep-dive × components (Sonnet, parallel, line-numbered code)
       ─► cross-cutting (Opus: duplication/security/testing across the system)
       ─► ground (drop hallucinations) ─► dedupe ─► rank
       ─► patches (generate ─► syntax-check ─► sandbox verify)
       ─► report.md + findings.json + run-manifest.json
```

A content-addressed cache keys on `hash(provider + tier + prompt)`, so re-runs
and rate-limited/interrupted runs resume for free. In-flight calls survive
transient 429/5xx/network failures via exponential backoff with jitter (honouring
`Retry-After`), and a default budget cap (`maxCalls: 60`, `maxCostUsd: 10`) stops
a large or pathological repo from running away with a bill — raise it with
`--max-cost` / `--max-calls` or `[budget]` in `auditor.toml`.

## Configuration (`auditor.toml`)

Precedence: CLI flags > `auditor.toml` > defaults. See `auditor.toml.example`.

## Development

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit (strict)
npm run lint      # biome
```

Tests live next to fixtures in `test/fixtures/{py-sample,ts-sample}` — small
repos with deliberately planted issues (hardcoded secret, god-object,
duplication, untested module). The trust-critical logic (evidence grounding,
patch verification) is developed test-first.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the dev loop and invariants,
[`docs/adding-a-language.md`](docs/adding-a-language.md) to extend precision to a
new language, and [`SECURITY.md`](SECURITY.md) for the trust model.
