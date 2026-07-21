# Phase 1 — validation notes

Private scratch. Git-ignored.

## Findings about the auditor itself (surfaced during validation runs)

### V-001 — session-limit 429 handled poorly (DX, not blocking)
- **Where:** `src/llm/subscription.ts` (`looksTransient` / retry), `src/cli/main.ts` (error rendering).
- **What:** A Claude subscription "session limit" returns `api_error_status:429`
  with message `You've hit your session limit · resets 3:20pm`. The retry layer
  classifies any `429` as transient → retries with second-scale backoff, which is
  futile (the limit resets hours later). After exhausting attempts the run aborts
  and dumps the raw CLI JSON to the user.
- **Impact:** Wasted retries; confusing raw-JSON error; no actionable guidance.
- **Proposed fix (later, not now):**
  1. Detect session-limit specifically (message match on "session limit" /
     "resets") and treat it as NON-transient → fail fast, don't retry.
  2. Render a friendly message: "Claude subscription session limit reached
     (resets <time>). Re-run later, or use --provider api with a key. Completed
     calls are cached and free to resume."
  3. Consider a dedicated exit code or reuse the budget-style (4) path.
- **Status:** logged, deferred to a fix branch after the validation pass.

## Run log
- self-audit attempt 1: aborted — session limit (429), resets 3:20pm Asia/Calcutta.
- (re-login) → retried → COMPLETE.

---

## Repo 1/4 — SELF (codebase-auditor @ eef65ed) — VERDICT: PASS (blocking gate)

- 51 findings (9 High / 23 Med / 19 Low), health 0/100, 6 patches, $1.31, 7 calls, 437s.
- 51 raw → 51 grounded (0 dropped). Grounding gate not the bottleneck on real code.

### Blocking trust-gate — all PASS
- No code crash (only env session-limit, see V-001).
- No substantive hallucinations: hand-checked all 9 High; verified PERF-007
  (target.ts no git timeout) and PERF-004 (build.ts Math.max spread) against
  fresh code — both accurate. Spot-checked Med/Low — accurate.
- No over-claimed patches: all 6 correctly `proposed-unverified` (no
  --verify-command passed). Honesty invariant held.

### Soft-target issues found (worth fixing pre-publish)
- **V-002 — health-score saturation + severity over-rating.** healthScore
  (report.ts:43-47) saturates to 0 after ~8 high findings (9 High ≈ 97 penalty
  alone) → no dynamic range. And severities run hot: PERF-006 (serial file I/O)
  High despite LLM wall-clock dominating ~60:1; SEC-003/SEC-004 High despite
  grounding-gate + user-supplied-verify-command trust model mitigating them.
  Effect: a genuinely good codebase reads as 0/100 "catastrophic", which
  undercuts the tool's credibility on a user's first run.
  - Proposed (later): (a) rescale healthScore for dynamic range (e.g. log/curve
    or cap contribution); (b) tighten the FINDINGS_SYSTEM severity rubric so
    "High" requires demonstrated user-facing impact, not latent/defensive risk.

### Notable TRUE self-findings worth actually fixing (tool earned these)
- PERF-004 — Math.max(...spread) stack-overflow on huge repos (real latent crash).
- PERF-009 — budget cap check-then-act races under concurrency (real).
- ARCH-005 — `verified` returned when syntax==="unknown" but command passed
  (real trust-gate subtlety; contradicts CLAUDE.md conservatism).
- PERF-003 — tree-sitter query recompiled per file (real, cheap win).
- ARCH-001 — opus→sonnet fallback swallows all error types (real).
These are NOT validation blockers; they're a future `fix/` backlog the tool
surfaced about itself. Triage separately from the publish gate.

---

## Repo 2/4 — PYTHON (psf/requests @ 4ed3d1b) — VERDICT: FAIL (blocking gate)

- 53 findings (7 High / 17 Med / 27 Low / 2 Info), health 0/100, 5 patches,
  $2.56, 16 calls, 829s. 53 raw → 53 grounded (0 dropped).
- Precision path engaged: 37 Python files parsed precisely, 106 dep edges.

### Blocking trust-gate — 2 of 3 prongs PASS, 1 FAIL
- **Crash: PASS** — exit 0, no unhandled error.
- **Patch honesty: PASS** — all 5 patches honestly `proposed-unverified` (no
  --verify-command). The two non-Python targets (make.bat, advanced.rst)
  correctly report "no grammar to verify syntax" — proper degrade.
- **Substantive hallucination: FAIL** — see V-003 (MNT-009).

