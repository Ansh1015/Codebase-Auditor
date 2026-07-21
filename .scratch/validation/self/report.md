# Engineering Audit — Codebase-Auditor

_Generated 2026-06-29T10:10:36.740Z · commit `eef65edba0` · via Claude Code subscription (claude CLI, OAuth — Pro/Max) (cached)_

## Executive Summary

**Health score: 0/100**

| Critical | High | Medium | Low | Info | Total |
|---|---|---|---|---|---|
| 0 | 9 | 23 | 19 | 0 | 51 |

**Top risks:**
- 🟠 High — **ARCH-001** Opus-to-Sonnet fallback swallows all error types, masking real failures
- 🟠 High — **PERF-003** Tree-sitter query compiled on every parse call — should be cached per language
- 🟠 High — **PERF-006** File I/O loop serialises every stat+readFile call, O(n) latency on repo size
- 🟠 High — **PERF-007** Git subprocess calls have no timeout — CLI hangs on slow remotes
- 🟠 High — **PERF-004** `Math.max(...spread)` over unbounded array will stack-overflow on large repos

## Architecture Overview

This is a TypeScript CLI tool that performs automated code auditing on Git repositories. It follows a strict linear pipeline: ingest (file discovery, language detection) → mapping (tree-sitter AST parsing, symbol extraction, dependency graph construction, repo-map generation) → LLM passes (triage, deep-dive, cross-cut analysis) → findings (schema validation, grounding gate) → patch (generation and verification) → report (output rendering). The domain layer (taxonomy, branded types, finding schema) sits beneath all stages and is the most structurally central part of the codebase, with taxonomy.ts having the highest in-dependency score (0.86), meaning nearly every module imports from it.

The LLM layer is the most complex subsystem at 8 files and 675 LOC. It abstracts two backends (API and subscription modes), owns budget/token tracking, implements retry logic with backoff, and must maintain behavioral parity between backends — a non-trivial invariant to preserve as the system evolves. The mapping layer (also 8 files, 689 LOC) wraps tree-sitter and is responsible for building the structural context that grounds LLM prompts; any parsing gaps here directly degrade finding quality downstream.

The grounding gate (src/findings/ground.ts) is architecturally load-bearing: it is the sole filter preventing hallucinated findings from reaching the report, so it concentrates correctness risk disproportionate to its size (150 LOC). The passes orchestrator (src/passes/run.ts, 221 LOC, in-dep importance 0.63) ties LLM calls, prompt templates, and budget management together in a single file — a breadth-of-responsibility smell that makes it a likely point of future complexity accumulation.

The Python files (8) appear to be fixture data rather than application code, consistent with the test/fixtures directory. Test coverage appears proportional to component importance, though the passes and CLI layers have lighter test surface relative to their LOC, which is where integration-level regressions are most likely to hide.

## Findings

### 🟠 High (9)

#### ARCH-001 — Opus-to-Sonnet fallback swallows all error types, masking real failures

- **Severity:** 🟠 High · **Confidence:** high (0.95) · **Category:** architecture · **Effort:** S
- **Affected:** subscription
- **Evidence:** `src/llm/subscription.ts:76-84`

**Why it matters.** Authentication failures, content-policy rejections, or malformed-request errors on an Opus call are silently retried as Sonnet rather than surfaced. Callers receive a degraded result with no indication that something went structurally wrong, making a misconfigured plan or policy violation indistinguishable from a normal tier substitution.

**Reasoning.** subscription.ts:78–84 catches every error thrown by `this.call()` when `resolved.alias === 'opus'`, then unconditionally retries as Sonnet. `call()` itself already exhausted `maxAttempts` retries for transient errors via `withRetry`, so by the time the error surfaces here it is non-transient. The correct guard is to inspect error type (e.g. 403, content-policy, plan-limit keywords) and only degrade for plan-capacity errors; everything else should propagate.

**Remediation.** Narrow the catch to plan-capacity signals only. Introduce a `isPlanCapacityError(err)` predicate (checking for HTTP 403 with a plan-limit body, or a matching CLI error message) and rethrow everything else. Alternatively, mirror the CLI error classification already used in `isTransientCliError`.

#### PERF-003 — Tree-sitter query compiled on every parse call — should be cached per language

- **Severity:** 🟠 High · **Confidence:** high (0.95) · **Category:** scalability-performance · **Effort:** S
- **Affected:** src/mapping
- **Evidence:** `src/mapping/treesitter.ts:146-165`, `src/mapping/treesitter.ts:167-183`

**Why it matters.** Query compilation is expensive (parses the S-expression pattern string into an internal automaton). In a repo with thousands of files, `language.query(queryStr)` is called twice per file (symbols + imports) even though the query string is a static constant that never changes. This multiplies compilation cost linearly with file count.

**Reasoning.** At treesitter.ts:149 and treesitter.ts:170, `language.query(queryStr)` is called inside `extractSymbols` and `extractImports` respectively, both of which are invoked on every call to `parse()`. The query strings (`PY_SYMBOLS`, `JS_SYMBOLS`, etc.) are module-level constants that never vary at runtime. The compiled query object depends only on the language and the pattern string, both of which are stable once a grammar is loaded. There is already a per-language grammar cache (`this.langs`) but no corresponding query cache.

**Remediation.** Add a `private readonly queries = new Map<string, TS>()` keyed by `lang + ':symbols'` / `lang + ':imports'`. In `extractSymbols`/`extractImports`, look up the compiled query before calling `language.query(queryStr)` and store the result on first use. This reduces query compilation from O(files) to O(distinct languages).

**Patch.** `patches/PERF-003.patch`

#### PERF-006 — File I/O loop serialises every stat+readFile call, O(n) latency on repo size

- **Severity:** 🟠 High · **Confidence:** high (0.95) · **Category:** scalability-performance · **Effort:** M
- **Affected:** ingest
- **Evidence:** `src/ingest/ingest.ts:152-192`

**Why it matters.** For a repo with 500 source files, two sequential awaited syscalls per file means ~1 000 sequential round-trips through the OS I/O scheduler. On a cold page-cache this is easily 10–50× slower than a bounded-concurrent approach. The auditor's primary user-facing cost is ingest time.

**Reasoning.** The `for (const raw of candidates)` loop at line 152 awaits `stat(abs)` (line 162) and then `readFile(abs)` (line 173) one file at a time. There is no concurrency. `candidatePaths` itself can return thousands of entries for a large monorepo. Each await yields the microtask queue but nothing else runs until it resumes, so wall-clock time scales linearly with file count × average syscall latency.

**Remediation.** Replace the serial loop with a bounded concurrent fan-out, e.g. map candidates to async tasks and run them through a pool limited to 32–64 in-flight operations (p-limit or a manual semaphore). Collect results, then sort. The stat-before-readFile pattern is still correct as an early-exit optimisation; keep it, just parallelise across files.

#### PERF-007 — Git subprocess calls have no timeout — CLI hangs on slow remotes

- **Severity:** 🟠 High · **Confidence:** high (0.95) · **Category:** scalability-performance · **Effort:** S
- **Affected:** cli/target
- **Evidence:** `src/cli/target.ts:36-37`, `src/cli/target.ts:52`

**Why it matters.** A user auditing a slow or unresponsive Git remote has no recourse other than Ctrl-C; there is no maximum wall-clock time imposed on either the clone or the rev-parse, so the process can block indefinitely in CI or automated pipelines.

**Reasoning.** Both `execa` calls — `headCommit` (line 36) and `git clone` (line 52) — pass no `timeout` option. execa defaults to no timeout, meaning a stalled TLS handshake or a slow pack transfer will hang the process forever. The `reject: false` option only converts non-zero exit codes to resolved promises; it has no effect on a process that never exits.

**Remediation.** Pass a `timeout` option to both `execa` calls, e.g. `{ reject: false, timeout: 60_000 }` for clone and `{ reject: false, timeout: 5_000 }` for rev-parse. Check `res.timedOut` and throw a `TargetError` when true. Consider surfacing a `--clone-timeout` CLI flag so power users can override.

**Patch.** `patches/PERF-007.patch`

#### PERF-004 — `Math.max(...spread)` over unbounded array will stack-overflow on large repos

- **Severity:** 🟠 High · **Confidence:** high (0.92) · **Category:** scalability-performance · **Effort:** S
- **Affected:** src/mapping
- **Evidence:** `src/mapping/build.ts:80-82`

**Why it matters.** V8's function call stack is limited (~65k–125k arguments depending on version). Spreading a large Map's values into `Math.max` will throw `RangeError: Maximum call stack size exceeded` for repos with tens of thousands of files, crashing the entire audit run.

