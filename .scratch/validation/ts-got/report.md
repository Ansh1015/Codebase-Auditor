# Engineering Audit — got

_Generated 2026-06-29T11:14:08.514Z · commit `66ca4e0256` · via Claude Code subscription (claude CLI, OAuth — Pro/Max) (cached)_

## Executive Summary

**Health score: 0/100**

| Critical | High | Medium | Low | Info | Total |
|---|---|---|---|---|---|
| 0 | 10 | 26 | 22 | 0 | 58 |

**Top risks:**
- 🟠 High — **MNT-021** Code examples use Unicode ellipsis (U+2026) which is invalid JavaScript syntax
- 🟠 High — **MNT-016** SVG logo missing viewBox — cannot scale responsively
- 🟠 High — **TEST-001** Clock uninstall runs outside finally, leaks fake timers on test failure
- 🟠 High — **MNT-011** Global Error type shadowed by NodeJS.ErrnoException throughout 2500-line file
- 🟠 High — **SEC-001** SSRF vulnerability in proxy example passes raw user input to got.stream

## Architecture Overview

This is a Node.js HTTP client library (almost certainly 'got') written in strict TypeScript. The system is structured as a layered pipeline: a thin public entry point (`source/index.ts`) delegates to a core HTTP engine (`source/core/index.ts`) which handles the full request lifecycle — redirects, retries, streaming, hooks, timeout management, caching, and pagination. A separate `source/as-promise` adapter wraps the stream-based core to provide promise semantics, giving consumers two distinct programming models from a single engine. The public API surface is described entirely by types (`source/types.ts`, `source/as-promise/types.ts`) and a massive options object (`source/core/options.ts`).

The most structurally notable pattern is heavy options-driven behavior: virtually every behavioral axis (redirect policy, retry strategy, hook pipeline, cache adapter, timeout budgets, pagination cursors) flows through a single options object that at 3 466 LOC is the largest file in the codebase by a wide margin. This creates a de-facto god object at the center of the dependency graph. The core index (`source/core/index.ts`, 2 524 LOC) is the second largest file and likely a stateful class that coordinates the full request state machine — it is referenced by almost every test module, making it the highest-centrality file in the graph.

The test suite (24 187 LOC across 37 files, roughly 60 % of total LOC) is unusually large and domain-specific: dedicated files for hooks, redirects, pagination, retry, streams, and cache suggest deliberate coverage of each behavioral axis. The `test/helpers/with-server.ts` file has the highest in-dependency importance score, indicating most integration tests spin up a real HTTP server via a shared harness — a sound pattern but one where changes to the harness can break the entire test surface simultaneously.

Smells visible from structure alone: the options file is almost certainly doing parsing, validation, normalization, defaulting, and type narrowing all in one place — a prime candidate for decomposition. The core index size suggests the request lifecycle class has accreted many concerns. The `as-promise` layer being only 332 LOC is a good sign of restraint there. Migration guide docs (3 files) hint at recurring breaking-change churn in the public API, which combined with the centralized options object raises the likelihood of subtle behavioral regressions when options handling is touched.

## Findings

### 🟠 High (10)

#### MNT-021 — Code examples use Unicode ellipsis (U+2026) which is invalid JavaScript syntax

- **Severity:** 🟠 High · **Confidence:** high (0.98) · **Category:** maintainability · **Effort:** S
- **Affected:** documentation
- **Evidence:** `documentation/2-options.md:79-89`

**Why it matters.** Any reader who copy-pastes the reset-options examples will get an immediate `SyntaxError: Unexpected token '…'` because U+2026 (…) is not valid JavaScript. This makes the documentation actively harmful for the primary use case of code examples.

**Reasoning.** Lines 79-89 contain eight invocations of the form `instance(…, {option: undefined})` where `…` is the Unicode HORIZONTAL ELLIPSIS character (U+2026), not the JavaScript spread operator `...` (three separate ASCII periods). Node.js will throw a SyntaxError on any of these lines. The surrounding prose explains these as runnable examples, not pseudocode.

**Remediation.** Replace every `…` on lines 79-89 with `'https://example.com'` (a concrete URL) or with the actual spread operator `...` if variadic arguments were intended. Alternatively, restructure as pseudocode with a clear comment that these are illustrative patterns rather than runnable code.

**Patch.** `patches/MNT-021.patch`

#### MNT-016 — SVG logo missing viewBox — cannot scale responsively

- **Severity:** 🟠 High · **Confidence:** high (0.97) · **Category:** maintainability · **Effort:** S
- **Affected:** media
- **Evidence:** `media/logo.svg:1`

**Why it matters.** A logo asset is used at many sizes (navbar, favicon, OG image, docs). Without viewBox, width/height CSS overrides produce distorted or clipped output; the element is locked at exactly 416×172px unless the SVG is edited.

**Reasoning.** media/logo.svg:1 declares `height="172" width="416"` but omits a `viewBox` attribute. Per SVG spec, without viewBox the coordinate system is fixed to those pixel values; scaling via CSS width/height merely changes the viewport while the internal coordinate space stays at 416×172, causing clipping or incorrect proportions in any context that isn't exactly that size.

**Remediation.** Add `viewBox="0 0 416 172"` to the root `<svg>` element and remove or make the `width`/`height` attributes presentational (or drop them entirely so the SVG scales to its container). Result: `<svg viewBox="0 0 416 172" xmlns="http://www.w3.org/2000/svg">`.

**Patch.** `patches/MNT-016.patch`

#### TEST-001 — Clock uninstall runs outside finally, leaks fake timers on test failure

- **Severity:** 🟠 High · **Confidence:** high (0.97) · **Category:** testing · **Effort:** S
- **Affected:** test/helpers
- **Evidence:** `test/helpers/with-server.ts:69-78`, `test/helpers/with-server.ts:130-139`

**Why it matters.** If the test body throws, the finally block closes the server but the clock uninstall never runs (lines 75-78, 136-139 are outside the try/finally). Subsequent tests in the same process run with fake timers still installed, causing non-deterministic, order-dependent failures that are extremely hard to debug.

**Reasoning.** The try/finally on lines 69-73 guarantees server.close() runs, but clock.uninstall() at line 77 and fakeTimer.uninstall() at line 138 are sequenced after the block. Any rejected promise from run() will propagate through the finally, skipping the uninstall calls entirely. FakeTimers.install() patches global setTimeout/clearTimeout/setInterval/clearInterval; leaving those patches in place corrupts all subsequently running tests in the same worker.

**Remediation.** Move the uninstall call inside the finally block: `finally { await server.close(); if (install) (clock as InstalledClock).uninstall(); }`. Apply the same fix to generateHttpsHook.

**Patch.** `patches/TEST-001.patch`

#### MNT-011 — Global Error type shadowed by NodeJS.ErrnoException throughout 2500-line file

- **Severity:** 🟠 High · **Confidence:** high (0.95) · **Category:** maintainability · **Effort:** M
- **Affected:** source/core
- **Evidence:** `source/core/index.ts:73`, `source/core/index.ts:182`, `source/core/index.ts:252`

**Why it matters.** Every occurrence of `Error` as a type annotation in source/core/index.ts resolves to NodeJS.ErrnoException, not globalThis.Error. This silently distorts the declared types of _beforeError's parameter, the WeakSet, and the return type of normalizeError, making type signatures misleading and hiding real type errors from the compiler and contributors.

**Reasoning.** Line 73 declares `type Error = NodeJS.ErrnoException;`. TypeScript resolves type names within the file scope before falling back to globals, so every subsequent use of `Error` as a type in this 2524-line module refers to NodeJS.ErrnoException. This affects `const errorsProcessedByHooks = new WeakSet<Error>()` (line 182), `normalizeError`'s return type (line 252), and `_beforeError(error: Error)` (line 468). Meanwhile normalizeError's body performs `instanceof globalThis.Error` checks (line 253) and constructs `new globalThis.Error(...)`, creating a structural mismatch between the declared and actual types that TypeScript cannot catch because the alias makes them nominally identical within the file.

**Remediation.** Remove the `type Error = NodeJS.ErrnoException;` alias. Annotate usages that require the errno-extension shape explicitly as `NodeJS.ErrnoException`, and use the standard `Error` for general error typing. This restores accurate compiler checking throughout the file.

#### SEC-001 — SSRF vulnerability in proxy example passes raw user input to got.stream

- **Severity:** 🟠 High · **Confidence:** high (0.95) · **Category:** security · **Effort:** S
- **Affected:** documentation
- **Evidence:** `documentation/3-streams.md:253-265`

**Why it matters.** The proxy example passes `request.query.url` directly to `got.stream()` without any validation or allowlist. Developers copying this pattern into production will introduce a Server-Side Request Forgery vulnerability allowing attackers to probe internal network resources, cloud metadata endpoints (e.g. 169.254.169.254), or localhost services.

**Reasoning.** Line 255 `got.stream(request.query.url)` feeds an HTTP query parameter directly into a network request inside an Express route handler. The comment says 'Allowlist specific headers' but there is no allowlisting of the URL itself, which is far more dangerous. The example presents itself as a production-quality proxy pattern, making it likely to be copied verbatim.

**Remediation.** Add explicit URL validation before the stream call: parse the URL with `new URL(request.query.url)`, verify its protocol is `https:`, and check its hostname against a hardcoded allowlist. Add a prominent warning block in the example explaining SSRF risk and that URL validation is mandatory before this code can be used safely.

