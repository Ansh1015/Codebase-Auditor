# Domain Context

The ubiquitous language for this project. Engineering skills (`tdd`,
`improve-codebase-architecture`, `diagnosing-bugs`) read this to speak the
codebase's vocabulary.

## Core nouns

- **Target** — the repo under audit: a local path or a Git URL (shallow-cloned
  to a temp dir, then cleaned up). Resolved by `src/cli/target.ts`.
- **IngestedFile** — a relevant file that survived ingestion: tracked /
  non-generated / non-binary / under the size cap, tagged with a **role**
  (`source | test | config | docs | infra`) and a **language**.
- **RepoMap** — the deterministic whole-system view: `FileNode`s, dependency
  `edges`, `components`, an importance-ranked file list, and stats. Built
  *without* the model; it's what makes "holistic" affordable.
- **Component** — a cluster of files (directory + dependency based) that forms
  the unit of a deep-dive pass.
- **Finding** — the unit of output. Carries `severity`, `confidence` (level +
  0–1 score), `impact` (rationale + S/M/L effort), `category`, `affectedComponents`,
  `evidence`, `reasoning`, `remediation`, optional `patchRef`. JSON is the
  source of truth; Markdown is rendered from it.
- **EvidenceRef** — a `path:startLine-endLine` pointer that the grounding gate
  verifies actually resolves in the repo.
- **ProposedPatch** — a generated unified diff for a finding, with a
  **VerificationStatus**: `verified` | `proposed-unverified` | `rejected`.

## Core verbs / pipeline

- **ingest** → **map** → **triage** → **deep-dive** → **cross-cut** → **ground**
  → **dedupe/rank** → **patch** → **report**.
- **ground** — the anti-hallucination gate: drop findings with no resolving
  evidence; down-confidence those that lose some. This rule is non-negotiable
  and deterministic.

## Providers & tiers

- **Provider** — `api` (Anthropic SDK + key) or `subscription` (`claude` CLI,
  Pro/Max OAuth), behind one `complete()` interface. `auto` detects.
- **ModelTier** — logical `triage | deep | synthesis | patch`, resolved to
  concrete Haiku/Sonnet/Opus models per provider, degrading on subscription.

## Invariants

- A finding without resolving evidence never reaches the report.
- A patch with a syntax error is `rejected`; a patch we can't behaviourally
  verify is `proposed-unverified`, never silently `verified`.
- The deterministic layers (ingest, map, ground, verify) never call the model
  and are unit-tested against fixture repos.