**Reasoning.** Lines 80–82 use `Math.max(1, ...[...drafts.values()].map(...))`. The spread `...` passes every element as a positional argument. This is safe for small repos but becomes a hard crash for large ones with no graceful degradation — exactly the opposite of the stated design intent ('degrade rather than fail the whole audit', parse.ts:29).

**Remediation.** Replace with `Array.prototype.reduce`: `const maxIn = [...drafts.values()].reduce((m, d) => Math.max(m, d.inDegree), 1);`. Apply the same pattern to maxChurn and maxLoc.

**Patch.** `patches/PERF-004.patch`

#### SEC-003 — Shell injection via user-supplied verifyCommand with shell:true

- **Severity:** 🟠 High · **Confidence:** high (0.92) · **Category:** security · **Effort:** S
- **Affected:** src/patch
- **Evidence:** `src/patch/run.ts:93-98`

**Why it matters.** execa is invoked with shell:true and the raw verifyCommand string. Any shell metacharacters in that string (semicolons, backticks, command substitution) execute in the same context as the auditor process. If verifyCommand is ever read from a repo-local config file, auditing a malicious repo becomes RCE.

**Reasoning.** Line 93: `execa(command, { shell: true, ... })` passes the full command string to the OS shell without any sanitisation or argument-array decomposition. The shell:true flag is the root cause — it turns the string into a shell invocation. Splitting the command into an argv array and using shell:false would eliminate the injection surface entirely.

**Remediation.** Parse verifyCommand into an argv array with a shell-word splitter (e.g. `shell-quote` or a minimal hand-rolled split on whitespace respecting quotes), then call `execa(argv[0], argv.slice(1), { cwd: tmp, shell: false, reject: false, timeout: 180_000 })`. If the project intentionally needs shell pipelines, wrap in a fixed shell invocation: `execa('sh', ['-c', command], ...)` — semantically equivalent but makes the intent explicit and easier to audit.

**Patch.** `patches/SEC-003.patch`

#### ARCH-003 — Async init and grammar loading in `TreeSitterEngine` are not race-safe

- **Severity:** 🟠 High · **Confidence:** high (0.85) · **Category:** architecture · **Effort:** S
- **Affected:** src/mapping
- **Evidence:** `src/mapping/treesitter.ts:103-108`, `src/mapping/treesitter.ts:110-119`

**Why it matters.** Two concurrent callers can both observe `this.parserCtor === null` (treesitter.ts:104) or a cache miss in `this.langs` (treesitter.ts:113–114) before either has written the result, causing `Parser.init()` or `Language.load()` to run twice. `Parser.init()` is documented as idempotent but `Language.load()` is not; a double-load can corrupt WASM state or cause a hard crash.

**Reasoning.** In `init()` (line 103): the check `if (this.parserCtor) return` is not atomic — two concurrent awaiting callers can both pass the null check before `this.parserCtor` is assigned on line 107. Same TOCTOU pattern in `language()` (line 113–117): two concurrent callers for the same language can both miss the `cached` check and call `Language.load()` twice. While `build.ts` currently processes files sequentially (line 45), the engine is a shared object returned via `createParser()` and can be called from multiple concurrent contexts. The safe pattern is to store the in-flight Promise itself rather than the resolved value.

**Remediation.** Replace the field `private parserCtor: TS = null` with `private initPromise: Promise<void> | null = null`. In `init()`, do `this.initPromise ??= (async () => { ... })(); await this.initPromise`. Similarly, replace `this.langs` with `private readonly langPromises = new Map<Language, Promise<TS>>()` and store the load Promise on first access.

#### SEC-004 — Path traversal: relPath written into tmp without bounds check

- **Severity:** 🟠 High · **Confidence:** high (0.82) · **Category:** security · **Effort:** S
- **Affected:** src/patch
- **Evidence:** `src/patch/run.ts:92`

**Why it matters.** Findings are LLM-generated. A hallucinated or adversarially-crafted evidence path such as `../../etc/cron.d/evil` survives into runVerifyCommand, where `path.join(tmp, relPath)` resolves it outside the temp sandbox. An attacker who can influence LLM output (prompt injection in a reviewed file) can overwrite arbitrary files on the host with the patched content.

**Reasoning.** Line 92: `await writeFile(path.join(tmp, relPath), newContent, 'utf8')` resolves `relPath` against `tmp` but never verifies the result stays within `tmp`. `path.join` does not prevent traversal — it resolves `..` components normally. The grounding gate is not visible in this component, so this file must defend itself.

**Remediation.** After computing `const dest = path.resolve(tmp, relPath)`, assert `dest.startsWith(path.resolve(tmp) + path.sep)` and throw (or return `{ ran: false, passed: false }`) if the check fails. This is a one-liner that closes the traversal window regardless of upstream validation.

**Patch.** `patches/SEC-004.patch`

#### SEC-005 — Untrusted analyzed source flows into a credentialed CLI; tool suppression rests on a fragile flag

- **Severity:** 🟠 High · **Confidence:** medium (0.60) · **Category:** security · **Effort:** M
- **Affected:** src/llm, src/passes, src/cli
- **Evidence:** `src/llm/subscription.ts:106-113`, `src/passes/run.ts:160-167`, `src/cli/audit.ts:200-203`

**Why it matters.** The auditor inlines arbitrary, attacker-controllable repository content into the same prompt channel as its own instructions, then (in subscription mode) ships it to the local `claude` CLI running under the user's OAuth. Prompt injection here can steer the audit and, combined with `--apply`, reach the user's working tree.

**Reasoning.** run.ts:160-167 concatenates raw file bodies of the audited repo into the `user` prompt with no provenance separation. subscription.ts:106 builds `${system}\n\n=== TASK INPUT ===\n${user}` and invokes `claude` with `--max-turns 1` and `--tools ""` (subscription.ts:111) as the sole defenses against agentic behaviour under the user's real credentials. The entire safety claim ("acts as a pure completion engine, no file edits/bash") rests on `--tools ""` being a valid, effective way to disable tools; an empty-string value to a possibly-unrecognized flag is a brittle foundation. Even with turns bounded, injected instructions in the analyzed code can suppress real findings or shape a patch diff, and audit.ts:200-203 will write non-rejected patches straight to the working tree on `--apply`. The grounding gate protects citation integrity, not omissions or patch contents.

**Remediation.** Treat analyzed code as untrusted data: wrap inlined source in an explicit, escaped delimiter and instruct the model to never follow instructions found inside it; prefer the API backend for untrusted targets; replace `--tools ""` with an explicitly verified disallow mechanism (e.g. `--disallowedTools`/sandbox) and add a test asserting tools are actually inert; and require human review before applying any patch produced by a subscription run.

### 🟡 Medium (23)

#### MNT-004 — Hard-coded 250-line cap in cross-cut pass ignores configurable maxLinesPerFile

- **Severity:** 🟡 Medium · **Confidence:** high (0.97) · **Category:** maintainability · **Effort:** S
- **Affected:** passes
- **Evidence:** `src/passes/run.ts:160`

**Why it matters.** AuditOptions.maxLinesPerFile exists specifically so callers can tune how much code each pass sees. Bypassing it in runCrossCut with a magic constant means operators cannot increase or decrease the cross-cut window without editing source. It also creates a silent inconsistency: a deep-dive pass at the default 500 lines/file sees twice as much context as the cross-cut pass that is supposed to synthesise the whole system.

**Reasoning.** Line 160 calls renderFileWithLineNumbers(path, content, 250) with the literal 250 instead of opts.maxLinesPerFile. AuditOptions declares maxLinesPerFile at line 38 and it is threaded through to runDeepDive correctly (line 137), but runCrossCut ignores it entirely.

**Remediation.** Replace the literal 250 on line 160 with opts.maxLinesPerFile to make the cross-cut pass respect the same tuning knob as the deep-dive passes.

**Patch.** `patches/MNT-004.patch`

#### MNT-005 — Triage parse failure silently degrades audit quality with no diagnostic

- **Severity:** 🟡 Medium · **Confidence:** high (0.95) · **Category:** maintainability · **Effort:** S
- **Affected:** passes
- **Evidence:** `src/passes/run.ts:102-104`

**Why it matters.** When the triage LLM response is malformed, lines 103-104 return empty defaults: no architecture overview and an empty priorityComponents list. The audit proceeds but with effectively random component ordering (falling back to repo-map order) and no architecture overview in the result. Callers get a PassStats and Finding list with no indication that the triage pass produced garbage, making this failure mode invisible in production.

**Reasoning.** triageSchema.safeParse at line 102 returns a discriminated union. The failure branch at line 103-104 discards the parse error entirely and returns empty strings/arrays. There is no logging, no counter in PassStats, and no way for the caller to detect that the triage step was a no-op.