**Patch.** `patches/SEC-001.patch`

#### PERF-002 — TLS certificate regenerated on every test invocation — O(seconds) per test

- **Severity:** 🟠 High · **Confidence:** high (0.92) · **Category:** scalability-performance · **Effort:** M
- **Affected:** test/helpers
- **Evidence:** `test/helpers/create-https-test-server.ts:55-75`

**Why it matters.** Lines 55-75 of create-https-test-server.ts spawn two OpenSSL subprocesses (CSR + cert for CA, CSR + cert for server) on every test. Each invocation adds ~0.5–3 s depending on system entropy. With many HTTPS tests this dominates total test-suite runtime.

**Reasoning.** The CA and server certificates generated with default options (commonName='localhost', days=365) are identical across every call that doesn't override those options. There is no caching layer; `pify(pem.createCSR)` and `pify(pem.createCertificate)` are invoked unconditionally. For options-varying calls a cache keyed on the options would still hit the common case.

**Remediation.** Generate the default localhost CA+server cert pair once, lazily, and memoize it (a module-level `let cachedCerts: Promise<...> | undefined`). Pass the cached result to tests that don't need custom options. For tests that need non-default options, generate fresh certs.

#### ARCH-002 — Decompose monolithic `Options` and `Request` core modules

- **Severity:** 🟠 High · **Confidence:** high (0.90) · **Category:** architecture · **Effort:** L
- **Affected:** source/core
- **Evidence:** `source/core/options.ts:1-250`, `source/core/index.ts:1-250`

**Why it matters.** Two files carry the bulk of the library's behavior — `source/core/options.ts` (3466 LOC) and `source/core/index.ts` (2524 LOC). When normalization, validation, defaults, hook typing, cross-origin security state, and the request lifecycle all live in two god modules, every change has a wide blast radius, review cost is high, and the type/behavior coupling makes safe refactoring difficult.

**Reasoning.** The `Options` module exports not just the class but the entire hook taxonomy (`Hooks`, `InitHook`, `BeforeRequestHook`, …) and the cross-origin security helpers (see imports in `source/core/index.ts:27-41`). `index.ts` then layers the full request state machine, error construction, redirect handling, and body serialization on top. This concentration is the root cause of the other smells below (duplicated security logic, hard-to-test branches): there is no module boundary at which to test or reason about a single concern in isolation.

**Remediation.** Extract cohesive sub-modules behind explicit interfaces: (a) hook type definitions into `core/hooks/types.ts`; (b) the cross-origin credential state machine into a dedicated `core/security/cross-origin.ts`; (c) body/form serialization out of `index.ts`. Keep `Options` as a thin orchestrator over normalizer functions so each normalizer is independently unit-testable.

#### CPLX-001 — `afterResponse` hook array is mutated in-place during iteration, creating retry-state fragility

- **Severity:** 🟠 High · **Confidence:** high (0.85) · **Category:** complexity · **Effort:** M
- **Affected:** as-promise
- **Evidence:** `source/as-promise/index.ts:79`, `source/as-promise/index.ts:132-140`

**Why it matters.** Mutating `options.hooks.afterResponse` during iteration (line 136) is intentional per the comment, but it modifies shared mutable state on the `options` object that is reused across retries (line 226: `makeRequest(newRetryCount, request.options)`). On the next attempt the hook array has been truncated to the slice up to `index`. This is load-bearing but undocumented at the call site; any refactor that touches retry state management or reorders hook processing will silently break the deduplication invariant.

**Reasoning.** Line 79: `const hooks = options.hooks.afterResponse;` captures the reference. Line 136: `options.hooks.afterResponse = options.hooks.afterResponse.slice(0, index)` replaces the array on `options` so retries only see the truncated set. The mutation is effective but hidden: `options` escapes the closure (line 226), so the next `makeRequest` call receives options with a permanently mutated hook list. The retry semantics depend entirely on this side-effect, yet there is no invariant test for it.

**Remediation.** Separate the retry hook list from the options mutation. Pass a `hooksToRun` slice into the hook loop as a local variable without overwriting `options.hooks.afterResponse`. Instead, record the 'run-up-to' index and enforce it at the start of the next invocation, or document the invariant as an assertion in `makeRequest` so it's verifiable in tests.

#### DEBT-003 — HTTP alias methods spread an `Options` instance, silently dropping prototype methods

- **Severity:** 🟠 High · **Confidence:** high (0.83) · **Category:** technical-debt · **Effort:** M
- **Affected:** source/create.ts
- **Evidence:** `source/create.ts:320`

**Why it matters.** If a caller passes an `Options` instance as the second argument to an alias (e.g. `got.get(url, myOptions)`), the spread `{...options, method}` copies only own enumerable properties. All prototype-resident methods (`merge`, `freeze`, `toJSON`, etc.) are lost, producing a plain object instead of an `Options` instance and leading to runtime errors inside `Request` or `makeRequest`.

**Reasoning.** Line 320 reads `got(url, {...options, method})`. Object spread is shallow and prototype-unaware. The declared type of `options` at that callsite is `Options` (a class instance), not the plain `OptionsInit` interface. Any consumer who builds an `Options` object and passes it to `got.get()` / `got.post()` / etc. will have their instance silently degraded to a plain object. The same issue exists on line 323 for the stream shortcuts.

**Remediation.** Pass `method` via a dedicated plain-object merge: `got(url, {method} as OptionsInit, options instanceof Options ? options : undefined)`, or add an `Options.withMethod(method)` helper that returns a properly-derived instance.

#### MNT-005 — `isGotInstance` identifies Got instances by `is.function` alone — fragile duck-typing

- **Severity:** 🟠 High · **Confidence:** high (0.82) · **Category:** maintainability · **Effort:** S
- **Affected:** source/create.ts
- **Evidence:** `source/create.ts:26`

**Why it matters.** Any callable value (a plain arrow function, a class constructor, a mocked test double) will be treated as a Got instance in `extend()`, causing silent runtime failures when `.defaults.options.merge()` is called on a missing property.

**Reasoning.** Line 26 gates the Got-instance branch in `got.extend()` on `is.function(value)`. Every Got instance is a function, but the inverse is not true. A caller who accidentally passes a plain function (e.g. `got.extend(myMiddleware)`) will enter the Got-instance branch, attempt `value.defaults.options.merge(...)`, and throw an unhelpful TypeError. The correct discriminant is checking for the `defaults` property (e.g. `'defaults' in value && is.function(value)`).

**Remediation.** Change line 26 to: `const isGotInstance = (value: Got | ExtendOptions): value is Got => is.function(value) && 'defaults' in value;`

**Patch.** `patches/MNT-005.patch`

### 🟡 Medium (26)

#### MNT-014 — options.ts and index.ts are monolithic files exceeding 2500–3500 lines

- **Severity:** 🟡 Medium · **Confidence:** high (0.99) · **Category:** maintainability · **Effort:** L
- **Affected:** source/core
- **Evidence:** `source/core/options.ts:1-3466`, `source/core/index.ts:1-2524`

**Why it matters.** Files of this size are cognitively unmanageable, make merge conflicts in collaborative workflows near-certain, prevent incremental testing of subsystems, and degrade IDE tooling performance. A developer fixing a cache bug must scroll past retry, redirect, progress, and body logic to locate the relevant code.

**Reasoning.** options.ts at 3466 lines combines the Options class, all hook type definitions (each with 50–100 lines of JSDoc), normalization logic, cross-origin utilities, cookie-jar interfaces, and DNS helpers. index.ts at 2524 lines combines the Request class, cache integration, redirect handling, retry orchestration, progress reporting, body finalization, and abort management. Both files violate the single-responsibility principle at the module level and make it impractical to understand any one concern in isolation.

**Remediation.** Extract cohesive subsections into dedicated modules: hook type declarations into `hooks.ts`, cross-origin logic into `cross-origin.ts`, cache integration into `cache.ts`, retry orchestration into `retry.ts`, and progress tracking into `progress.ts`. Keep Options and Request as thin orchestrators that import from these modules. This can be done incrementally without breaking the public API.

#### MNT-022 — Traffic measurement example dereferences socket without null check despite documented undefined risk

- **Severity:** 🟡 Medium · **Confidence:** high (0.97) · **Category:** maintainability · **Effort:** S
- **Affected:** documentation
- **Evidence:** `documentation/tips.md:120-141`

**Why it matters.** The code example will throw `TypeError: Cannot read properties of undefined (reading 'bytesRead')` when a cached response is returned, because `stream.socket` is undefined in that case. The immediately preceding note block documents this exact risk, making the example self-contradictory.

**Reasoning.** Lines 122-124 explicitly warn 'The socket may be `undefined` when using cached responses.' However, lines 130-132 access `stream.socket.bytesRead` and `stream.socket.bytesWritten` inside the `response` event handler without any guard. The `end` handler on line 136 has the same bug. Developers will copy this as-is and encounter intermittent crashes in production when the cache layer is active.

**Remediation.** Add a null guard before socket access: `if (stream.socket) { console.log(...stream.socket.bytesRead...); }`. Apply the same pattern to the `end` handler and to the Promise API variant on lines 151-159.

**Patch.** `patches/MNT-022.patch`

#### MNT-023 — Retry and rate-limiting examples use pipe() despite explicit doc warning to avoid it