### V-003 — external-resource claim, confidently wrong + harmful patch (BLOCKING)
- **Finding:** MNT-009 "Fix typo in certifi hyperlink target (double 'i'
  produces broken URL)" — severity Medium, **confidence score 1 / level high**.
- **Cited line is real:** `docs/user/advanced.rst:295` =
  `.. _certifi: https://certifiio.readthedocs.io/`.
- **Claim is false:** that URL is certifi's *real* docs site —
  `curl` → **302 → /en/latest/** (works). The finding's reasoning categorically
  asserts "This is a definite authoring error, not a valid alternate domain."
  The proposed fix (`certifi.readthedocs.io`) → **404** (broken). It also
  **generated a patch** that would replace the working link with the 404 one.
- **Why it's the worst failure mode:** high-confidence + grounded line +
  actionable wrong patch = exactly what erodes user trust on a first run.
  Precision-over-recall creed exists to prevent this.
- **Root cause / failure CLASS:** the deterministic grounding gate verifies
  *internal* evidence (file:line resolves) but is **blind to external-resource
  truth** (does a URL/domain resolve? does a remote version/CVE exist?). The
  model fills that gap with a confident guess. Scanned all 53 findings for the
  same class: SEC-005 (urllib3 pin allows 1.x) and MNT-019 (classifiers list
  Py 3.14/3.15) make version claims but those are **in-repo** (pyproject.toml) —
  both verified **accurate**. MNT-009 is the *only* one whose truth lives
  outside the repo. So: isolated instance, single identifiable class.
- **Proposed fix (external-claim guard — extends grounding, never weakens it):**
  1. Tag findings whose core assertion rests on an external resource
     (URL reachability, domain validity, remote pkg version, CVE applicability).
  2. **Cap their confidence** (never "high") — consistent with how the grounding
     gate down-confidences partial evidence.
  3. **Make them patch-ineligible** — never auto-propose a fix whose correctness
     depends on unverifiable external truth.
  4. Document: "auditor does not verify external URLs/versions; such claims are
     low-confidence and never auto-patched." (Optionally: offline by design — no
     live URL checks in the deterministic core.)
- **Status:** BLOCKING. Fix on a `fix/` branch after the corpus completes (so
  the guard is designed against all observed failure classes, not just this one).

### Other High findings — all hand-verified ACCURATE (no hallucination)
- DEBT-006 (quickstart.rst:311,326 bare `open()` in files= leaks handles) ✓
- SEC-002 (__init__.py:66,76-90 `assert`-based version checks, stripped under -O) ✓
- ARCH-001 (__init__.py:150-152,219 module-level `warnings.simplefilter` mutation) ✓
- MNT-012 (make.bat:58 invokes private `sphinx.__init__`) ✓
- SEC-003 (testserver/server.py:168 `CERT_OPTIONAL` in mutual-TLS branch) ✓
- TEST-001 (cert.cnf dup `DNS.1` key silently drops wildcard SAN) ✓ — sharp catch
- MNT-013 (conf.py:106 `flask_theme_support.FlaskyStyle` undocumented dep) ✓
- Spot-checked Med: DEBT-005 (Py2 dead code in compat.py) ✓, SEC-001 (test
  private keys genuinely committed) ✓.

### Soft-target issues (same as self-audit)
- **V-002 reconfirmed:** 7 High → health 0/100 again. `requests` is a flagship-
  quality library; 0/100 is absurd and undercuts credibility. Severity runs hot
  (doc-example handle leaks and *test-server* CERT_OPTIONAL rated High).

---

## Repo 3/4 — GO degrade path (spf13/cobra @ ad460ea) — VERDICT: FAIL (blocking gate)

- 32 findings (1 Crit / 7 High / 13 Med / 11 Low), health 0/100, 6 patches,
  $2.06, 13 calls, 709s. **Degrade path confirmed: 65 files · 0 edges · 0 parsed
  precisely** (no Go grammar → heuristics only).

### Blocking trust-gate — 2 of 3 prongs PASS, 1 FAIL
- **Crash: PASS** — exit 0.
- **Patch honesty: PASS** — all 6 patches `proposed-unverified` with reason
  "no grammar to verify syntax" — exactly correct for the Go degrade path. Zero
  `verified`. Honesty invariant holds even with no grammar.
- **Substantive hallucination: FAIL** — see V-004 (DEBT-004, DEBT-005, DEBT-001).

### V-004 — config-only clusters lack language/project context → hallucinated project type (BLOCKING)
- **Findings:** DEBT-004 (High, conf 1) "Dependabot configures Go modules
  instead of npm for a **TypeScript project**"; DEBT-005 (High, conf 1) "Labeler
  globs reference Go/Cobra source files that **do not exist in this repo**".
- **Both claims FALSE:** cobra HAS `go.mod` (it IS Go; `gomod` is correct). The
  labeler-referenced files ALL exist (cobra.go, args.go, command*.go,
  *completions*, doc/ — verified). DEBT-004 even shipped a **patch** switching
  dependabot to npm (would break it). DEBT-005 remediation references
  `src/ingest/**`, `src/llm/**` — model confabulating TS module names.
- **ROOT CAUSE (verified, NOT cache bleed):** the deep-dive that produced these
  was on the `.github` component — a cluster of ONLY config files
  (dependabot.yml, labeler.yml). `prompts.ts` injects only the cluster's own file
  content; the system prompt is repo-agnostic. With NO source file in that
  cluster's window, the model had zero signal that the repo is Go → it
  hallucinated "TypeScript project" and declared the correct Go config wrong.
  Confirmed NOT cache contamination: our repo has no dependabot/labeler files,
  self-audit findings.json has 0 dependabot/labeler/npm matches, requests had 0
  TS-bleed (its clusters held real .py source).
- **Sub-case — DEBT-001 (doc-as-code):** flags a ```go snippet inside
  `site/content/completions/_index.md` (a docs-site markdown file) as code that
  "fails to compile". The auditor can't distinguish illustrative code-in-docs
  from real source. Same family: missing context about what a file *is*.
- **Proposed fix (project fact-sheet — grounds every deep-dive):**
  1. Compute a compact "project fact sheet": primary language(s) from
     `languageBreakdown`, presence of key manifests (go.mod / package.json /
     pyproject.toml / Cargo.toml …), file/LOC counts. The triage pass already
     produces `architectureOverview` — thread that (or the fact sheet) into
     `renderComponentContext` so EVERY deep-dive prompt is grounded in what the
     project actually IS, not just the cluster's files.
  2. Optionally tag doc/markdown files so snippet-code isn't judged as build code.
- **Status:** BLOCKING. Same `fix/` branch as V-003.

### Genuine findings — hand-verified ACCURATE (tool earned these even on degrade path)
- ARCH-001 (Crit) yaml_docs.go:138 `os.Exit(1)` in public `GenYamlCustom` ✓ — real anti-pattern.
- DEBT-002 (High) test-win cache key uses `${{ matrix.go }}` but test-win job has
  NO matrix block (only test-unix defines `go`) → undefined → degenerate key ✓ — sharp.
- MNT-007 (High) man_docs.go:225 mutates `DisableAutoGenTag` via `VisitParents` ✓.
- (TEST-002, MNT-006 timestamp — plausible, not exhaustively checked.)

---

## Two distinct BLOCKING failure classes found (the point of validation)

| ID | Class | Realized on | Mechanism | Fix |
|----|-------|-------------|-----------|-----|
| V-003 | external-resource claim | requests (MNT-009) | truth lives outside repo (URL/version/CVE); grounding gate can't check it; model guesses | external-claim guard: cap confidence, no patches |
| V-004 | insufficient cluster context | cobra (DEBT-004/005/001) | config-only / doc-only cluster has no language signal; model invents project type | project fact-sheet threaded into every deep-dive |

Both: real, reproducible, cleanly fixable, and they EXTEND the grounding
philosophy (never assert what you can't verify) rather than weakening it.
Neither is a crash or a patch-honesty failure — the trust *plumbing* is sound;
the gap is *context grounding* of the model's claims.

---

## Repo 4/4 — TS precise path (sindresorhus/got @ 66ca4e0) — VERDICT: FAIL (marginal)

- 58 findings (0 Crit / 10 High / 26 Med / 22 Low), health 0/100, 6 patches,
  $2.99, 16 calls, 1076s. **Strong precise path: 118 files · 161 edges · 78
  parsed precisely.**

### Blocking trust-gate — 2 of 3 PASS, 1 marginal FAIL
- **Crash: PASS** — exit 0.
- **Patch honesty: PASS** — all 6 `proposed-unverified`, zero `verified`. (.ts
  targets → "syntax valid; no verify command"; .md/.svg targets → "no grammar".)
- **Substantive hallucination: marginal FAIL** — one doc-as-code FP (MNT-021),
  no NEW class. See below.

### The precise CODE path is SOLID — all hand-verified ACCURATE
- TEST-001 fake-timer `clock.uninstall()` outside `finally` → leaks on failure ✓
- MNT-011 global `Error` shadowed by `NodeJS.ErrnoException` in 2500-line file ✓
- PERF-002 TLS cert regenerated every test invocation ✓
- CPLX-001 `afterResponse` array `.slice()`d mid-iteration (retry-state) ✓
- DEBT-003 `got(url, {...options})` spreads an `Options` instance → drops
  prototype methods ✓ (real TS gotcha)
- MNT-005 `isGotInstance` duck-types via `is.function` alone ✓
- SEC-001 SSRF in documented proxy example: `got.stream(request.query.url)` ✓ —
  ACCURATE & valuable (real copy-pasteable example teaching an insecure pattern;
  tool correctly distinguishes this from placeholder notation).

### Recurrences (NO new class)
- **V-004 doc-as-code (MNT-021, High, +patch):** flags `instance(…, {...})` in
  documentation/2-options.md as "invalid JavaScript". The `…` are intentional
  elision placeholders, not code. Model can't tell doc-placeholder from real code.
- **V-002 over-rating (MNT-016, High):** "SVG logo missing viewBox" — factually
  true (svg has width/height, no viewBox) but HIGH severity for a logo attribute
  is absurd. Same calibration issue.

---

## CORPUS COMPLETE — 4/4 — FINAL VERDICT

| # | Repo | Path | Crash | Patch honesty | Substantive halluc. | Verdict |
|---|------|------|-------|---------------|---------------------|---------|
| 1 | self (auditor) | precise TS | PASS | PASS | none | **PASS** |
| 2 | psf/requests | precise Py | PASS | PASS | V-003 ×1 | **FAIL** |
| 3 | spf13/cobra | degrade Go | PASS | PASS | V-004 ×2 (+1 doc) | **FAIL** |
| 4 | sindresorhus/got | precise TS | PASS | PASS | V-004 doc ×1 | **FAIL (marginal)** |

### What held EVERYWHERE (the trust plumbing — publish-critical invariants)
- **Zero crashes** on 4 real repos (Py/Go/TS, precise + degrade paths).
- **Zero over-claimed patches** — 23 patches total, ALL honestly
  `proposed-unverified`. The honesty invariant never broke, including on the
  no-grammar degrade path. This is THE core trust guarantee and it is rock-solid.
- **The precise code path produces accurate staff-level findings** with no
  hallucinations on real Py/TS source (requests 7/7 High accurate; got code
  findings all accurate; self all accurate).

### What FAILED — exactly 2 classes, both context-grounding, both fixable
- **V-003 external-resource** (requests): model asserts external facts (URL
  reachability / remote versions) it cannot verify → guesses wrong + can ship a
  harmful patch. → external-claim guard (cap confidence, no auto-patch).
- **V-004 thin/wrong context** (cobra, got): (a) config-only clusters lack a
  language signal → model invents project type; (b) doc/markdown snippets &
  placeholder notation judged as compilable code. → project fact-sheet into every
  deep-dive + tag non-source (doc/asset) files so they aren't judged as build code.
- **V-002 calibration** (everywhere): health saturates to 0/100 even on
  flagship repos; severities run hot (logo viewBox = High). Soft, but
  publish-relevant for first-run credibility.

Convergence after 4 repos (no new class on the 4th) ⇒ corpus is sufficient.

### Phase 1 EXIT status: NOT clean (3 of 4 fail). Gate to publish = fix V-003 +
V-004, re-run corpus from cache, confirm zero substantive hallucinations. V-002
folded into the same fix branch for first-run credibility.

---

## FIX BRANCH — `fix/context-grounding` (off baseline eef65ed)

Implements all three issues. Tests: 66 → 86 (all green); typecheck + biome clean.

### V-002 — healthScore rescaled (report.ts)
- Replaced `100 − penalty` (clamped flat at 0 after ~8 highs) with a saturating
  hyperbola `100·H/(penalty+H)`, H=150. Keeps dynamic range; never hard-zeros.
- Corpus scores now: self 40, requests 42, cobra 45, got 36 (was 0/0/0/0).
- Severity rubric tightened in FINDINGS_SYSTEM (prevention) — "high/critical"
  require demonstrated runtime impact; latent/doc/config nits → low/info.

### V-003 + V-004 — deterministic context-grounding guards (NEW src/findings/guards.ts)
- `detectGroundingCaveat()` flags claims the offline core can't verify and CAPS
  confidence to ≤0.4 → below selectPatchable's "high" gate ⇒ auto patch-ineligible
  ⇒ no harmful patches. Attaches a human-readable `caveat` to the finding.
- Three detectors (tuned against the REAL corpus text):
  - external-resource: URL/domain token + validity words (typo/broken/404/…).
  - doc-as-code: all-docs evidence + compile/invalid-syntax words.
  - phantom-structure: all-non-source evidence + "no such file / doesn't exist in
    this repo / a <lang> project" (determiner-scoped so "the Go project" upstream
    ref and "httplib doesn't exist in Python 3" true-fact do NOT trip it).
- Wired into groundFindings; RepoIndex gained role(); Finding gained caveat.

### V-004 root cause — project fact-sheet (prompts.ts) [PREVENTION]
- `renderProjectFactSheet(map)`: primary language(s) incl. untuned Go, manifests
  present (go.mod→Go, …), size. Threaded into EVERY deep-dive + cross-cut prompt.
- Per-file role tags ([docs]/[config]/…) added to rendered context so doc
  snippets aren't judged as build code.

### DETERMINISTIC PROOF (cache-free replay against captured corpus, all 194 findings)
Ran the compiled guard over the 4 saved findings.json files:
- **5 / 194 capped — EXACTLY the 5 known hallucinations**
  (requests MNT-009, cobra DEBT-004/005/001, got MNT-021).
- **0 false positives.** Initially over-matched MNT-005 ("syntax highlighting"),
  DEBT-003 ("the Go project"), DEBT-009 ("httplib doesn't exist in Python 3"),
  DEBT-007 ("the compiled logo.svg") — all released by tightening the regexes.
- This closes the BLOCKING gate deterministically: every realized substantive
  hallucination is now patch-ineligible and down-confidenced, regardless of model.

### V-004 PREVENTION — CONFIRMED FRESH (cobra .github cluster, new prompts)
Fresh re-run (go-cobra-v2) issued real calls with the fact-sheet prompt. Compared
the SAME `.github`-cluster deep-dive response, old cache vs new:
- OLD (b08b…): "TypeScript" ×5, "npm" ×5 → DEBT-004/005 hallucination (HIGH).
- NEW (9bee…): "TypeScript" ×0, "npm" ×0, "Go project" ×2.
- New findings on that cluster (all correct, no hallucination):
  - [medium] dependabot open-pull-requests-limit 99 risks PR flooding (real).
  - [low] dependabot lacks `groups` → one PR per dep (real, useful).
  - [low] labeler globs use `./` prefix — portability depends on labeler version.
    ← This is the REAL labeler bug the old run MISSED while hallucinating
      "files don't exist". Fixing the context didn't just remove the false
      finding — it surfaced the true one, at correct (low) severity.
The fact-sheet fixes V-004 at the source; the deterministic guard remains the
backstop. Severity rubric (V-002b) also visibly working (HIGH → medium/low).

### V-005 — patch-generation hang / report-loss (INVESTIGATED + FIXED)
The go-cobra-v2 run completed analysis (deep-dives + cross-cut, 25 fresh cache
entries) and reached "Generating 6 candidate patches", then stalled >7 min; its
background handle was also lost on session teardown. Investigation:
- The claude CLI call HAS a bounded 240s timeout ×4 attempts (subscription.ts);
  retry backoff is bounded (≤3.5s). So NOT an infinite hang — a stuck CLI call
  fails after ≤~16 min per candidate. The observed stall = a stuck patch-tier
  call mid-timeout (and/or the orphaned parent killed by session teardown).
- **Real latent bug found:** `generatePatches` (patch/run.ts) ran candidates
  SEQUENTIALLY with NO per-candidate error isolation, and audit.ts called it
  UNGUARDED at line 160 *before* the report write at 188-190. So a single patch's
  LLM error/timeout would propagate out and abort the whole run — **discarding the
  completed findings report** (the expensive output) over a failure in the
  optional patch step. Independent of the fix branch (patch-gen was untouched).
- **Fix (commit b6e9249):** (A) audit.ts wraps patch-gen so failure → patches=[]
  and the report still writes; (B) generatePatches isolates each candidate with
  try/catch → skip on error, never throws. Tests 86→88.
- Residual (noted, not fixed): a genuinely stuck CLI call still costs up to
  ~16 min (240s×4) before being skipped, sequentially. Bounded + non-fatal now.
  Optional future: shorter patch-tier timeout or bounded-concurrency patch-gen.

### NET: both blocking classes closed two ways (deterministic guard + prevention),
V-002 rescaled, 86 tests green. Remaining belt-and-suspenders: a full clean
4-repo fresh re-run for the committed Phase 1 exit artifact.