**Remediation.** Log (or surface in PassStats) the parse failure at minimum. Consider returning a Result/Either type or adding a triageParseError field to AuditResult so callers can decide whether to abort, retry, or warn the user that component ordering may be suboptimal.

#### ARCH-002 — Confidence.level is a derived field with no invariant enforcement

- **Severity:** 🟡 Medium · **Confidence:** high (0.93) · **Category:** architecture · **Effort:** S
- **Affected:** domain
- **Evidence:** `src/domain/finding.ts:24-28`, `src/domain/taxonomy.ts:52-56`

**Why it matters.** The comment at finding.ts:26 explicitly states that `level` is derived from `score` via `confidenceLevel()`, yet both fields are mutable, independently settable interface members. Any call site that constructs a `Confidence` object can trivially produce `{ level: 'high', score: 0.1 }`. Downstream consumers (report rendering, grounding gate) may branch on either field and silently disagree, producing incoherent output without a type or runtime error.

**Reasoning.** The `Confidence` interface stores two fields in a documented derived relationship (`level = confidenceLevel(score)`) but exposes both as independent writable members on a plain interface. TypeScript interfaces have no computed properties or private constructors, so the invariant can only be maintained by convention. Remove `level` from the stored interface and derive it lazily via the `confidenceLevel()` utility wherever it is needed, or introduce a `makeConfidence(score: number): Confidence` factory that constructs both and is the sole exported constructor (with the raw interface moved to a private/internal type). The factory approach keeps downstream reads cheap while making the illegal state unrepresentable.

**Remediation.** Delete `level: ConfidenceLevel` from the `Confidence` interface. Wherever callers read `confidence.level`, replace with `confidenceLevel(confidence.score)` (already imported from taxonomy). Alternatively, export only a factory `export function makeConfidence(score: number): Confidence` and move the bare interface to an internal module so it cannot be constructed directly.

#### MNT-014 — Optional-chain cast silently produces undefined PatchCandidate.path

- **Severity:** 🟡 Medium · **Confidence:** high (0.93) · **Category:** maintainability · **Effort:** S
- **Affected:** src/patch
- **Evidence:** `src/patch/select.ts:42`

**Why it matters.** A branded-type cast over an optional-chained expression hides undefined from the type system. Any regression in selectPatchable's invariants silently propagates undefined as a RepoRelPath, causing a downstream Map miss or a file being written to 'undefined' with no error or diagnostic.

**Reasoning.** Line 42: `finding.evidence[0]?.path as RepoRelPath`. The filter on line 26 (`files.size === 1`) guarantees `evidence` is non-empty at call time, but `?.` propagates `undefined` instead of relying on that invariant. The `as RepoRelPath` cast then erases the `undefined` from the type, so callers see a `RepoRelPath` that may be `undefined` at runtime. This is exactly the pattern branded types are meant to prevent.

**Remediation.** Replace with an explicit assertion: `const p = finding.evidence[0]?.path; if (p === undefined) continue; return { finding, path: p as RepoRelPath };` inside a map body, or use a non-null assertion `finding.evidence[0]!.path as RepoRelPath` if the invariant is proven, and add a comment documenting the guarantee.

#### CPLX-001 — extractJson 'balanced span' is not actually balanced — misses multi-object inputs

- **Severity:** 🟡 Medium · **Confidence:** high (0.92) · **Category:** complexity · **Effort:** S
- **Affected:** findings
- **Evidence:** `src/findings/ground.ts:58-70`

**Why it matters.** The fallback heuristic pairs indexOf('{') with lastIndexOf('}'), not a real bracket-balance counter. For model output like '{"a":1} extra text {"b":2}' it attempts to parse the full span including garbage, fails, and returns undefined — silently dropping a parseable response. The comment 'first balanced span' sets a false expectation and will mislead future maintainers.

**Reasoning.** Line 58 uses indexOf (first '{') and line 59 uses lastIndexOf (last '}') — these are not matched brackets. A genuine balanced-span search would scan character-by-character tracking depth. The current approach works only when the JSON blob is already the outermost content of the string, making the third fallback materially weaker than its comment implies. Because this gate is the anti-hallucination layer, a silent parse failure here degrades grounding quality without any diagnostic signal.

**Remediation.** Replace lines 58-69 with a proper depth-tracking scan: walk the string from the first '{', increment depth on '{', decrement on '}', stop when depth reaches 0 — that position is the true closing bracket. Apply the same logic for arrays starting at '['. This correctly handles multi-object strings and matches the 'balanced' contract described in the comment.

#### DUP-003 — Rejected-patch predicate duplicated across three call sites

- **Severity:** 🟡 Medium · **Confidence:** high (0.92) · **Category:** duplication · **Effort:** S
- **Affected:** cli/audit
- **Evidence:** `src/cli/audit.ts:72`, `src/cli/audit.ts:95`, `src/cli/audit.ts:195`

**Why it matters.** The filter `p.status.kind !== 'rejected'` appears independently in `attachPatchRefs`, `applyPatches`, and the patch-file write loop. Adding a new non-applicable status (e.g. `'pending'`) requires updating three sites; missing one silently leaks wrong behavior.

**Reasoning.** `patches.filter((p) => p.status.kind !== 'rejected')` at line 72, `if (p.status.kind === 'rejected') continue` at line 95, and the same guard at line 195 all encode the same business rule. This is a classic shotgun duplication that violates the single-definition principle for domain rules.

**Remediation.** Introduce a `isApplicablePatch(p: ProposedPatch): boolean` predicate (ideally co-located in `src/patch/`) and replace all three raw comparisons with it. This also makes the semantics extensible when new status kinds are added.

#### MNT-001 — Cost cap silently non-functional when costUsd is undefined

- **Severity:** 🟡 Medium · **Confidence:** high (0.92) · **Category:** maintainability · **Effort:** S
- **Affected:** budget, subscription
- **Evidence:** `src/llm/types.ts:31`, `src/llm/budget.ts:51`, `src/llm/subscription.ts:141`

**Why it matters.** The `maxCostUsd` guardrail is a hard safety control. If it silently fails to accumulate cost, the cap never fires and the audit can run unbounded — exactly the runaway scenario the budget module is designed to prevent.

**Reasoning.** `CompleteResult.costUsd` is typed as `readonly costUsd?: number` (types.ts:31). `BudgetTracker.record()` at budget.ts:51 uses `result.costUsd ?? 0`, silently treating missing cost as zero. The subscription backend at subscription.ts:141 sets `costUsd: parsed.total_cost_usd ?? 0`, which defaults to 0 when the CLI omits that field. The result: the cost accumulator stays at 0, `checkBeforeCall()` never throws on `maxCostUsd`, and the cap is dead. The API backend always computes cost (api.ts:87), but the subscription path has no fallback estimation.

**Remediation.** Either (a) make `costUsd` required in `CompleteResult` and have `SubscriptionProvider` estimate cost using the same `COST_PER_MTOK` table already present in `api.ts`, or (b) add a non-zero sentinel check in `BudgetTracker.record()` that warns when cost data is missing while a cost cap is configured.

#### PERF-001 — runPool has no per-item error isolation — one LLM failure cancels all in-flight deep-dives

- **Severity:** 🟡 Medium · **Confidence:** high (0.92) · **Category:** scalability-performance · **Effort:** M
- **Affected:** passes
- **Evidence:** `src/passes/run.ts:74-90`

**Why it matters.** With concurrency:3 and 8 components, a transient rate-limit or network error on any single component causes Promise.all at line 88 to reject immediately, discarding findings from all other in-flight or queued components. The entire audit fails rather than returning partial results.

**Reasoning.** The worker closures at lines 81-87 await fn(items[i]) with no try/catch. Any rejection escapes the closure, and Promise.all at line 88 short-circuits on the first rejection per ECMAScript semantics. The partially-filled results array is then abandoned.

**Remediation.** Wrap the fn call in a try/catch inside the worker. On failure, either record a sentinel error in results[i] and continue, or re-throw only after all workers complete (similar to Promise.allSettled semantics). Expose per-component failure counts in PassStats.

#### MNT-013 — Numeric CLI arguments parsed without NaN validation

- **Severity:** 🟡 Medium · **Confidence:** high (0.91) · **Category:** maintainability · **Effort:** S
- **Affected:** cli/main
- **Evidence:** `src/cli/main.ts:63-66`

**Why it matters.** `Number('abc')` returns `NaN`; passing NaN as concurrency or budget caps propagates silently through `BudgetTracker` and scheduling logic, producing undefined behavior (e.g. infinite loops or NaN comparisons that never trigger the budget gate) rather than a user-facing error.