- **Severity:** 🟡 Medium · **Confidence:** high (0.96) · **Category:** maintainability · **Effort:** M
- **Affected:** documentation
- **Evidence:** `documentation/3-streams.md:334`, `documentation/tips.md:193-195`

**Why it matters.** The documented tip at line 62 of 3-streams.md explicitly states 'Avoid `from.pipe(to)` as it doesn't forward errors.' The retry example at line 334 and the rate-limiting example at tips.md:193-195 both use `pipe()` anyway. Developers will either follow the tip and get confused by the examples, or follow the examples and silently swallow errors.

**Reasoning.** 3-streams.md:62 says avoid `pipe()`. 3-streams.md:334 uses `stream.pipe(writeStream)` in the retry example and tips.md:193 uses `.pipe(new ThrottleTransform(...)).pipe(process.stdout)`. The retry case is particularly bad: a pipe error during retry will be silently dropped, defeating the purpose of the retry logic. Both should use `stream/promises.pipeline()` which propagates errors to a catchable promise rejection.

**Remediation.** Rewrite both examples to use `await streamPipeline(...)` from `node:stream/promises`. For the retry case, move stream setup into a factory function that can be called again on each retry event and wrap each pipeline call in try/catch.

#### DEBT-007 — Binary Illustrator source file committed to git without .gitattributes binary marker

- **Severity:** 🟡 Medium · **Confidence:** high (0.95) · **Category:** technical-debt · **Effort:** S
- **Affected:** media
- **Evidence:** `media/logo.ai:1`

**Why it matters.** Binary files in git bloat clone size on every checkout, produce unintelligible diffs (entire file shows as changed), and break `git log -p`, `git blame`, and PR review tooling. Without a `binary` declaration in .gitattributes, git may also corrupt the file on Windows due to CRLF normalization.

**Reasoning.** media/logo.ai:1 begins with `%PDF-1.5` — a PDF-wrapped Adobe Illustrator binary. It is 1801 lines of binary/base64-encoded data. Without a `.gitattributes` entry such as `*.ai binary`, git treats it as text, attempts CRLF normalization on Windows, and generates useless diff output. Additionally, design source files of this kind have no role in a TypeScript CLI build pipeline and add permanent, irremovable bulk to every git clone.

**Remediation.** Add `*.ai binary` to `.gitattributes` immediately to prevent CRLF corruption. For longer term hygiene: evaluate whether the `.ai` source needs to live in this repo at all — if it's just a design artifact, store it in a design system or object storage (e.g. Figma, S3) and reference it by URL in a design doc. The compiled `logo.svg` is the only artifact the build pipeline needs.

#### MNT-006 — InstalledClock and GlobalClock typed as `any`, defeating type safety

- **Severity:** 🟡 Medium · **Confidence:** high (0.95) · **Category:** maintainability · **Effort:** S
- **Affected:** test/helpers
- **Evidence:** `test/helpers/types.ts:14-15`

**Why it matters.** `any` here propagates into every test that receives a `clock` or `fakeTimer` argument, silently accepting any property access. Real errors (e.g. calling a non-existent method) are invisible to the type checker.

**Reasoning.** `@sinonjs/fake-timers` exports `InstalledClock` and `Clock` directly. The comment at line 13 references a PR that has since landed. Using `any` means call-sites in with-server.ts (e.g. lines 39, 96) get no static guarantee that tick/uninstall exist, and the `as InstalledClock` casts at lines 77 and 138 provide zero narrowing.

**Remediation.** Import `type { InstalledClock, Clock } from '@sinonjs/fake-timers'` and replace the `any` aliases. If the PR linked in the comment is merged, remove the workaround entirely.

#### MNT-019 — Monolithic test files impede navigation and isolability

- **Severity:** 🟡 Medium · **Confidence:** high (0.95) · **Category:** maintainability · **Effort:** L
- **Affected:** test
- **Evidence:** `test/hooks.ts:1-4419`, `test/redirects.ts:1-3204`, `test/pagination.ts:1-2217`

**Why it matters.** Files of 4419, 3204, and 2217 lines cannot be understood or reviewed as a unit; IDE performance degrades; partial re-runs (`ava --match`) become the only escape hatch; merge conflicts on these files destroy productivity in a collaborative setting.

**Reasoning.** Each file contains hundreds of independent test cases covering distinct sub-behaviors (hooks.ts covers at least: init hooks, beforeRequest hooks, beforeRedirect hooks, beforeRetry hooks, afterResponse hooks, beforeError hooks, cookie-jar behavior, agent behavior, context propagation). These are naturally grouped sub-concerns that should live in separate files. The current structure makes `grep`-based location of a specific test scenario an exercise in scrolling through thousands of lines.

**Remediation.** Split each file along semantic sub-topics: e.g., `test/hooks/init.ts`, `test/hooks/before-request.ts`, `test/hooks/after-response.ts`; `test/redirects/basic.ts`, `test/redirects/method-handling.ts`, `test/redirects/unix-socket.ts`. Shared helpers extracted per finding #1 become easy wins in this refactor.

#### MNT-007 — HttpServerOptions.bodyParser typed as NextFunction | false instead of options object

- **Severity:** 🟡 Medium · **Confidence:** high (0.93) · **Category:** maintainability · **Effort:** S
- **Affected:** test/helpers
- **Evidence:** `test/helpers/create-http-test-server.ts:6-8`, `test/helpers/with-server.ts:25-31`

**Why it matters.** `NextFunction` is `(err?: any) => void`, a callback type. Spreading a function into body-parser's config object is a type-system lie that only works at runtime because body-parser ignores unknown keys. The `as any` cast at with-server.ts:31 is the downstream symptom. Real body-parser options (e.g. `{type: () => false}`) are structurally valid but typed incorrectly, so the compiler cannot catch bad option shapes.

**Reasoning.** Line 7 of create-http-test-server.ts declares `bodyParser?: NextFunction | false`. The actual usage at with-server.ts lines 27-31 passes `{bodyParser: {type: () => false}}` — an options object, not a function. The spread at create-http-test-server.ts lines 25-35 would spread function enumerable properties (none by default), meaning the option is silently ignored, which may or may not match intent. The `as any` at line 31 of with-server.ts papers over the mismatch.

**Remediation.** Define a proper `BodyParserOptions` type (e.g. `{ type?: string | ((req: Request) => boolean) }`) and use that instead of `NextFunction`. Remove the `as any` cast in with-server.ts.

#### MNT-002 — Inner `catch (error)` silently shadows outer parse error reference

- **Severity:** 🟡 Medium · **Confidence:** high (0.92) · **Category:** maintainability · **Effort:** S
- **Affected:** as-promise
- **Evidence:** `source/as-promise/index.ts:62-74`

**Why it matters.** The outer `error` (parse failure from `parseBody`) and the inner catch's `error` (UTF-8 decode failure) are both named identically. After the inner catch block exits, line 72 calls `normalizeError(error)` intending the *outer* parse error, but a reader cannot tell which binding is in scope without detailed knowledge of JavaScript catch-block scoping. This is a future-edit trap: swapping the inner name accidentally would silently change which error propagates.

**Reasoning.** Line 62 opens `catch (error: unknown)`. Line 66 opens `catch (error)` which introduces a block-scoped binding that shadows the outer `error` only within its block. After that inner catch closes, line 72 uses `error` from the outer scope. The code is currently correct, but the identical names across nested catches make the control-flow fragile; a refactor that moves `normalizeError(error)` slightly would pick up the wrong error.

**Remediation.** Rename the inner catch binding: `catch (decodeError) { request._beforeError(new ParseError(normalizeError(decodeError), response)); return; }`. This makes the data flow unambiguous without changing behaviour.

#### CPLX-003 — `GotRequestFunction` has 24 overloads — combinatorial explosion that degrades TS performance and call-site ergonomics

- **Severity:** 🟡 Medium · **Confidence:** high (0.90) · **Category:** complexity · **Effort:** L
- **Affected:** source/types.ts
- **Evidence:** `source/types.ts:167-209`

**Why it matters.** TypeScript resolves overloads sequentially from top to bottom at every call-site. 24 overloads means the compiler evaluates up to 24 type checks per `got(...)` invocation. It also produces misleading error messages and makes adding a new response type (e.g., `FormData`) a 6-overload surgery.

**Reasoning.** Lines 167–209 list 24 call signatures that are a mechanical cross-product of: {url+options, options-only} × {text, json, buffer, unknown, fallback} × {plain, wrapped, bodyOnly}. The `Only`/`Wrapped`/plain triad exists because TypeScript can't currently discriminate overloads by a single option property at the type level without explicit overloads. A tagged-union approach for `responseType` and `resolveBodyOnly` combined with a conditional return type would collapse this to 4–6 overloads.

**Remediation.** Introduce a discriminated union `ResponseSpec<T, R, BodyOnly>` and use a single conditional return type `ResolveResponse<ResponseSpec, BodyOnly>`. Expose 3–4 overloads (url+options, options-only, stream, internal) and let the conditional type handle the body/wrapping distinction. This is a non-trivial refactor but eliminates the N×M combinatorial surface.

#### DUP-007 — Extract shared test-server hook setup duplicated in `with-server.ts`

- **Severity:** 🟡 Medium · **Confidence:** high (0.90) · **Category:** duplication · **Effort:** S
- **Affected:** test/helpers
- **Evidence:** `test/helpers/with-server.ts:22-80`, `test/helpers/with-server.ts:87-141`

**Why it matters.** The HTTP and HTTPS test-harness factories repeat the fake-timer install, the `avaTest` context property, and the clock-tick handler wiring. Because nearly every integration test runs through these macros, divergence between the two paths silently changes test behavior for half the suite.

**Reasoning.** `generateHook` (22-80) and `generateHttpsHook` (87-141) share three copy-pasted blocks: the `FakeTimers.install` configuration (34-39 vs 92-96), the non-enumerable `avaTest` context definition (41-47 vs 99-105), and the `handlers` array that calls `clock.tick(0)` on creation and on `response` (51-64 vs 109-122). The only real difference is the HTTPS certificate authority wiring.

**Remediation.** Factor out `installFakeClock()`, `makeAvaContext(title)`, and `makeTickHandler(clock)` helpers and have both macros compose them, so the HTTP/HTTPS paths cannot drift.

#### MNT-008 — caKey typed as Uint8Array but pem returns a string — masked by `as any`

- **Severity:** 🟡 Medium · **Confidence:** high (0.90) · **Category:** maintainability · **Effort:** S
- **Affected:** test/helpers
- **Evidence:** `test/helpers/create-https-test-server.ts:21`, `test/helpers/create-https-test-server.ts:97`

**Why it matters.** The declared type of `ExtendedHttpsTestServer.caKey` at line 21 is `Uint8Array`. The `pem` library returns PEM-encoded strings. Line 97 assigns `caKey as any` to suppress the error. Any consumer that trusts the declared type and passes `caKey` to a `Uint8Array` API will fail at runtime.

**Reasoning.** `pem.createCertificate` resolves with `{ clientKey: string, certificate: string, ... }`. The type declaration says `caKey: Uint8Array` and `caCert: Uint8Array` (line 22), but `caCert` is used as a string in `certificateAuthority` at with-server.ts line 126. The `caKey as any` on line 97 is a compile-time suppression of a real runtime type mismatch.

**Remediation.** Change `caKey` and `caCert` in `ExtendedHttpsTestServer` to `string`. Remove the `as any` cast at line 97.

#### MNT-024 — Stream upload progress example passes numeric size as content-length header

- **Severity:** 🟡 Medium · **Confidence:** high (0.90) · **Category:** maintainability · **Effort:** S
- **Affected:** documentation
- **Evidence:** `documentation/3-streams.md:131-143`, `documentation/2-options.md:294-299`

**Why it matters.** HTTP headers are string key-value pairs. Passing a `number` as a header value is accepted by Node.js's http module but results in implicit coercion. More importantly, this contradicts the correct pattern shown in 2-options.md:297 (`fileStats.size.toString()`), creating inconsistent guidance that can confuse developers about the expected type.

**Reasoning.** 3-streams.md:131 passes `'content-length': size` where `size` is the return value of `fs.statSync().size` — a `number`. 2-options.md:297 correctly calls `.toString()`: `'content-length': fileStats.size.toString()`. The TypeScript type for `OutgoingHttpHeaders` allows `number` for content-length specifically, but the inconsistency across examples is a documentation quality issue that will cause confusion about the canonical pattern.

**Remediation.** Update 3-streams.md:131 to `'content-length': String(size)` to match the pattern in 2-options.md:297 and make all upload examples consistent.

#### MNT-026 — createTestServer options typed as `unknown`, erasing all call-site safety

- **Severity:** 🟡 Medium · **Confidence:** high (0.90) · **Category:** maintainability · **Effort:** S
- **Affected:** test/types
- **Evidence:** `test/types/create-test-server/index.d.ts:4`

**Why it matters.** Every call to createTestServer accepts any argument silently. Misconfigured TLS or port options will not be caught by the type checker, making test-infrastructure bugs harder to surface during CI.

**Reasoning.** Line 4 declares `options: unknown` for the factory function. Because `unknown` is the widest possible type, TypeScript cannot validate any property passed in — misspelled keys, wrong value types, missing required fields all pass silently. The options shape for a create-test-server call (port, certificate material, etc.) is a bounded, documentable set; this is an omission, not a deliberate design choice.

**Remediation.** Replace `unknown` with an explicit options interface inside the `createTestServer` namespace: `export type Options = { certificate?: string; key?: string; port?: number; ... }`. Then update line 4 to `function createTestServer(options?: Options): Promise<createTestServer.TestServer>`.

#### TEST-003 — Timing-based assertions create flaky tests in CI

- **Severity:** 🟡 Medium · **Confidence:** high (0.90) · **Category:** testing · **Effort:** M
- **Affected:** test
- **Evidence:** `test/hooks.ts:100-101`, `test/pagination.ts:482-500`

**Why it matters.** Wall-clock timing assertions fail non-deterministically under CPU contention (busy CI runners, VMs with shared cores), producing spurious red builds that erode trust in the test suite.

**Reasoning.** hooks.ts:100–101 introduces a hard `delay(100)` inside a `beforeRequest` hook and then checks functional behavior, meaning the test is time-coupled for no test-correctness reason. pagination.ts:482–500 records `Date.now()` before and after an async iterator step to assert that the `backoff` option caused a delay of at least `backoff` ms; on a heavily loaded CI machine, the 200 ms window can be missed or the overhead can falsely satisfy the threshold.

**Remediation.** For hooks.ts:100: remove the `delay`; the async hook behavior doesn't require a real sleep to be tested. For pagination.ts:482: replace wall-clock assertion with a spy on `setTimeout`/`setInterval` using sinon fake timers (`sinon.useFakeTimers()`), then advance the clock programmatically and assert the iterator hasn't yielded yet, then advance past the backoff and assert it has.

#### CPLX-002 — `MergeExtendsConfig` recursive conditional type imposes TypeScript compile-time cost and is unmaintainable

- **Severity:** 🟡 Medium · **Confidence:** high (0.88) · **Category:** complexity · **Effort:** L
- **Affected:** source/types.ts
- **Evidence:** `source/types.ts:320-341`

**Why it matters.** Deeply recursive conditional types are evaluated eagerly by `tsc` for every `got.extend(...)` call-site. At scale this produces quadratic type-checking time. The type is also opaque enough that a future developer touching `extend()` semantics will likely break it silently.

**Reasoning.** Lines 320–341 implement a tail-recursive type-level fold over a variadic tuple using six levels of conditional nesting. TypeScript's instantiation depth limit (100 by default) constrains how many arguments `.extend()` can accept. The type is also incorrect for zero-argument calls (returns `never` on line 341). `type-fest`'s `Spread` (already used at line 1) combined with a simpler two-argument overload would cover 99% of real-world usage without the recursion.

**Remediation.** Replace the recursive type with explicit overloads for 1–4 arguments (covering real-world usage), using `Spread` from `type-fest` for pairwise merging. Fall back to `ExtendOptions` for the N-argument variadic case. This removes the recursion, the `never` edge, and the instantiation-depth risk.

#### DUP-002 — Duplicate context/handler/clock setup between generateHook and generateHttpsHook

- **Severity:** 🟡 Medium · **Confidence:** high (0.88) · **Category:** duplication · **Effort:** M
- **Affected:** test/helpers
- **Evidence:** `test/helpers/with-server.ts:22-80`, `test/helpers/with-server.ts:87-141`

**Why it matters.** The Object.defineProperty avaTest pattern (lines 41-47 and 99-105), the got handler that calls clock.tick(0) on response (lines 51-64 and 109-122), and the try/finally server close (lines 69-73 and 130-134) are structurally identical. Any bug fixed in one must be manually fixed in the other — as evidenced by the clock-uninstall ordering bug existing in both.

**Reasoning.** Roughly 35 of the ~55 lines of logic in the two functions are copy-pasted. The HTTP/HTTPS difference is limited to the server factory call and the `https` got option block. This is the classic 'parallel evolution' duplication pattern: divergent fixes in one copy that should apply to both.

**Remediation.** Extract a `buildGotContext(t)` helper for the Object.defineProperty pattern and a `buildClockHandler(clock)` helper for the got handler. The outer exec can then call those helpers; the HTTP/HTTPS branching remains only for server creation and got options.

#### DEBT-002 — Potential duplicate named export of `Options` in barrel

- **Severity:** 🟡 Medium · **Confidence:** high (0.85) · **Category:** technical-debt · **Effort:** S
- **Affected:** source/index.ts
- **Evidence:** `source/index.ts:15-16`

**Why it matters.** When two export statements in the same module resolve to the same binding name, the ESM spec requires the host to throw a `SyntaxError`. Even if TypeScript suppresses the error (explicit named export shadows `export *`), the intent is ambiguous and the barrel is fragile to refactors inside `options.js`.

**Reasoning.** Line 15 re-exports the *default* export of `./core/options.js` under the name `Options`. Line 16 does `export * from './core/options.js'`, which re-exports all *named* exports from that module. If `options.js` also has a named export called `Options` (the class itself), both lines contribute an `Options` binding to the barrel. TypeScript resolves this by giving the explicit re-export precedence, but bundlers and some runtimes may behave differently, and the intent is unclear.

**Remediation.** If the goal is to expose the class as `Options`, keep only line 15 (`export {default as Options}`) and add individual named re-exports instead of the blanket `export *`, or verify that `options.js` does not have a same-named named export and document why both statements coexist.