**Reasoning.** Lines 63–66 use bare `Number(opts.concurrency)`, `Number(opts.maxComponents)`, `Number(opts.maxCost)`, `Number(opts.maxCalls)`. Commander delivers these as raw strings. `Number('')` is `0` and `Number('1e5')` is `100000` — both are legal but surprising. `Number('abc')` is `NaN`. Neither case is caught before the value is handed to `loadConfig`, so the error surfaces (if at all) deep inside the pipeline rather than at the CLI boundary.

**Remediation.** After each conversion, assert `Number.isFinite(v) && v > 0`, and throw (or `program.error(...)`) with a clear message like `--concurrency must be a positive integer` before calling `loadConfig`. Commander's `.argParser()` hook is the idiomatic place to do this per-option.

#### DEBT-008 — `as string` on optional-chain results masks undefined in Maps

- **Severity:** 🟡 Medium · **Confidence:** high (0.90) · **Category:** technical-debt · **Effort:** S
- **Affected:** cli/audit
- **Evidence:** `src/cli/audit.ts:73`, `src/cli/audit.ts:92`

**Why it matters.** TypeScript's type system is silenced: if `evidence` is empty or `findingId` is not a plain string, the Map stores `undefined` typed as `string`, converting a structural invariant violation into a silent no-op that is hard to debug.

**Reasoning.** Line 73: `p.findingId as string` — if the domain type already guarantees `findingId` is `string`, the cast is redundant; if it does not, the cast lies. Line 92: `f.evidence[0]?.path as string` — the optional chain returns `string | undefined`, but `as string` convinces TypeScript it is always a string. The falsy guard on line 96–97 papers over the runtime issue, but the Map entry still holds `undefined` under the `string` type, which can silently corrupt downstream consumers that bypass the guard.

**Remediation.** At line 92 use a genuine filter: `findings.filter(f => f.evidence.length > 0).map(f => [f.id, f.evidence[0]!.path])` so only findings with evidence are keyed. At line 73, fix the domain type to brand `findingId` as `string` upstream and remove the cast. Neither guard nor cast should be needed when types are accurate.

#### MNT-002 — stderr from claude CLI is silently discarded, obscuring error diagnostics

- **Severity:** 🟡 Medium · **Confidence:** high (0.90) · **Category:** maintainability · **Effort:** S
- **Affected:** subscription
- **Evidence:** `src/llm/subscription.ts:107-113`

**Why it matters.** When the CLI writes diagnostics or auth errors to stderr, the only context the caller sees is the stdout snippet (capped at 400 chars) and an exit code. Operators debugging quota or auth failures in production have no way to recover the real error message.

**Reasoning.** The `execa` call at subscription.ts:107 uses `reject: false` and captures `stdout`, `exitCode`, and `timedOut`, but does not destructure `stderr`. CliError messages at lines 118–119 and 128–129 only include the stdout tail. For auth errors, misconfiguration, or plan-limit messages that the CLI routes to stderr, those are permanently lost.

**Remediation.** Destructure `stderr` from the `execa` result and include it (truncated) in the `CliError` message. For example: `const tail = (stdout + stderr).slice(0, 500)` ensures the most useful diagnostic text is preserved regardless of which stream the CLI uses.

#### ARCH-005 — verified status emitted even when syntax is unknown (internal contradiction)

- **Severity:** 🟡 Medium · **Confidence:** high (0.88) · **Category:** architecture · **Effort:** S
- **Affected:** src/patch
- **Evidence:** `src/patch/verify.ts:23-40`

**Why it matters.** A patch labelled `verified` with a child check `{ name: 'parses', passed: false }` is self-contradictory. Downstream consumers (report generation, auto-apply logic) that gate on `status.kind === 'verified'` will trust patches whose syntax was never validated, undermining the grounding gate philosophy stated in CLAUDE.md.

**Reasoning.** Lines 29–32: when `command.passed` is true, the function always returns `kind: 'verified'` regardless of whether `syntax === 'unknown'`. The `parses` check is recorded with `passed: false` in that case, but the enclosing `kind` is still `'verified'`. Any consumer checking only `kind` sees full confidence. The `proposed-unverified` path on lines 49–53 correctly distinguishes the unknown-syntax case when no command ran, but that logic is bypassed as soon as a verify command passes.

**Remediation.** In the `command.passed` branch, downgrade to `proposed-unverified` (or a new `verified-behaviour-only` kind) when `syntax === 'unknown'`, and only return `verified` when both syntax is `'ok'` and the command passed. This keeps the trust label conservative and consistent with the codebase's grounding-gate philosophy.

#### DEBT-004 — Finding IDs are order-dependent and non-stable across runs

- **Severity:** 🟡 Medium · **Confidence:** high (0.88) · **Category:** technical-debt · **Effort:** M
- **Affected:** findings
- **Evidence:** `src/findings/ground.ts:117-121`

**Why it matters.** Sequential per-category counters mean that the same logical finding receives a different ID (e.g., ARCH-001 vs ARCH-002) if the order of raw findings changes between runs — which happens whenever passes run in different order, findings are filtered differently upstream, or additional passes are added. Any downstream consumer that tracks, deduplicates, or diffs findings by ID will accumulate false regressions.

**Reasoning.** The counter at line 117 increments per-category as findings are iterated, so ID assignment is a pure function of arrival order. There is no content-derived component (no hash of title/file/line). The FindingId branded type (line 119) adds type safety but does not enforce stability. As the pipeline grows more passes, cross-run ID churn will make reports harder to interpret and any tracking/suppression mechanism built on IDs will be fragile.

**Remediation.** Derive the ID from a short deterministic hash of (category, title, primary evidence path+line) — e.g., `${CATEGORY_PREFIX[cat]}-${xxhash32(title+path+startLine).toString(16).slice(0,6).toUpperCase()}`. This keeps IDs short, human-readable, and stable across runs regardless of ordering.

#### DEBT-006 — TypeScript declaration files (.d.ts) ingested as source instead of excluded as generated

- **Severity:** 🟡 Medium · **Confidence:** high (0.88) · **Category:** technical-debt · **Effort:** S
- **Affected:** ingest
- **Evidence:** `src/ingest/ingest.ts:81-82`

**Why it matters.** .d.ts files are compiler-emitted artifacts; auditing them produces findings about generated declarations rather than hand-written code, inflating false-positive rates and wasting LLM tokens that the pipeline charges per-pass.

**Reasoning.** `GENERATED_FILE_RE` at line 81–82 covers `.min.js`, `.bundle.js`, `*-lock.*`, `.map`, `_pb2.py`, `.pb.go`, and `.generated.*`, but not `.d.ts`. Because `extensionOf` extracts only the final extension (language.ts line 70–72), a file named `foo.d.ts` yields extension `ts`, maps to language `typescript`, passes the generated filter, and is ingested as source code. Any project that ships declaration files alongside compiled output (or has them in `dist/` — though `dist` is dir-ignored — or in `src/` via declaration merging) will have them analysed.

**Remediation.** Add `\.d\.ts$` to `GENERATED_FILE_RE` at ingest.ts line 82: `/(…|\.d\.ts)$/i`. Alternatively update `extensionOf` to return the full compound extension for dotfiles (e.g. `d.ts`), but that is a larger change.

#### PERF-005 — New `Parser` object allocated per file parse — should be pooled or reused

- **Severity:** 🟡 Medium · **Confidence:** high (0.88) · **Category:** scalability-performance · **Effort:** S
- **Affected:** src/mapping
- **Evidence:** `src/mapping/treesitter.ts:125-127`, `src/mapping/treesitter.ts:139-141`

**Why it matters.** A web-tree-sitter `Parser` object wraps a native WASM handle and is not cheap to construct. Allocating one per file (and per `hasSyntaxError` call) creates GC pressure and WASM allocation churn proportional to the file count. Parser objects are stateful but reusable via `reset()` or simply `setLanguage()` on the same instance.

**Reasoning.** treesitter.ts:125 creates `new this.parserCtor()` inside `parse()` and treesitter.ts:139 does the same inside `hasSyntaxError()`. Both are called once per file. The grammar (`language`) is already cached; the parser instance could be cached per language as well, set once with `setLanguage` and reused since parsing is synchronous within each call.

**Remediation.** Cache one parser per language alongside the grammar: `private readonly parsers = new Map<Language, TS>()`. In `parse()` and `hasSyntaxError()`, retrieve or create the parser for the given language. Since these methods are currently called sequentially this is safe without locking.

#### MNT-008 — Silent discard of ungrounded and malformed findings — no observability

- **Severity:** 🟡 Medium · **Confidence:** high (0.85) · **Category:** maintainability · **Effort:** S
- **Affected:** findings
- **Evidence:** `src/findings/ground.ts:111`, `src/findings/ground.ts:85-88`