#### MNT-012 — Non-null assertion on options.url in ParseError constructor can crash on undefined URL

- **Severity:** 🟡 Medium · **Confidence:** high (0.85) · **Category:** maintainability · **Effort:** S
- **Affected:** source/core
- **Evidence:** `source/core/response.ts:150`

**Why it matters.** When a parse failure occurs before the URL is resolved (e.g. when using prefixUrl only), the non-null assertion dereferences undefined, replacing the meaningful ParseError with an unrelated TypeError that obscures the actual failure.

**Reasoning.** NormalizedOptions declares `url: URL | undefined` (options.ts line 98). ParseError's constructor at response.ts:150 calls `stripUrlAuth(options.url!)`. If a response is received and parsing fails before `options.url` is set to a full URL—possible when prefixUrl is used alone—the non-null assertion throws a TypeError inside the error constructor itself, swallowing the original parse failure.

**Remediation.** Replace `options.url!` with a safe fallback: `options.url ? stripUrlAuth(options.url) : 'unknown URL'`.

#### TEST-002 — Shared mutable Error singleton pollutes cross-test state

- **Severity:** 🟡 Medium · **Confidence:** high (0.85) · **Category:** testing · **Effort:** S
- **Affected:** test
- **Evidence:** `test/hooks.ts:24-25`

**Why it matters.** JavaScript Error objects are mutable. A hook or framework code that attaches properties to the error (e.g., `error.response`, `error.code`) between tests will mutate the singleton and cause later tests that compare against the pristine error to observe unexpected state.

**Reasoning.** Lines 24–25 declare `const errorString = 'oops'` and `const error = new Error(errorString)` at module scope. This `error` instance is then thrown by hooks in at least 10 separate tests (lines 114, 127, 143, 158, 189, 220, 237, 253, 270, 286). Got's `RequestError` wraps the original error and may attach `.options`, `.response`, or `.code` to it. If any such mutation occurs, subsequent assertions like `{message: errorString}` can still pass, but structural equality checks or identity comparisons in later tests may observe accumulated state. The safe pattern is `new Error(errorString)` inline in each test or in a `beforeEach` factory.

**Remediation.** Replace the module-level `error` singleton with a local `new Error(errorString)` inside each test, or use a factory `const makeError = () => new Error(errorString)` and call it at each use site.

#### DEBT-005 — makeProgress reports 100% complete when total=0 and transferred=0

- **Severity:** 🟡 Medium · **Confidence:** high (0.83) · **Category:** technical-debt · **Effort:** S
- **Affected:** source/core
- **Evidence:** `source/core/index.ts:285-293`

**Why it matters.** A request whose Content-Length is 0 will immediately emit a downloadProgress event with percent=1 before any data is received, corrupting progress listeners that drive UI indicators, throttling, or completion detection.

**Reasoning.** In makeProgress (line 285), `if (total)` is falsy when total is 0. Control falls to `else if (total === transferred)`, which evaluates `0 === 0` as true and sets percent = 1. This fires at the very start of a zero-content-length download, when transferred is also 0, producing a premature completion signal. The intent of the else-if branch—signal completion once all bytes have arrived—is defeated because it does not distinguish `total === undefined` from `total === 0`.

**Remediation.** Replace the condition with explicit undefined checks: `if (total !== undefined && total > 0) { percent = transferred / total; } else if (total !== undefined && transferred > 0 && transferred === total) { percent = 1; }`. This correctly leaves percent at 0 for unknown-length downloads and only sets 1 when all non-zero bytes have been transferred.

#### MNT-004 — `Object.defineProperties` used to forward event-emitter methods is an opaque structural hack

- **Severity:** 🟡 Medium · **Confidence:** high (0.82) · **Category:** maintainability · **Effort:** M
- **Affected:** as-promise
- **Evidence:** `source/as-promise/index.ts:269-272`

**Why it matters.** Bulk-copying all own property descriptors from one promise to another (line 270) is a non-obvious mechanism to forward `.on`/`.once`/`.off`/`.json`/`.buffer`/`.text` to the shortcut promise. It copies *every* own descriptor including any non-enumerable, getter, or symbol properties, which may have unintended side-effects if the source promise is augmented in the future. It also triggers the `@typescript-eslint/no-floating-promises` lint rule on the return value, requiring a suppresssion comment.

**Reasoning.** Line 270: `Object.defineProperties(newPromise, Object.getOwnPropertyDescriptors(promiseToAwait))`. `getOwnPropertyDescriptors` is a broad scoop—it copies accessor descriptors, non-enumerable props, and symbol-keyed props. Any future addition to the promise (e.g., a cancellation token or abort controller property) will be silently forwarded, potentially with shared mutable state between the original and shortcut promises. The eslint-disable at line 269 is itself a code smell: the rule fires because the return value (a Promise) is discarded, indicating the API is being misused for its side-effect.

**Remediation.** Explicitly forward only the known methods by name: `for (const key of ['on','once','off','json','buffer','text'] as const) { Object.defineProperty(newPromise, key, { value: (promiseToAwait as any)[key], writable: true, configurable: true }); }`. This makes the forwarding intent explicit, eliminates the lint suppression, and is robust against future property additions.

#### DEBT-010 — Resolve type-system escape hatches and FIXMEs in the shared test harness

- **Severity:** 🟡 Medium · **Confidence:** high (0.80) · **Category:** technical-debt · **Effort:** M
- **Affected:** test/helpers
- **Evidence:** `test/helpers/with-server.ts:24-30`, `test/helpers/with-server.ts:57`, `test/helpers/with-server.ts:115`

**Why it matters.** The most-imported test helper suppresses type errors in the exact place the public hook/handler types should be validated, so a regression in those signatures is hidden from every test that uses the harness.

**Reasoning.** The default hook casts the body-parser config `as any` behind a stale comment referencing issue #1186 (24-30), and the same `@ts-expect-error FIXME: Incompatible union type signatures` is duplicated at lines 57 and 115 to make `result.on('response', …)` type-check. The repetition signals a genuine gap in the public `Request`/handler union types rather than a one-off test quirk — and it is concentrated in `with-server.ts`, the highest-importance test file.

**Remediation.** Fix the underlying handler `result` union type in `source/core` so the `.on('response')` call type-checks, then delete both `@ts-expect-error` suppressions. Re-evaluate whether the #1186 body-parser workaround is still needed and remove the `as any` cast or replace it with a typed parser stub.

#### DEBT-001 — `globalResponse` is accessed without null-safety in `shortcut` after potential non-response rejection paths

- **Severity:** 🟡 Medium · **Confidence:** high (0.78) · **Category:** technical-debt · **Effort:** S
- **Affected:** as-promise
- **Evidence:** `source/as-promise/index.ts:37`, `source/as-promise/index.ts:259`

**Why it matters.** If the main promise settles through a path that doesn't go through the `response` event handler (e.g., a connection error before any response arrives where `throwHttpErrors` is false and an HTTPError is resolved via `onError`), `globalResponse` may not be set. The `shortcut` async IIFE accesses `globalResponse.request` (line 259) only after awaiting the main promise, so a rejection avoids the access—but in an `HTTPError`-suppressed resolve path (line 189 in `onError`) `globalResponse` is set at line 151 of the response handler. The variable is typed as `Response` (non-nullable) yet carries no definite-assignment assertion, so TypeScript's strict-mode flow analysis is the only guard, and it cannot verify cross-closure initialization.

**Reasoning.** Line 37: `let globalResponse: Response;` — no initializer. Line 259: `const {options} = globalResponse.request;` — unconditional dereference inside the async IIFE after the outer promise resolves. Under `exactOptionalPropertyTypes` + `strict`, TypeScript allows this because the variable is in the definite-assignment flow from the closure, but the compiler cannot verify that all resolve paths pass through the response handler. A defensive `globalResponse!` or typed `| undefined` with a guard would surface the invariant.

**Remediation.** Use a definite-assignment assertion to document the invariant: `let globalResponse!: Response;`. Additionally, add a guard in `shortcut`: `if (!globalResponse) throw new Error('No response captured');` to fail fast with a clear message rather than a TypeError on property access.

#### TEST-004 — Restore coverage on timeout branches excluded via `istanbul ignore`

- **Severity:** 🟡 Medium · **Confidence:** high (0.78) · **Category:** testing · **Effort:** M
- **Affected:** source/core
- **Evidence:** `source/core/timed-out.ts:95`, `source/core/timed-out.ts:134`, `source/core/timed-out.ts:167`

**Why it matters.** Timeout handling guards against hung connections and resource exhaustion. Explicitly excluding its socket/connect branches from coverage means correctness-critical, security-relevant paths can regress without any test failing.

**Reasoning.** `timed-out.ts` carries `/* istanbul ignore next */` on the error-rethrow path (95) and `/* istanbul ignore next: hard to test */` on the `socket.connecting` connect/send timeout branches (134, 167). These are the branches that decide whether lookup/connect/secureConnect/send timeouts arm at all. The 'hard to test' annotations suggest the branches are reachable in production but the harness cannot currently exercise them — the riskiest combination.

**Remediation.** Use a controllable socket (a raw `net` server via the existing `test/helpers/server-tools.ts:createRawHttpServer`, or a stubbed socket whose `connecting`/events are driven manually) to exercise the connecting-socket lookup/connect/secureConnect/send paths, then remove the ignore pragmas as coverage is established.