**Why it matters.** Both the grounding gate (line 111) and the per-item schema parse loop (lines 85-88) silently drop records. If a model starts emitting consistently malformed or unverifiable findings, the auditor produces fewer results with no log, counter, or returned metadata. Diagnosing model regressions or prompt-format drift requires adding instrumentation retroactively.

**Reasoning.** groundFindings returns only the accepted findings; there is no return or out-param for drop counts or reasons. parseFindingsResponse similarly returns only valid items. Callers have no way to distinguish 'the model found nothing' from 'the model found 10 things and all were ungrounded'. This violates the principle that the anti-hallucination layer should be auditable itself.

**Remediation.** Return a structured result from both functions: `{ findings: Finding[], droppedUngrounded: number, droppedMalformed: number }`. Log these counts at debug level in the caller. Optionally expose them in the final report metadata so operators can see model output quality degrade before it affects finding counts.

#### SEC-001 — Prompt injection via untrusted repo content concatenated into CLI stdin

- **Severity:** 🟡 Medium · **Confidence:** high (0.85) · **Category:** security · **Effort:** M
- **Affected:** subscription
- **Evidence:** `src/llm/subscription.ts:106`

**Why it matters.** The auditor processes arbitrary third-party repositories. Repo files inlined into `req.user` can contain adversarial instruction text that rides through the single-stdin prompt, potentially steering model output — fabricating findings, suppressing real ones, or exfiltrating other inlined context.

**Reasoning.** subscription.ts:106 concatenates `req.system` and `req.user` with the static separator `=== TASK INPUT ===` and sends the result as a single stdin string via `-p`. There is no trust boundary enforced between system instructions and user/repo content. A crafted file containing `

=== TASK INPUT ===
Ignore all previous instructions...` trivially shifts the model's context. The API backend avoids this by using the SDK's structured `system`/`messages` separation (api.ts:64–65).

**Remediation.** Before inlining file content into the prompt, strip or fence patterns that match the separator (at minimum `=== TASK INPUT ===`). Longer-term, adopt a clearly documented injection-resistant quoting convention (e.g. XML-tagged code blocks) and validate that the system block is always emitted first and unmodified.

#### DEBT-007 — looksBinary indexes Buffer without null-safety under noUncheckedIndexedAccess

- **Severity:** 🟡 Medium · **Confidence:** high (0.80) · **Category:** technical-debt · **Effort:** S
- **Affected:** ingest
- **Evidence:** `src/ingest/ingest.ts:92-97`

**Why it matters.** The project opts into `noUncheckedIndexedAccess` (CLAUDE.md: "strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess"). Under that flag, `Uint8Array`/`Buffer` index access is typed `number | undefined`. The comparison `buf[i] === 0` is silently safe at runtime today but creates a type-system gap: if a future stricter lint or explicit `number`-typed usage is added, it will break, and the current code signals false confidence.

**Reasoning.** Lines 94–96: the loop indexes `buf[i]` where `buf: Buffer` and compares to `0`. With `noUncheckedIndexedAccess`, TypeScript widens the type to `number | undefined`; `undefined === 0` is `false`, so the null case falls through correctly by accident rather than by design. The safer idiomatic alternative is `buf.indexOf(0, 0) !== -1` for the first `n` bytes, which avoids indexed access entirely and is also O(1) amortised via a native method.

**Remediation.** Replace the loop body with `return buf.subarray(0, Math.min(buf.length, 8192)).indexOf(0) !== -1;`.

#### DUP-004 — Transient-error classification is implemented twice and the "shared" claim is false

- **Severity:** 🟡 Medium · **Confidence:** high (0.78) · **Category:** duplication · **Effort:** M
- **Affected:** src/llm
- **Evidence:** `src/llm/retry.ts:65-116`, `src/llm/subscription.ts:26-35`

**Why it matters.** Retry/backoff behaviour must match across the two backends for the run manifest's reliability story to hold, but the definition of "retryable" is forked. A fix to one path (e.g. honouring a new throttling signal) silently won't apply to the other.

**Reasoning.** retry.ts:66 comments that its classifier is "shared by the api (SDK) and subscription (CLI) backends," and `isTransientLlmError` (retry.ts:112) inspects structured HTTP status codes and `errno` network codes. The subscription backend does NOT use it: it defines its own `TRANSIENT_PATTERN` regex (subscription.ts:26) plus `looksTransient`/`isTransientCliError` (subscription.ts:29-35) that string-matches the CLI's stdout tail. These are two independent notions of transience with different inputs and rules, so the comment is misleading and the two backends will drift — e.g. retry.ts treats HTTP 408/409 as retryable but the regex has no equivalent, while the regex retries on the word "connection" anywhere in output.

**Remediation.** Collapse to one classifier. Have the subscription path map its CLI failure into a shape (status/code) that `isTransientLlmError` already understands, or expose a single `isTransient(err)` from retry.ts that both backends call, and delete `TRANSIENT_PATTERN`. Then correct or remove the "shared" comment so it matches reality.

#### MNT-010 — `gitChurn` returns paths relative to git root but lookups use paths relative to `ingest.root`

- **Severity:** 🟡 Medium · **Confidence:** high (0.78) · **Category:** maintainability · **Effort:** M
- **Affected:** src/mapping
- **Evidence:** `src/mapping/metrics.ts:17-35`, `src/mapping/build.ts:38`, `src/mapping/build.ts:63`

**Why it matters.** When a user audits a subdirectory of a git repository (e.g., `/repo/packages/core`), `git -C /repo/packages/core log --name-only` resolves upward to the true git root and emits paths relative to that root (e.g., `packages/core/src/foo.ts`). Meanwhile `ingest.files[].path` values are relative to the audited directory (`src/foo.ts`). The `churn.get(file.path)` lookup at build.ts:63 never matches, silently zeroing out all churn signal and biasing importance scores.

**Reasoning.** `execa('git', ['-C', root, 'log', ...]` at metrics.ts:20 uses the target directory as the working directory, but git still reports paths relative to its own root. If `root` is not the git root, the returned keys are prefixed with the relative path from git root to `root`. `build.ts:63` does a direct `churn.get(file.path)` with no prefix stripping, so all lookups return undefined.

**Remediation.** After the git log command, use `git -C root rev-parse --show-prefix` to obtain the prefix of `root` relative to the git root. Strip that prefix from each path key before inserting into the map, so keys are always relative to `root`. Alternatively, pass `--show-toplevel` and rebase paths accordingly.

#### PERF-009 — Budget guardrail is check-then-act and races under concurrency

- **Severity:** 🟡 Medium · **Confidence:** medium (0.72) · **Category:** scalability-performance · **Effort:** M
- **Affected:** src/llm, src/passes
- **Evidence:** `src/llm/budget.ts:33-53`, `src/passes/run.ts:74-90`, `src/passes/run.ts:197-199`, `src/llm/api.ts:54-91`

**Why it matters.** The hard cost/call cap is the one thing standing between `npx auditor ./repo` and a runaway bill, but it can be silently overshot. Under the default concurrency of 3 (and any future increase) multiple in-flight calls each pass the cap check before any of them records usage.

**Reasoning.** `BudgetTracker.checkBeforeCall()` (budget.ts:34) reads `this.calls/costUsd/totalTokens`, but `record()` (budget.ts:47) only mutates them after the provider call resolves. In `api.ts` the sequence is checkBeforeCall (line 55) → `await ...messages.create` (line 60) → record (line 90), and `runPool` (run.ts:74-90) drives `options.concurrency` of these in parallel for the deep-dives (run.ts:197-199). Because the read and the increment straddle an `await`, up to `concurrency-1` calls can all observe the counters below the cap and proceed, so the documented "checked before every call so a runaway audit fails loudly" guarantee leaks by an unbounded multiple of the per-call cost.

**Remediation.** Make the cap check and a usage reservation atomic for the lifetime of an in-flight call: have `checkBeforeCall()` reserve a slot (increment `calls`/an estimated cost up-front, decrement/reconcile in `record()`), or serialize the reserve step. At minimum, account for `concurrency` pending calls in the threshold comparison so the cap is conservative rather than optimistic, and add a concurrency test that asserts the cap is never exceeded.

#### SEC-002 — git ls-files output used as file paths without traversal-boundary validation

- **Severity:** 🟡 Medium · **Confidence:** medium (0.70) · **Category:** security · **Effort:** S
- **Affected:** ingest
- **Evidence:** `src/ingest/ingest.ts:121-122`, `src/ingest/ingest.ts:159`

**Why it matters.** The auditor is designed to run against arbitrary, potentially adversarial repositories. A crafted git index could contain entries with path components such as `../../` which, after `path.join(root, rel)`, resolve outside the repository root. This could cause the tool to read files outside the target repo (e.g., host credentials, SSH keys).