#### ARCH-001 — Mutable `iteration` closure counter allows handler to corrupt chain if `next` is called multiple times

- **Severity:** 🟡 Medium · **Confidence:** high (0.75) · **Category:** architecture · **Effort:** M
- **Affected:** source/create.ts
- **Evidence:** `source/create.ts:109-134`

**Why it matters.** The handler protocol has no documented constraint on single-call semantics for `next`. If any handler calls `next` twice (e.g., for retry logic inside a handler), the counter advances past the intended slot, skipping handlers or calling `lastHandler` prematurely and causing the request to fire unexpectedly.

**Reasoning.** Lines 109–110 declare `let iteration = 0` in the `makeRequest` closure, and `iterateHandlers` at line 111 reads and increments that shared counter via `iteration++`. The counter is not reset per `next` call. A handler that calls `next(options)` twice (for A/B testing, retry, or wrapping) would advance `iteration` to `N+1` on the second call, skipping the next registered handler. There is no guard or assertion enforcing single invocation.

**Remediation.** Pass the current index as a parameter rather than capturing it in a closure: `const iterateHandlers = (newOptions: Options, index = 0): GotReturn => { const handler = defaults.handlers[index] ?? lastHandler; return handler(newOptions, opts => iterateHandlers(opts, index + 1)) as GotReturn; };`. This makes double-call idempotent.

#### SEC-002 — Consolidate hand-rolled cross-origin credential-stripping logic

- **Severity:** 🟡 Medium · **Confidence:** medium (0.60) · **Category:** security · **Effort:** M
- **Affected:** source/core
- **Evidence:** `source/core/options.ts:58-70`, `source/core/index.ts:27-41`

**Why it matters.** Preventing Authorization/Cookie leakage across origins on redirect is security-critical. Here it is implemented as a bespoke snapshot/diff state machine spread across two large files, so a regression that leaks credentials cross-origin is easy to introduce and hard to spot in review.

**Reasoning.** `CrossOriginState` (options.ts:58-70) is an 11-field bag of headers, credential flags, body/json/form values and their snapshots. The decision logic — `crossOriginStripHeaders`, `isCrossOriginCredentialChanged`, `snapshotCrossOriginState`, `hasExplicitCredentialInUrlChange`, `isBodyUnchanged`, `isSameOrigin` — is imported into `index.ts:27-41` and woven into the redirect path. Security invariants implemented as scattered free functions over a mutable snapshot struct are exactly the kind of code that drifts when adjacent logic changes.

**Remediation.** Collapse this into a single audited `cross-origin` module that owns `CrossOriginState` and exposes one `stripCredentialsIfCrossOrigin(prev, next)` entry point. Add focused unit tests asserting Authorization/Cookie/body are dropped on origin change and preserved on same-origin redirects, independent of the full request stack.

### 🔵 Low (22)

#### DUP-003 — Duplicate `createStaticCookieJar` across test modules

- **Severity:** 🔵 Low · **Confidence:** high (1.00) · **Category:** duplication · **Effort:** S
- **Affected:** test
- **Evidence:** `test/hooks.ts:60-65`, `test/pagination.ts:21-26`

**Why it matters.** Identical helper defined twice means divergence risk: a future change to cookie-jar shape (e.g. adding `sameSite`) must be applied in both files independently, and the omission in one file will produce subtle test-coverage gaps.

**Reasoning.** The function `createStaticCookieJar` at hooks.ts:60–65 and pagination.ts:21–26 are byte-for-byte identical. Both files also import from `./helpers/with-server.js`, so a shared export from a test helper module (e.g., `test/helpers/cookie-jar.ts`) is the natural home for it.

**Remediation.** Extract `createStaticCookieJar` into `test/helpers/cookie-jar.ts`, export it, and import it in both files.

#### DUP-004 — `finiteHandler` and `relativeHandler` are identical, dead duplication

- **Severity:** 🔵 Low · **Confidence:** high (1.00) · **Category:** duplication · **Effort:** S
- **Affected:** test
- **Evidence:** `test/redirects.ts:23-35`

**Why it matters.** Two named functions with distinct semantic intent (`finite` vs `relative` redirect) are identical bodies; the distinction is fictional, which misleads readers about what each test is actually exercising.

**Reasoning.** `finiteHandler` (redirects.ts:23–28) and `relativeHandler` (redirects.ts:30–35) both issue `302 → /` with no distinguishing behavior. The only difference is the variable name. The reader cannot tell from these definitions whether the tests are truly distinguishing `finite` from `relative` semantics, or whether one name is a copy-paste artifact.

**Remediation.** Unify into a single `redirectToRootHandler` and update references. If the tests genuinely require distinct semantics, add the distinguishing logic (e.g., absolute vs. relative Location URL).

#### MNT-025 — Typo 'overriden' in stream retryCount note

- **Severity:** 🔵 Low · **Confidence:** high (1.00) · **Category:** maintainability · **Effort:** S
- **Affected:** documentation
- **Evidence:** `documentation/3-streams.md:95`

**Why it matters.** Minor credibility issue; 'overriden' should be 'overridden'. Low impact but trivially fixed.

**Reasoning.** Line 95 reads 'Must be overriden when retrying.' The correct spelling is 'overridden' (double-d).

**Remediation.** Change 'overriden' to 'overridden' on line 95.

#### MNT-001 — Generic parameter named `ReturnType` shadows built-in TypeScript utility type

- **Severity:** 🔵 Low · **Confidence:** high (0.97) · **Category:** maintainability · **Effort:** S
- **Affected:** as-promise/types
- **Evidence:** `source/as-promise/types.ts:11`

**Why it matters.** Naming a generic parameter `ReturnType` shadows the globally available `ReturnType<T>` utility type within that scope, causing silent confusion for any reader or tooling that expects the built-in. IDEs and type-hover will show the local binding, not the global one, making the type harder to audit.

**Reasoning.** Line 11 declares `json: <ReturnType>() => RequestPromise<ReturnType>`. `ReturnType` is a well-known TypeScript built-in conditional utility type. Reusing it as a free generic parameter name is legal but violates the principle of least surprise; any author who writes `ReturnType` expecting the built-in inside this scope will get the wrong type silently.

**Remediation.** Rename to `TReturn`, `T`, or `JsonReturnType`: `json: <TReturn>() => RequestPromise<TReturn>`.

#### MNT-013 — http2 agent typed as unknown | false, providing zero type safety

- **Severity:** 🔵 Low · **Confidence:** high (0.97) · **Category:** maintainability · **Effort:** S
- **Affected:** source/core
- **Evidence:** `source/core/options.ts:54`

**Why it matters.** Because `unknown | false` collapses to `unknown`, TypeScript accepts any value for the HTTP/2 agent, silently allowing type-incorrect configuration that will crash at runtime when the agent is used.

**Reasoning.** The `Agents` type at line 54 declares `http2?: unknown | false`. In TypeScript, `unknown | false` is equivalent to `unknown` because `false` is a subtype of `unknown`. The http2-wrapper package already has an exported agent/session type—`ClientHttp2Session` is imported at line 23—so a more specific type is available. Leaving it as `unknown` means callers receive no compile-time feedback when passing an incompatible value.

**Remediation.** Import the HTTP/2 agent type from http2-wrapper (e.g. `type Http2Agent`) and replace `unknown | false` with `Http2Agent | false`. If no public agent type is exported, document the `unknown` as intentional with a TODO and a link to the upstream issue.

#### DUP-001 — Reimport `Except` and `Merge` from `type-fest` instead of redefining locally

- **Severity:** 🔵 Low · **Confidence:** high (0.95) · **Category:** duplication · **Effort:** S
- **Affected:** source/types.ts
- **Evidence:** `source/types.ts:9-10`

**Why it matters.** `type-fest` is already imported on line 1 and exports both `Except` and `Merge` with identical semantics. Local copies diverge silently if `type-fest` semantics change and add maintenance surface with no benefit.

**Reasoning.** Lines 9–10 of `source/types.ts` hand-roll `Except<O,K>` and `Merge<A,B>` as verbatim copies of the `type-fest` definitions. The same file already imports `Spread` from `type-fest` (line 1), so the package is a declared dependency. Two definitions for the same utility type means any downstream fix or edge-case handling in `type-fest` is not picked up, and a future reader has to confirm the local copies are actually equivalent.

**Remediation.** Replace lines 9–10 with `import type {Except, Merge, Spread} from 'type-fest';` and delete the local definitions.

#### DUP-006 — Deduplicate `createStaticCookieJar` test helper across suites

- **Severity:** 🔵 Low · **Confidence:** high (0.95) · **Category:** duplication · **Effort:** S
- **Affected:** test
- **Evidence:** `test/hooks.ts:60-65`, `test/pagination.ts:21-26`

**Why it matters.** Identical helper logic copied into multiple test files drifts over time, so the same cookie-jar contract gets tested against subtly different stubs and fixes have to be applied in N places.

**Reasoning.** `createStaticCookieJar` is defined byte-for-byte identically in `test/hooks.ts:60-65` and `test/pagination.ts:21-26`. There is already a shared `test/helpers/` package (with-server, server-tools), so the absence of a shared cookie-jar stub is an oversight, not a constraint.

**Remediation.** Move `createStaticCookieJar` into `test/helpers/` (e.g. `server-tools.ts`) and import it in both suites.

#### MNT-020 — Fragile URL query-string parsing via string split in test helper