**Reasoning.** Line 121: paths from `stdout.split('\0')` are filtered only for non-empty length. Line 159: `abs = path.join(root, rel)` expands the path without verifying the result is still under `root`. While modern git implementations reject `../` entries in tracked files, the `--others` flag (untracked files) processes working-tree entries that git does not validate the same way.

**Remediation.** After computing `abs` at line 159, assert `abs.startsWith(root + path.sep) || abs === root` and `continue` (counting as `skippedIgnored`) if not. This is a single-line defence-in-depth guard.

#### ARCH-006 — A single deep-dive failure aborts the whole audit, against the codebase's "degrade, don't fail" pattern

- **Severity:** 🟡 Medium · **Confidence:** medium (0.66) · **Category:** architecture · **Effort:** M
- **Affected:** src/passes
- **Evidence:** `src/passes/run.ts:74-90`, `src/passes/run.ts:197-204`, `src/mapping/parse.ts:28-31`, `src/config/config.ts:117-119`

**Why it matters.** The pipeline deliberately degrades on parse errors, missing grammars, and malformed config, but the per-component fan-out does the opposite: one provider hiccup discards every other component's completed work for that run.

**Reasoning.** `runPool` (run.ts:74-90) does `results[i] = await fn(items[i])` inside workers awaited by `Promise.all`, so the first rejected deep-dive (a non-transient provider error, or a `BudgetExceededError` thrown mid-run) rejects the whole pool and `runAudit` throws (run.ts:197-204). This contradicts the explicit graceful-degradation chosen elsewhere — parse.ts:28 "degrade rather than fail the whole audit" and config.ts:117 ignoring malformed TOML. The cache softens resumes but the in-progress run still dies and emits nothing.

**Remediation.** Settle per task: catch errors inside `fn`/`runPool`, return a discriminated result, and continue the remaining components; surface failures in `PassStats` (e.g. a `failedDeepDives` count) and only short-circuit on `BudgetExceededError`. This keeps partial findings instead of losing the run.

### 🔵 Low (19)

#### DUP-001 — `dirOf` function duplicated verbatim between `build.ts` and `resolve.ts`

- **Severity:** 🔵 Low · **Confidence:** high (0.99) · **Category:** duplication · **Effort:** S
- **Affected:** src/mapping
- **Evidence:** `src/mapping/build.ts:16-19`, `src/mapping/resolve.ts:43-46`

**Why it matters.** Two identical 3-line functions create a divergence risk: if the logic needs to change (e.g., to handle Windows separators), it must be updated in two places. Both files are in the same module.

**Reasoning.** build.ts:16–19 and resolve.ts:43–46 implement the exact same `dirOf(path: string): string` function with identical logic: `lastIndexOf('/')`, return `''` or slice. They are private to their respective files but belong to the same `src/mapping` component.

**Remediation.** Extract to a shared `src/mapping/path-utils.ts` (or `src/mapping/utils.ts`) and import from both callers. `joinPath` in resolve.ts is also a candidate for the same file.

#### MNT-006 — EvidenceRef.endLine comment contradicts the non-optional type

- **Severity:** 🔵 Low · **Confidence:** high (0.97) · **Category:** maintainability · **Effort:** S
- **Affected:** domain
- **Evidence:** `src/domain/finding.ts:12-14`

**Why it matters.** The JSDoc comment at finding.ts:12 says '`endLine` defaults to `startLine` when omitted', but the field is typed `readonly endLine: number` — required, not `number | undefined`. Any LLM pass or future developer that reads the comment and omits `endLine` will get a TypeScript compile error with no clear explanation, or (worse) if the interface is assembled from JSON without the type-checker, will produce a runtime object with `endLine: undefined` that passes type checks only if strict null checks are off.

**Reasoning.** There is a direct contradiction between the natural-language contract ('defaults to startLine when omitted') and the TypeScript type contract (required field). One of them must be wrong. If the intent is to allow single-line evidence, the field should be `readonly endLine?: number` and callers should coalesce with `startLine` at read sites. If the intent is that callers must always provide `endLine`, the comment should be removed to avoid confusion.

**Remediation.** Change `readonly endLine: number` to `readonly endLine?: number` and update all read sites to `ref.endLine ?? ref.startLine`. Update the comment to drop the 'when omitted' clause if the field remains required.

#### MNT-003 — Retry events are not observable in either provider

- **Severity:** 🔵 Low · **Confidence:** high (0.95) · **Category:** maintainability · **Effort:** S
- **Affected:** api, subscription
- **Evidence:** `src/llm/api.ts:67-71`, `src/llm/subscription.ts:95-98`

**Why it matters.** In production, rate-limit storms or intermittent 5xx responses are invisible. Without retry telemetry, operators cannot distinguish a healthy run from one that succeeded only after many expensive retries.

**Reasoning.** `withRetry` accepts an `onRetry` callback (retry.ts:27) specifically for this purpose, but both `ApiProvider.complete()` (api.ts:67–71) and `SubscriptionProvider.call()` (subscription.ts:95–98) pass no `onRetry`. The `RetryInfo` payload includes `attempt`, `delayMs`, and `err`, which is exactly the data needed for a structured log line or budget tracker annotation.

**Remediation.** Pass an `onRetry` handler to both `withRetry` calls that emits a structured warning (e.g. `console.warn` or a passed-in logger) including `attempt`, `delayMs`, and the error status/code. Optionally, surface retry counts in `BudgetSummary`.

#### MNT-011 — Heuristic parser sets `endLine` equal to `startLine` for all symbols, violating the `SymbolDef` contract

- **Severity:** 🔵 Low · **Confidence:** high (0.95) · **Category:** maintainability · **Effort:** M
- **Affected:** src/mapping
- **Evidence:** `src/mapping/heuristic.ts:51-56`, `src/mapping/symbols.ts:8-10`

**Why it matters.** `SymbolDef.endLine` is documented as the end of the *whole definition* (symbols.ts:9). Downstream consumers (e.g., patch generation or deep-dive context windowing) that rely on `endLine` to bound the symbol body will silently get a 1-line window for any heuristically-parsed file, producing incorrect context slices.

**Reasoning.** heuristic.ts:55 sets `endLine: i + 1` (same as startLine) for every symbol because the regex only sees one line at a time. The interface at symbols.ts:9 promises 'inclusive line range of the whole definition'. The `precise: false` flag partially signals degraded quality but doesn't protect consumers that read `endLine` without checking `precise`.

**Remediation.** Either (a) add a brace/indent-level heuristic to scan forward for the closing brace/dedent and set `endLine` accordingly, or (b) change `SymbolDef.endLine` to `endLine?: number` and mark it optional for heuristic results, so callers are forced to handle the missing-end case explicitly.

#### PERF-002 — O(n×m) linear file lookups in prompt renderers should use a pre-built Map

- **Severity:** 🔵 Low · **Confidence:** high (0.93) · **Category:** scalability-performance · **Effort:** S
- **Affected:** passes
- **Evidence:** `src/passes/prompts.ts:73`, `src/passes/prompts.ts:109`

**Why it matters.** For repos with thousands of files, renderRepoMapSummary at line 73 of prompts.ts calls map.files.find() for each of the top-25 ranked paths (O(25 × n_files)). renderComponentContext at line 109 calls map.files.find() for every file in a component (O(component_size × n_files)). Both are called on every deep-dive and cross-cut pass. While currently bounded by the component/ranked caps, this is a latent quadratic as repo size grows.

**Reasoning.** Line 73: const f = map.files.find((x) => x.path === p) inside a loop over map.ranked.slice(0,25). Line 109: component.files.map((p) => map.files.find((f) => f.path === p)) where map.files is the full repo file list. Both could be resolved by indexing map.files once into a Map<path, FileNode> either at construction time in RepoMap or at the call site.

**Remediation.** Build a Map<string, FileNode> from map.files once (either on the RepoMap object itself, or as a local variable at the top of each render function) and replace the find() calls with O(1) map lookups.

#### MNT-012 — localeCompare without explicit locale produces non-deterministic sort across environments

- **Severity:** 🔵 Low · **Confidence:** high (0.92) · **Category:** maintainability · **Effort:** S
- **Affected:** ingest
- **Evidence:** `src/ingest/ingest.ts:194`

**Why it matters.** Deterministic output order matters for snapshot tests, reproducible reports, and diffing audit runs. `localeCompare` with no locale argument inherits the Node.js process locale (ICU data, OS locale, container locale), so the same file list can sort differently on macOS vs. Alpine Linux CI.

**Reasoning.** Line 194: `files.sort((a, b) => a.path.localeCompare(b.path))`. The paths are `RepoRelPath` (branded strings of ASCII-dominated content). There is no need for locale-aware collation; a byte-order sort is correct, consistent, and faster.