- **Severity:** 🔵 Low · **Confidence:** high (0.95) · **Category:** maintainability · **Effort:** S
- **Affected:** test
- **Evidence:** `test/pagination.ts:31`

**Why it matters.** Using `request.url.split('?')[1]` silently yields `undefined` when there is no query string, causing `new URLSearchParams(undefined)` to produce an empty object rather than failing loudly, masking test setup bugs.

**Reasoning.** pagination.ts:31 — `const searchParameters = new URLSearchParams(request.url.split('?')[1]);` — if the server ever receives a request without a query string (e.g., the paginator constructs the URL incorrectly), `split('?')[1]` returns `undefined`, `URLSearchParams` coerces that to the string `'undefined'`, and `searchParameters.get('page')` returns `null`, so `page` defaults to 1 silently. A full URL parse would throw or make the error obvious.

**Remediation.** Replace with `new URL(request.url, 'http://localhost').searchParams` which handles the no-query-string case cleanly and doesn't depend on string splitting.

#### MNT-003 — Generic type parameter `T` in `shortcut` shadows the outer function's `T`

- **Severity:** 🔵 Low · **Confidence:** high (0.93) · **Category:** maintainability · **Effort:** S
- **Affected:** as-promise
- **Evidence:** `source/as-promise/index.ts:35`, `source/as-promise/index.ts:254`

**Why it matters.** Two `T` type parameters in the same closure serve entirely different purposes: the outer `T` (line 35) is the full response generic, while the inner `T` (line 254) is the shortcut's return type. Their shadowing creates a type-level ambiguity that can mislead maintainers and inhibits TypeScript's ability to propagate the outer `T` constraint into the nested function.

**Reasoning.** Line 35: `function asPromise<T>`. Line 254: `const shortcut = <T>(promiseToAwait, responseType)`. Inside `shortcut`, any reference to `T` resolves to the local binding. The two `T`s are unrelated: the outer controls the promise resolution type while the inner controls the shortcut's decoded type. This is a latent confusion risk for any future type-level work on these generics.

**Remediation.** Rename the `shortcut` generic to `TBody` or `TResult`: `const shortcut = <TBody>(promiseToAwait: RequestPromise, responseType: Options['responseType']): RequestPromise<TBody>`.

#### DEBT-008 — `as any` type escape hatches weaken type-safety guarantees in tests

- **Severity:** 🔵 Low · **Confidence:** high (0.90) · **Category:** technical-debt · **Effort:** S
- **Affected:** test
- **Evidence:** `test/hooks.ts:89`, `test/redirects.ts:117-124`

**Why it matters.** Using `as any` on spy setup (hooks.ts:89) and on a complex DNS mock (redirects.ts:117–124) means TypeScript will not catch breakage if the `HttpAgent` API or Node's dns lookup signature changes, leaving silent runtime failures as the only detection mechanism.

**Reasoning.** hooks.ts:89 — `sinon.spy(agent, 'addRequest' as any)` — `addRequest` is a public method on `HttpAgent`; the `as any` is not necessary and suggests a sinon typing mismatch that should be fixed at the type level. redirects.ts:117–124 — the inline DNS lookup mock is cast `as any` because its overloaded signature is complex, but this should be typed with the proper `dns.LookupFunction` type from `@types/node`.

**Remediation.** For hooks.ts:89: use `sinon.spy<HttpAgent, 'addRequest'>(agent, 'addRequest')` with proper generics. For redirects.ts:117: type the mock as `import type {LookupFunction} from 'node:net'` (or `dns.lookup`'s signature) and remove the `as any` cast.

#### DUP-005 — Repeated pagination-option validation tests should be parameterized

- **Severity:** 🔵 Low · **Confidence:** high (0.90) · **Category:** duplication · **Effort:** S
- **Affected:** test
- **Evidence:** `test/pagination.ts:302-349`

**Why it matters.** Four structurally identical tests (lines 302–349) each test one missing `pagination` option, differing only in which options are preset. Adding a new required pagination property requires a fifth copy; missing one leaves a gap in coverage with no compiler warning.

**Reasoning.** pagination.ts:302–349 contains four nearly identical test bodies that each build a slightly longer `pagination` config and assert `iterator.next()` throws. The pattern is: reset all → add one property → assert throws. This is a textbook candidate for a data-driven/parameterized test: an array of `[description, partialConfig]` pairs iterated with `for ... of` and `test()`.

**Remediation.** Convert to a parameterized loop: `const cases = [['no transform', {}], ['no shouldContinue', {transform: thrower}], ...]; for (const [label, config] of cases) { test(label, async t => { ... }); }`.

#### MNT-017 — SVG unminified to a single unreadable line — unfeasible to review or patch

- **Severity:** 🔵 Low · **Confidence:** high (0.90) · **Category:** maintainability · **Effort:** S
- **Affected:** media
- **Evidence:** `media/logo.svg:1`

**Why it matters.** Any future change to the SVG (color token update, accessibility `<title>` addition, path correction) requires external tooling or a full rewrite because the file has no human-readable structure. PR diffs will show a single massive line changed, making review impossible.

**Reasoning.** media/logo.svg is exactly 1 line containing the entire SVG. There are two `<path>` elements and no accessibility metadata (`<title>`, `<desc>`). The compact form is fine for a production build output but not for a source-controlled asset that humans may need to maintain.

**Remediation.** Store the formatted (pretty-printed) SVG in source control and add a build step that minifies it for distribution if bundle size matters. Also add a `<title>` child element (e.g. `<title>Logo</title>`) for accessibility — without it, screen readers and SVG-embedding contexts have no label for the image.

#### MNT-010 — `(server as any).caCert` bypasses ExtendedHttpsTestServer type

- **Severity:** 🔵 Low · **Confidence:** high (0.88) · **Category:** maintainability · **Effort:** S
- **Affected:** test/helpers
- **Evidence:** `test/helpers/with-server.ts:125`, `test/helpers/create-https-test-server.ts:22`

**Why it matters.** The `as any` cast at with-server.ts:125 defeats the type declaration of `ExtendedHttpsTestServer` that already declares `caCert`. If `caCert` is renamed or removed in the server type, this access silently becomes `undefined` at runtime with no compile-time error.

**Reasoning.** `ExtendedHttpsTestServer` at line 22 of create-https-test-server.ts declares `caCert: Uint8Array`. The server variable at with-server.ts:89 is already typed as `ExtendedHttpsTestServer`, so `server.caCert` should resolve without a cast. The `as any` is a symptom of the type mismatch finding above (Uint8Array vs string): once that is fixed the cast becomes unnecessary.

**Remediation.** Fix the `caKey`/`caCert` type to `string` (per finding above), then access `server.caCert` directly without any cast.

#### PERF-001 — `new URL(options.url)` constructed on every afterResponse hook iteration

- **Severity:** 🔵 Low · **Confidence:** high (0.88) · **Category:** scalability-performance · **Effort:** S
- **Affected:** as-promise
- **Evidence:** `source/as-promise/index.ts:82-83`

**Why it matters.** URL parsing is non-trivial. Constructing a new `URL` object on every iteration of the afterResponse hook loop (line 82) means `N` allocations for `N` hooks, even though the URL value is fixed for a given response. In practice most requests have one or two afterResponse hooks, but it is wasted work that could accumulate in high-throughput scenarios or in test harnesses running many redirects.

**Reasoning.** Line 82: `const previousUrl = options.url ? new URL(options.url) : undefined;` is inside the `for...of` loop that iterates over `hooks.entries()`. Both `previousUrl` and `previousState` (line 83) are computed from state that does not change between hook iterations. They should be hoisted out of the loop.

**Remediation.** Hoist the two computations before the loop:
```ts
const previousUrl = options.url ? new URL(options.url) : undefined;
const previousState = previousUrl ? snapshotCrossOriginState(options) : undefined;
for (const [index, hook] of hooks.entries()) { ... }
```

#### DEBT-004 — Redundant double-assignment of `isStream` flag on `Request` options

- **Severity:** 🔵 Low · **Confidence:** high (0.87) · **Category:** technical-debt · **Effort:** S
- **Affected:** source/create.ts
- **Evidence:** `source/create.ts:82-89`

**Why it matters.** The duplicated assignment obscures the actual control flow and makes it unclear whether the `cloneWithProperty` path (lines 82–83) is reliable. Future maintainers may remove one assignment believing it is dead code, breaking either the plain-object or class-instance path.

**Reasoning.** Lines 82–83 clone the incoming url/options object with `isStream: true` before constructing the `Request`. Lines 87–89 then unconditionally set `request.options.isStream = true` again on the constructed request. If the `cloneWithProperty` approach fully propagates into `Request`, the post-construction assignment is redundant. If `Request` ignores the constructor option and only honours the setter, the clone approach is dead code. Either way, only one mechanism should be canonical.

**Remediation.** Determine whether `Request` honours `isStream` in its constructor options (via `cloneWithProperty`) or only via the direct setter, then remove the redundant path and add a brief comment explaining which mechanism is authoritative.

#### MNT-009 — Mixed promisify strategies across helpers

- **Severity:** 🔵 Low · **Confidence:** high (0.85) · **Category:** maintainability · **Effort:** S
- **Affected:** test/helpers
- **Evidence:** `test/helpers/create-http-test-server.ts:38-48`, `test/helpers/create-https-test-server.ts:29-30`, `test/helpers/server-tools.ts:15-16`

**Why it matters.** Three different patterns for converting callbacks to promises: manual `new Promise` in create-http-test-server.ts:38-48, `pify` (third-party) in create-https-test-server.ts:29-30, and `promisify` with manual type casts in server-tools.ts:15-16 and with-server.ts:158. This increases cognitive load and dependency surface unnecessarily.

**Reasoning.** `pify` is a direct analog to `util.promisify` from Node.js core. Using it in create-https-test-server.ts when every other helper already imports `util.promisify` or uses `new Promise` adds an extra dependency (`pify`) for no benefit. `server-tools.ts` also manually casts to `(callback: (error?: Error) => void) => void` to satisfy promisify's overloads, which is a workaround that would be cleaner as `new Promise`.

**Remediation.** Replace `pify` in create-https-test-server.ts with `util.promisify`. Standardize on `util.promisify` or `new Promise` across all helpers and remove the `pify` dependency.

#### DEBT-009 — pem type wrappers model only the callback API, blocking async/await adoption

- **Severity:** 🔵 Low · **Confidence:** high (0.80) · **Category:** technical-debt · **Effort:** S
- **Affected:** test/types
- **Evidence:** `test/types/pem.ts:9-13`

**Why it matters.** Any test code that wants to use these operations in an async function must reach for `util.promisify` or a wrapper at every call site, adding boilerplate and risking inconsistent error handling.

**Reasoning.** All three exported types — `CreateCertificate` (line 9), `CreateCsr` (line 11), and `CreatePrivateKey` (line 13) — model the raw `(options, callback) => void` shape from the `pem` package. The `pem` package also exposes promise-returning variants (`pem.createCertificate` returns a Promise when called without a callback since pem@1.14). Typing only the callback form forces consumers to remain in callback style or promisify at every use site rather than once at the boundary.

**Remediation.** Add parallel promise-based type aliases: `export type CreateCertificateAsync = (options: CertificateCreationOptions) => Promise<CertificateCreationResult>` etc., or replace the callback forms with promise forms if the test suite already uses async/await throughout.

#### MNT-015 — Unverified error cast to OptionsError in constructor catch block

- **Severity:** 🔵 Low · **Confidence:** high (0.80) · **Category:** maintainability · **Effort:** S
- **Affected:** source/core
- **Evidence:** `source/core/index.ts:392-394`

**Why it matters.** If any error thrown during Options construction is not an OptionsError (e.g. from a hook dependency), the cast silently leaves `options` undefined and assigns nothing to `this.options`, making the deferred flush path operate on an uninitialised instance.

**Reasoning.** Line 392 uses `const {options} = error as OptionsError;` in a catch block. The cast is structurally unchecked—TypeScript cannot verify that the thrown error actually carries an `options` property. While the `if (options)` guard on line 393 handles the undefined case at runtime, the cast suppresses type narrowing that could distinguish OptionsError from other error types, preventing the application of more specific recovery logic for non-OptionsError failures.

**Remediation.** Replace the unsafe cast with a safe property access: `const options = (error as Partial<OptionsError>).options;`. This is both type-safe and accurately expresses the intent.

#### DEBT-006 — Node.js version parsed with Number() silently produces NaN on pre-release build strings

- **Severity:** 🔵 Low · **Confidence:** high (0.75) · **Category:** technical-debt · **Effort:** S
- **Affected:** source/core
- **Evidence:** `source/core/options.ts:39`

**Why it matters.** On Node.js nightly or RC builds (e.g. `20.0.0-nightly20231001`), `Number('0-nightly20231001')` returns NaN. Any feature-flag comparison using `major` or `minor` silently evaluates to false, potentially enabling or disabling HTTP/2 negotiation or other version-gated behavior incorrectly.

**Reasoning.** Line 39 uses `.split('.').map(Number)` to extract the Node.js major and minor version. For pre-release builds, the patch segment contains non-numeric characters (`'0-nightly...'`), causing `Number()` to return NaN for that element. While only `major` and `minor` are destructured, the `as [number, number, number]` cast tells TypeScript to trust the result unconditionally, hiding the NaN risk from static analysis. If upstream ever includes pre-release markers in major or minor (e.g. `20.0-beta.1`), the parsed values would be NaN.

**Remediation.** Use `parseInt(segment, 10)` instead of `Number` to stop parsing at the first non-digit character. Add a guard: `if (!Number.isFinite(major) || !Number.isFinite(minor)) throw new Error('Unrecognized Node.js version format: ' + process.versions.node);`.

#### MNT-018 — SVG color values not traceable to documented brand tokens in source file

- **Severity:** 🔵 Low · **Confidence:** high (0.75) · **Category:** maintainability · **Effort:** S
- **Affected:** media
- **Evidence:** `media/logo.svg:1`, `media/logo.ai:99-421`

**Why it matters.** When brand colors change, engineers have no canonical source of truth for which hex value maps to which brand slot, leading to inconsistent updates across assets.

**Reasoning.** media/logo.svg:1 uses exactly two colors: `#43dea4` and `#8085bb`. The swatch palette embedded in media/logo.ai:99–421 lists ~40 named RGB swatches (White, Black, RGB Red, R=193 G=39 B=45, etc.) but neither `#43dea4` nor `#8085bb` appears among them, indicating the exported SVG's colors diverged from the source palette — either by a manual edit post-export or a colorspace conversion. There is no CSS custom property or design token file mapping these values to semantic names.

**Remediation.** Reconcile the two colors against the intended brand palette in the `.ai` file, then document them as CSS custom properties (e.g. `--color-logo-arrow: #43dea4; --color-logo-text: #8085bb;`) in a tokens file. Reference those tokens in the SVG via `fill="var(--color-logo-arrow)"` for inline-SVG contexts, or document the hex values with their brand names in a COLORS.md.

#### MNT-027 — slow-stream stub re-exports PassThrough without constructor override, silently accepting wrong arguments

- **Severity:** 🔵 Low · **Confidence:** medium (0.72) · **Category:** maintainability · **Effort:** S
- **Affected:** test/types
- **Evidence:** `test/types/slow-stream/index.d.ts:1-5`

**Why it matters.** The `slow-stream` package adds a `bps` (bytes-per-second) or delay option to its constructor. Typing it as a bare `PassThrough` re-export hides that parameter from callers, making the stub actively misleading rather than merely incomplete.

**Reasoning.** Line 4 (`export = PassThrough`) asserts structural identity with Node's built-in PassThrough. slow-stream's constructor accepts a throttle option object not present in the PassThrough signature. Because the stub is a bare re-export, TypeScript will accept `new SlowStream(1000)` (passing the throttle value) but also refuse or silently mistype it, depending on TypeScript version and overload resolution — the behaviour is undefined and fragile.

**Remediation.** Replace the bare re-export with a minimal typed class: `class SlowStream extends PassThrough { constructor(options?: PassThroughOptions & { bps?: number }); }` then `export = SlowStream`. This documents the extended constructor and preserves stream compatibility.

#### CPLX-004 — Replace fragile manual stack-trace string surgery in `RequestError`

- **Severity:** 🔵 Low · **Confidence:** medium (0.65) · **Category:** complexity · **Effort:** M
- **Affected:** source/core
- **Evidence:** `source/core/errors.ts:58-70`

**Why it matters.** Every error in the library flows through this constructor; brittle string manipulation on `.stack` is a maintenance hazard that can corrupt diagnostics across all error types if the formatting assumptions break across Node versions.

**Reasoning.** The constructor merges the wrapped error's stack into its own by `indexOf`-ing each message inside its stack, slicing, reversing, de-duplicating shared frames, and re-joining (58-70). This depends on stack strings containing the message verbatim and on a stable frame format — assumptions that vary by Node version and by errors with multi-line or empty messages. As the single chokepoint for `MaxRedirectsError`, `HTTPError`, `TimeoutError`, etc., a subtle off-by-one here degrades debuggability everywhere.

**Remediation.** Prefer the native error `cause` chain (already passed via `super(message, {cause: error})`) for diagnostics and drop the manual merge, or isolate the merge into a small, separately unit-tested `mergeStacks(outer, inner)` function with cases for empty/multiline messages and missing stacks.

## Proposed Improvements

- `patches/MNT-021.patch` — MNT-021 — 🟡 proposed (unverified)
- `patches/MNT-016.patch` — MNT-016 — 🟡 proposed (unverified)
- `patches/TEST-001.patch` — TEST-001 — 🟡 proposed (unverified)
- `patches/SEC-001.patch` — SEC-001 — 🟡 proposed (unverified)
- `patches/MNT-005.patch` — MNT-005 — 🟡 proposed (unverified)
- `patches/MNT-022.patch` — MNT-022 — 🟡 proposed (unverified)

## Appendix

### Coverage
- Files analyzed: 118 (78 parsed precisely) · 41829 LOC · 161 dependency edges · 16 components
- Skipped during ingest: 2 binary, 0 too-large, 0 ignored
- Languages: typescript (72), javascript (6)

### Analysis
- Passes: 8 deep-dives + cross-cutting
- Findings: 58 raw → 58 grounded (0 dropped by the evidence gate)
- LLM: 16 calls · 89698 tokens · ~$2.9923 · 1 model substitutions

---
_Every finding above cites evidence that resolves to real source lines; ungrounded findings were dropped automatically._