**Remediation.** Replace with `files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))` or `a.path.localeCompare(b.path, 'en', { sensitivity: 'variant' })` to pin the locale.

#### DUP-002 — extensionOf called twice per file in classifyRole — internal duplication with languageOf

- **Severity:** 🔵 Low · **Confidence:** high (0.90) · **Category:** duplication · **Effort:** S
- **Affected:** ingest
- **Evidence:** `src/ingest/classify.ts:55-58`, `src/ingest/language.ts:75-77`

**Why it matters.** Marginal CPU waste and a maintenance trap: if `extensionOf` semantics change, the two call sites in `classifyRole` — one explicit and one hidden inside `languageOf` — can diverge. The explicit `ext` variable at line 57 is already computed, then thrown away when `languageOf` re-derives it at line 58.

**Reasoning.** `classifyRole` (classify.ts line 57) calls `extensionOf(path)` to get `ext`, then immediately calls `languageOf(path)` (line 58), which internally calls `extensionOf(path)` again (language.ts line 76). The extension is computed twice for every file ingested.

**Remediation.** Export a `languageOfExt(ext: string): Language` overload (or rename the internal lookup) and call it with the already-computed `ext`, e.g. `const lang = EXT_TO_LANG[ext] ?? 'unknown'` directly in `classifyRole`, eliminating the redundant call.

#### DUP-005 — `dirOf` is duplicated verbatim across mapping modules

- **Severity:** 🔵 Low · **Confidence:** high (0.90) · **Category:** duplication · **Effort:** S
- **Affected:** src/mapping
- **Evidence:** `src/mapping/build.ts:16-19`, `src/mapping/resolve.ts:43-46`

**Why it matters.** Small but pure copy-paste in the deterministic mapping core; two definitions of the same path primitive invite the usual drift where one is hardened (e.g. for Windows separators) and the other isn't.

**Reasoning.** build.ts:16-19 and resolve.ts:43-46 define byte-identical `dirOf` helpers (lastIndexOf('/') slice). Both live in the model-free, unit-tested core where path handling is correctness-critical, so the duplication is exactly the kind that produces a fixed-here-not-there bug.

**Remediation.** Extract a single `dirOf` (alongside the other POSIX path helpers like `joinPath`) into one mapping-internal module and import it in both places.

#### MNT-015 — Trim-based no-op detection incorrectly filters leading/trailing whitespace diffs

- **Severity:** 🔵 Low · **Confidence:** high (0.90) · **Category:** maintainability · **Effort:** S
- **Affected:** src/patch
- **Evidence:** `src/patch/run.ts:76`

**Why it matters.** A patch that legitimately removes trailing whitespace or adds a required trailing newline (common lint fixes) is silently dropped. The intent was to skip identity patches, but trimming both sides destroys signal about whitespace-only fixes.

**Reasoning.** Line 76: `if (!next || next.trim() === content.trim()) return null`. Comparing trimmed copies of multi-kilobyte file contents is also wasteful. The real invariant to enforce is that the LLM changed at least one byte of meaningful content, which is better detected by a strict equality check on the raw strings, or by checking that `createTwoFilesPatch` produces a non-empty hunk section.

**Remediation.** Replace the trim comparison with `next === content` (exact equality) or, even better, generate the diff first and return null only when the hunk count is zero. Trailing-newline normalization, if needed, should be an explicit, documented step rather than an implicit trim.

#### DEBT-001 — Unsafe `items[i] as T` cast in runPool bypasses noUncheckedIndexedAccess

- **Severity:** 🔵 Low · **Confidence:** high (0.88) · **Category:** technical-debt · **Effort:** S
- **Affected:** passes
- **Evidence:** `src/passes/run.ts:85`

**Why it matters.** The project's tsconfig enables exactOptionalPropertyTypes and noUncheckedIndexedAccess (per CLAUDE.md). The cast on line 85 silently suppresses the T | undefined the compiler correctly infers, restoring the exact unsafety those flags are meant to prevent. The bounds check on line 84 makes this safe today, but the compiler cannot verify that invariant, so future refactors that alter the guard condition could introduce a runtime undefined dereference without a type error.

**Reasoning.** Line 84 checks i >= items.length and returns, so items[i] is defined in the else branch. But `items[i]` still types as T | undefined under noUncheckedIndexedAccess, hence the `as T` cast at line 85. The cast is a lie to the type system rather than a proof of safety.

**Remediation.** Destructure with a narrowing check: `const item = items[i]; if (item === undefined) return; results[i] = await fn(item);`. This satisfies the compiler without a cast and makes the guard explicit.

#### MNT-007 — confidenceLevel() thresholds are undocumented magic numbers

- **Severity:** 🔵 Low · **Confidence:** high (0.88) · **Category:** maintainability · **Effort:** S
- **Affected:** domain
- **Evidence:** `src/domain/taxonomy.ts:52-56`

**Why it matters.** The 0.75 and 0.45 boundaries in taxonomy.ts:53-54 control how every finding in the system is classified. They have no named constants and no comment explaining their calibration basis. When prompt tuning changes model output distributions, these thresholds are likely to need adjustment — the next engineer must guess at intent, and a test for the boundary is currently impossible without coupling to the raw literals.

**Reasoning.** Threshold-based bucketing functions are policy, not pure logic. 0.75 and 0.45 should be exported named constants (`HIGH_CONFIDENCE_THRESHOLD`, `MEDIUM_CONFIDENCE_THRESHOLD`) so tests can import them, documentation can reference them, and a single edit propagates everywhere. This is a single-source-of-truth violation at the smallest scale.

**Remediation.** Extract `const HIGH_CONFIDENCE_THRESHOLD = 0.75` and `const MEDIUM_CONFIDENCE_THRESHOLD = 0.45` as exported constants above `confidenceLevel()`. Add a brief comment explaining the calibration basis (e.g., 'tuned against GPT-4 triage output; revisit if model changes'). Reference them in the function body.

#### TEST-001 — MockProvider.kind falsely claims 'api', undermining kind-dispatch tests

- **Severity:** 🔵 Low · **Confidence:** high (0.88) · **Category:** testing · **Effort:** S
- **Affected:** mock
- **Evidence:** `src/llm/mock.ts:13`

**Why it matters.** If any code path switches on `LlmProvider.kind` to apply backend-specific logic (e.g. model resolution, cost estimation, or feature flags), tests using MockProvider will exercise the 'api' branch only, leaving the 'subscription' branch untested.

**Reasoning.** mock.ts:13 hardcodes `readonly kind = 'api' as const`. The `LlmProvider` interface requires `kind: Exclude<ProviderKind, 'auto'>` (types.ts:37), which includes 'subscription'. The mock is a test double and should be kind-agnostic or configurable. A consumer that checks `provider.kind === 'subscription'` will never see that branch in unit tests.

**Remediation.** Accept `kind` as a constructor parameter defaulting to `'api'`, or introduce a `'mock'` variant in `ProviderKind` if strict typing is desired. At minimum, document the deliberate choice so kind-dependent code paths are identified when added.

#### PERF-008 — Report artifact writes are sequential; should be concurrent

- **Severity:** 🔵 Low · **Confidence:** high (0.87) · **Category:** scalability-performance · **Effort:** S
- **Affected:** cli/audit
- **Evidence:** `src/cli/audit.ts:188-190`, `src/cli/audit.ts:194-197`

**Why it matters.** Three independent `writeFile` calls and, separately, N patch file writes are awaited in sequence, adding unnecessary latency to the reporting phase, particularly when N patches are large or the output volume is high.

**Reasoning.** Lines 188–190 write `findings.json`, `report.md`, and `run-manifest.json` in three sequential `await writeFile(...)` calls with no dependency between them. Lines 194–197 similarly write each patch file in a serial loop. All of these are pure I/O with no ordering requirement.

**Remediation.** Replace the three report writes with `await Promise.all([writeFile(...), writeFile(...), writeFile(...)])`. Replace the patch loop with `await Promise.all(patches.filter(isApplicablePatch).map(p => writeFile(...)))`. This collapses the latency to a single I/O round-trip per group.

#### ARCH-004 — Non-Python, non-JS/TS languages fall through to JS import resolver, risking spurious dependency edges

- **Severity:** 🔵 Low · **Confidence:** high (0.82) · **Category:** architecture · **Effort:** S
- **Affected:** src/mapping
- **Evidence:** `src/mapping/resolve.ts:117-123`

**Why it matters.** For any language that is neither Python nor a JS variant (e.g., Go, Ruby, C++, Java), `resolveJsLike` is called. While `resolveJsLike` returns null for bare specifiers, a Go file with a relative path in a comment extracted by the heuristic, or a C++ `#include "../util.h"`, would trigger JS extension probing (`util.h.ts`, `util.h.js`, etc.). Accidental matches would create phantom edges in the dependency graph and corrupt importance scores.

**Reasoning.** resolve.ts:119–120 uses a binary branch: python gets `resolvePython`, everything else gets `resolveJsLike`. The `else` branch has no guard for JS/TS languages, meaning `resolveJsLike` is called for Go, Ruby, Java, etc. `resolveJsLike` returns null for non-relative specs (line 83), but for any relative import (`./`, `../`) extracted by the heuristic, it will probe with every JS extension.

**Remediation.** Change the branch to an explicit allow-list: `if (language === 'python') ... else if (['javascript','typescript','jsx','tsx'].includes(language)) ...` and return `{ resolved: [], external: [imp.spec] }` (treat all imports as external) for unsupported languages. Alternatively, introduce a `resolveLanguage` dispatch table keyed by `Language`.

#### DEBT-002 — dedupe key collapses to category|title| for evidence-free findings, silently dropping valid results

- **Severity:** 🔵 Low · **Confidence:** high (0.82) · **Category:** technical-debt · **Effort:** S
- **Affected:** passes
- **Evidence:** `src/passes/run.ts:175-183`

**Why it matters.** If two distinct findings share the same category and a normalised title but have no evidence (f.evidence[0] is undefined), they produce the identical key and only the higher-confidence one survives. Given that groundFindings is supposed to gate on evidence, evidence-free findings should never reach dedupe — but if the grounding gate is ever relaxed or bypassed in tests, this silently merges unrelated findings with no indication of the loss.

**Reasoning.** Line 178: const key = `${f.category}|${f.title.toLowerCase()}|${f.evidence[0]?.path ?? ''}`. When evidence[0] is undefined, the path segment becomes the empty string, collapsing all evidence-free findings of the same category/title. The comment on line 174 documents the intent as (category|title|first-path) but does not acknowledge the empty-path collision.

**Remediation.** Either assert that evidence is non-empty before dedupe (which it should be post-grounding), or make the key include a stable fallback like the finding's full title hash or index to prevent accidental collision: e.g., append f.evidence.length or use a uuid assigned during parsing.

#### DEBT-003 — findingId smart constructor is a bare cast with no format validation

- **Severity:** 🔵 Low · **Confidence:** high (0.82) · **Category:** technical-debt · **Effort:** S
- **Affected:** domain
- **Evidence:** `src/domain/brand.ts:50-52`, `src/domain/finding.ts:27`

**Why it matters.** Per the documented invariant in finding.ts:27 ('CATEGORY-NNN'), `FindingId` values are expected to conform to a specific format that downstream components (report generation, deduplication, patch filenames) likely depend on. The `findingId()` constructor at brand.ts:50-52 is a no-op cast. An invalid string (e.g. an empty string, a UUID, or a raw category name) passes through silently. Since this is a boundary constructor, it is the only enforcement point; internal code trusts the brand.

**Reasoning.** The comment at brand.ts:32 says 'Validation lives at the boundary; internal code trusts the brand.' `findingId()` is the boundary, so validation should live here. The pattern already exists for `repoRelPath()` which performs normalization (brand.ts:34-36). A regex check (`/^[a-z-]+-\d{3}$/i`) would be cheap, would surface malformed IDs immediately at the injection point, and would make the invariant self-documenting.

**Remediation.** Add a format check in `findingId()`: `if (!/^[A-Z-]+-\d{3}$/.test(value)) throw new Error('Invalid FindingId format: ' + value);` Adjust the regex to match the actual format used by the ID-generation pass. This follows the existing pattern where `repoRelPath` does real work rather than a bare cast.

#### MNT-009 — Schema does not enforce endLine >= startLine — silent correction in grounding

- **Severity:** 🔵 Low · **Confidence:** high (0.82) · **Category:** maintainability · **Effort:** S
- **Affected:** findings
- **Evidence:** `src/findings/schema.ts:18`, `src/findings/ground.ts:107`

**Why it matters.** A model can emit `{startLine: 100, endLine: 1}` and it passes schema validation (schema.ts line 18 only requires a positive integer). ground.ts silently corrects this at line 107 with Math.max. The fix is invisible to the caller, masking model misbehavior and making the schema a weaker contract than it should be.

**Reasoning.** The schema boundary is the right place to reject invalid evidence ranges. Letting them through and silently clamping in the domain layer spreads validation responsibility across two modules and hides malformed model output. The Math.max on line 107 is then a silent normalization that produces evidence with startLine == endLine for inverted ranges, which may or may not be meaningful.

**Remediation.** Add a Zod refinement to rawEvidenceSchema: `.refine(ev => ev.endLine === undefined || ev.endLine >= ev.startLine, { message: 'endLine must be >= startLine' })`. Remove the Math.max defensiveness from ground.ts line 107 since the invariant is now guaranteed by the schema boundary.

#### DEBT-005 — Unsafe `as unknown as` cast defeats exhaustiveness guarantee on enum schemas

- **Severity:** 🔵 Low · **Confidence:** high (0.78) · **Category:** technical-debt · **Effort:** S
- **Affected:** findings
- **Evidence:** `src/findings/schema.ts:11-13`

**Why it matters.** The double cast on lines 11-13 of schema.ts (`as unknown as [Category, ...Category[]]`) is required because the source arrays are typed as `readonly string[]` rather than const-tuple types. If taxonomy.ts ever exports an empty array for any of these (e.g., during a refactor), Zod throws a runtime error at module load with a confusing 'enum must have at least one value' message rather than a TypeScript compile error.

**Reasoning.** The cast papers over a type-level mismatch that should be fixed at the source. The `CATEGORIES`, `SEVERITIES`, and `EFFORTS` arrays in taxonomy.ts should be declared `as const` so TypeScript infers them as const-tuples, allowing `z.enum(CATEGORIES)` without any cast. The current pattern compiles but silences the type checker at exactly the boundary where a mistake would be most damaging.

**Remediation.** In taxonomy.ts, declare the arrays with `as const satisfies readonly [string, ...string[]]` (or a narrower type). Then in schema.ts the casts can be removed entirely, and TypeScript will statically verify that the arrays are non-empty tuples compatible with z.enum.

#### MNT-016 — Severity semantics are spread across three uncoordinated tables

- **Severity:** 🔵 Low · **Confidence:** medium (0.55) · **Category:** maintainability · **Effort:** S
- **Affected:** src/domain, src/report
- **Evidence:** `src/domain/taxonomy.ts:43-49`, `src/report/report.ts:28-34`, `src/report/report.ts:44`

**Why it matters.** Severity is meant to have one source of truth in the taxonomy, but its relative weighting lives in multiple hand-maintained tables, so tuning or extending severities requires synchronized edits in several files.

**Reasoning.** taxonomy.ts:43 defines `SEVERITY_RANK` as the canonical ordering, but report.ts independently encodes severity ordering twice more: `SEVERITY_LABEL` (report.ts:28) and the `healthScore` penalty `weight` map (report.ts:44). The penalty weights (25/12/5/2/0) are a second, divergent severity scale with no derivation from `SEVERITY_RANK`, so the meaning of "how much worse is critical than high" is defined inconsistently in two places. The `Record<Severity, ...>` typing catches a missing key but not a semantically drifting weight.

**Remediation.** Treat taxonomy.ts as the single owner: derive presentation labels and the health-score penalty from a small data structure co-located with `SEVERITY_RANK` (e.g. a `{ rank, label, penalty }` record per severity), and have report.ts consume it rather than restate the numbers.

## Proposed Improvements

- `patches/PERF-003.patch` — PERF-003 — 🟡 proposed (unverified)
- `patches/PERF-007.patch` — PERF-007 — 🟡 proposed (unverified)
- `patches/PERF-004.patch` — PERF-004 — 🟡 proposed (unverified)
- `patches/SEC-003.patch` — SEC-003 — 🟡 proposed (unverified)
- `patches/SEC-004.patch` — SEC-004 — 🟡 proposed (unverified)
- `patches/MNT-004.patch` — MNT-004 — 🟡 proposed (unverified)

## Appendix

### Coverage
- Files analyzed: 92 (68 parsed precisely) · 5668 LOC · 163 dependency edges · 29 components
- Skipped during ingest: 1 binary, 0 too-large, 3 ignored
- Languages: typescript (60), python (8)

### Analysis
- Passes: 8 deep-dives + cross-cutting
- Findings: 51 raw → 51 grounded (0 dropped by the evidence gate)
- LLM: 7 calls · 30487 tokens · ~$1.3126

---
_Every finding above cites evidence that resolves to real source lines; ungrounded findings were dropped automatically._
