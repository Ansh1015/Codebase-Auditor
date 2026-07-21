# Engineering Audit — requests

_Generated 2026-06-29T10:27:10.898Z · commit `4ed3d1b320` · via Claude Code subscription (claude CLI, OAuth — Pro/Max) (cached)_

## Executive Summary

**Health score: 0/100**

| Critical | High | Medium | Low | Info | Total |
|---|---|---|---|---|---|
| 0 | 7 | 17 | 27 | 2 | 53 |

**Top risks:**
- 🟠 High — **DEBT-006** Code examples teach file-handle resource leaks via bare open() calls
- 🟠 High — **SEC-002** Replace assert-based version checks with explicit raises
- 🟠 High — **ARCH-001** Module-level import permanently mutates the process-wide warnings filter
- 🟠 High — **MNT-012** make.bat invokes private Sphinx internal module instead of public entry point
- 🟠 High — **SEC-003** Use CERT_REQUIRED instead of CERT_OPTIONAL for mutual TLS verification

## Architecture Overview

This is the `requests` Python HTTP library — a thin, ergonomic wrapper over urllib3 that exposes a session-centric model for making HTTP requests. The public surface is a flat `api.py` that delegates to a `Session` object in `sessions.py`; `Session` orchestrates the full request lifecycle: merging settings, running hooks, preparing requests via `models.py`, dispatching through a mounted `HTTPAdapter` in `adapters.py`, and returning a `Response`. The dependency graph fans outward from `__init__.py` and `compat.py` (both scoring 0.77 in-centrality), meaning almost every module imports through them — a classic hub-and-spoke arrangement that makes compat breaks catastrophically broad.

The data model lives almost entirely in `models.py` (1185 LOC, 0.77 centrality): it houses `Request`, `PreparedRequest`, and `Response` in a single file, creating a god-class concentration of URL encoding, header normalization, body serialization, redirect logic, and response decoding. `utils.py` (1156 LOC) is a second dumping ground — utility functions with no clear cohesion boundary that are imported by nearly every other module, making it a de-facto second hub. `cookies.py` (626 LOC) adds a third sizable stateful subsystem wrapping `http.cookiejar`, with its own internal complexity around cross-domain and path scoping.

The adapter layer (`adapters.py`, 749 LOC) is the only formal abstraction boundary: it defines `BaseAdapter` and the concrete `HTTPAdapter` that wraps urllib3 connection pools. Everything above this line is pure Python requests logic; everything below is delegated to urllib3/certifi. This boundary is architecturally sound but `adapters.py` has grown large enough to warrant watching.

Structural smells visible from the map: (1) `models.py` + `utils.py` together account for ~37% of source LOC and both have near-maximum in-degree — god-file risk and hidden coupling; (2) `compat.py` is tiny but sits at 0.77 centrality, meaning any Python-version incompatibility radiates everywhere; (3) the test suite has 3095 LOC concentrated in a single `test_requests.py` file, suggesting low modularity in the test layer and likely slow incremental feedback; (4) 27 certificate files in `tests/certs` signals non-trivial TLS test infrastructure that can silently rot as cert expiry approaches.

## Findings

### 🟠 High (7)

#### DEBT-006 — Code examples teach file-handle resource leaks via bare open() calls

- **Severity:** 🟠 High · **Confidence:** high (0.97) · **Category:** technical-debt · **Effort:** S
- **Affected:** docs/user
- **Evidence:** `docs/user/quickstart.rst:311`, `docs/user/quickstart.rst:326`, `docs/user/advanced.rst:403-405`

**Why it matters.** Documentation code examples are cargo-culted verbatim by users. Showing `open()` without a context manager teaches a pattern that leaks file descriptors. At scale (many requests in a long-lived process) this can exhaust OS file-handle limits. The 'binary mode' warning in the same proximity makes these examples look authoritative, amplifying adoption of the bad pattern.

**Reasoning.** quickstart.rst:311 `open('report.xls', 'rb')`, quickstart.rst:326 same, advanced.rst:403-405 two inline `open()` calls for `foo.png` and `bar.png` — none are wrapped in `with` statements. If `requests.post` raises before the response is read, or if the interpreter doesn't GC promptly, the underlying file descriptor is never closed.

**Remediation.** Restructure all three examples to use `with open(...) as f:` blocks and pass `f` to the `files` or `data` parameter. For the multipart tuple example, either use nested `with` blocks or open files before constructing the list and close them in a `finally`.

#### SEC-002 — Replace assert-based version checks with explicit raises

- **Severity:** 🟠 High · **Confidence:** high (0.97) · **Category:** security · **Effort:** S
- **Affected:** src/requests/__init__.py
- **Evidence:** `src/requests/__init__.py:66`, `src/requests/__init__.py:76-90`

**Why it matters.** Python's -O flag silently strips all assert statements. Any deployment that uses optimised bytecode (common in containers and embedded environments) will run with completely neutered dependency-version checks, allowing an incompatible urllib3 or chardet to pass through silently. The caller at __init__.py:118 catches AssertionError, which also becomes a no-op under -O, so the fallback warning never fires either.

**Reasoning.** Lines 66, 76-78, 85, and 90 use bare `assert` for runtime version enforcement inside `check_compatibility`. The entire function is wrapped in a try/except AssertionError at line 118. Under `python -O`, every assert is removed; the function becomes a no-op and the except branch never fires, so an incompatible urllib3 or charset library is silently accepted.

**Remediation.** Replace every `assert` in `check_compatibility` with an explicit `if not condition: raise ValueError(...)`. Catch `ValueError` (not `AssertionError`) at the call site on line 118.

**Patch.** `patches/SEC-002.patch`

#### ARCH-001 — Module-level import permanently mutates the process-wide warnings filter

- **Severity:** 🟠 High · **Confidence:** high (0.95) · **Category:** architecture · **Effort:** S
- **Affected:** src/requests/__init__.py
- **Evidence:** `src/requests/__init__.py:150-152`, `src/requests/__init__.py:219`

**Why it matters.** Calling warnings.simplefilter('ignore', DependencyWarning) at module scope on import affects every other piece of code running in the same process. Any library that relies on urllib3.exceptions.DependencyWarning to surface actionable information will have its warnings silently discarded. This is a process-global side effect triggered by a passive import.

**Reasoning.** Line 152 calls `warnings.simplefilter('ignore', DependencyWarning)` unconditionally at import time. Line 219 similarly calls `warnings.simplefilter('default', FileModeWarning, append=True)`. Both are global mutations. Libraries should use `warnings.catch_warnings()` or module-scoped filters that are narrowly scoped to the call site, not the entire interpreter.

**Remediation.** Wrap any warning-filter changes that are only relevant to requests' own internal code inside context managers (`warnings.catch_warnings(record=True)`) at the call site rather than applying process-global filters at import time.

#### MNT-012 — make.bat invokes private Sphinx internal module instead of public entry point

- **Severity:** 🟠 High · **Confidence:** high (0.95) · **Category:** maintainability · **Effort:** S
- **Affected:** docs
- **Evidence:** `docs/make.bat:58`

**Why it matters.** Calling `python -m sphinx.__init__` (line 58) invokes a private implementation module, not the documented public entry point `python -m sphinx`. Any internal refactor of the Sphinx package—such as moving the `__init__` bootstrap logic—will silently break the Windows docs build fallback path with no actionable error.

**Reasoning.** The Sphinx-recommended fallback for missing `sphinx-build` binaries is `python -m sphinx`, which invokes the package's `__main__.py`. The code at make.bat:58 uses `python -m sphinx.__init__` instead, which is an internal implementation detail. This works today by accident (Python will execute `__init__` as a script if no `__main__` is present for the submodule path) but is fragile: Sphinx 7.x restructuring could break this, and the error would be confusing ('No module named sphinx.__init__.__main__').

**Remediation.** Change line 58 to `set SPHINXBUILD=python -m sphinx`. This matches the official Sphinx documentation for the fallback path.

**Patch.** `patches/MNT-012.patch`

#### SEC-003 — Use CERT_REQUIRED instead of CERT_OPTIONAL for mutual TLS verification

- **Severity:** 🟠 High · **Confidence:** high (0.95) · **Category:** security · **Effort:** S
- **Affected:** TLSServer
- **Evidence:** `tests/testserver/server.py:168`

**Why it matters.** CERT_OPTIONAL allows connections from clients that present no certificate at all. In a mutual TLS scenario, the server should reject unauthenticated clients — CERT_OPTIONAL defeats that guarantee and silently allows unverified peers through.

**Reasoning.** Line 168 sets `ssl_context.verify_mode = ssl.CERT_OPTIONAL` when `mutual_tls=True`. The Python ssl docs explicitly state that CERT_OPTIONAL does not verify the certificate if none is presented; only CERT_REQUIRED enforces that a valid client certificate must be supplied. Even in a test server this is a meaningful flaw: tests intended to exercise mTLS rejection paths will silently pass when they should fail, giving false confidence that production mTLS is wired correctly.

**Remediation.** Change line 168 to `self.ssl_context.verify_mode = ssl.CERT_REQUIRED`. This matches the semantic intent of mutual TLS and will correctly reject clients that present no certificate.

**Patch.** `patches/SEC-003.patch`

#### TEST-001 — Duplicate DNS.1 SAN key silently drops wildcard entry from certificates

- **Severity:** 🟠 High · **Confidence:** high (0.95) · **Category:** testing · **Effort:** S
- **Affected:** tests/certs
- **Evidence:** `tests/certs/expired/server/cert.cnf:21-22`, `tests/certs/valid/server/cert.cnf:28-29`

**Why it matters.** OpenSSL's config parser uses last-value-wins for duplicate keys within a section. Both cert.cnf files set DNS.1 twice, so '*.localhost' is silently overwritten by 'localhost'. Any test relying on wildcard hostname matching will fail against these certificates with an unexpected SAN mismatch, producing misleading test failures rather than the intended behavior under test.

**Reasoning.** In both cert.cnf files, the [alt_names] section contains 'DNS.1 = *.localhost' immediately followed by 'DNS.1 = localhost'. OpenSSL's CONF parser resolves duplicate keys by retaining the last occurrence within a section. The resulting certificates therefore carry only 'DNS.1 = localhost'; the wildcard SAN is never encoded. The valid/server/server.pem SAN extension (line 15) encodes 'localhost', '127.0.0.1', and '::1' with no wildcard entry, confirming the bug. The second entry must be renamed to DNS.2.

**Remediation.** In both cert.cnf files change the second entry: 'DNS.1 = localhost' → 'DNS.2 = localhost'. Then regenerate all affected certificates via 'make clean && make all' in each directory. Verify with 'openssl x509 -in server.pem -noout -ext subjectAltName' that both DNS entries appear.

#### MNT-013 — flask_theme_support pygments style is an undocumented, unversioned runtime dependency

- **Severity:** 🟠 High · **Confidence:** high (0.90) · **Category:** maintainability · **Effort:** M
- **Affected:** docs
- **Evidence:** `docs/conf.py:25`, `docs/conf.py:106`, `docs/requirements.txt:1-4`

**Why it matters.** If `docs/_themes/flask_theme_support.py` is absent (e.g., fresh clone without submodules, or a CI environment), the docs build fails at import time with a cryptic ModuleNotFoundError on `pygments_style`. This dependency is not expressed anywhere in `docs/requirements.txt`.

**Reasoning.** conf.py:25 inserts `_themes` onto `sys.path`, and conf.py:106 sets `pygments_style = "flask_theme_support.FlaskyStyle"`. This means `_themes/flask_theme_support.py` must exist at build time. However, `docs/requirements.txt` only lists `Sphinx==7.2.6`; there is no pip-installable package for this custom style, no mention in any requirements file, and no error handling if the import fails. Docs CI systems or contributors running `pip install -r docs/requirements.txt` followed by `make html` will get a build failure.

**Remediation.** Either (a) extract `flask_theme_support.FlaskyStyle` into a standalone pip package and add it to `docs/requirements.txt`, or (b) replace it with a standard Pygments style (e.g., `pygments_style = 'friendly'`) and document that `_themes/` is a required directory in the contributing guide.

### 🟡 Medium (17)

#### MNT-009 — Fix typo in certifi hyperlink target (double 'i' produces broken URL)

- **Severity:** 🟡 Medium · **Confidence:** high (1.00) · **Category:** maintainability · **Effort:** S
- **Affected:** docs/user
- **Evidence:** `docs/user/advanced.rst:295`

**Why it matters.** The hyperlink target resolves to 'certifiio.readthedocs.io', a nonexistent domain. Every reader who follows the link in the rendered HTML gets a 404. Broken external links erode documentation trust and make it harder to verify the CA-bundle guidance that the surrounding security-sensitive section depends on.

**Reasoning.** Line 295 reads `.. _certifi: https://certifiio.readthedocs.io/`. 'certifiio' is a doubled-'i' typo; the canonical package documentation lives at certifi.io or certifi.readthedocs.io. This is a definite authoring error, not a valid alternate domain.

**Remediation.** Change line 295 to `.. _certifi: https://certifipy.readthedocs.io/` (or the canonical `https://certifi.io`) to restore the working hyperlink.

**Patch.** `patches/MNT-009.patch`

#### DEBT-005 — tests/compat.py is Python 2 dead code that misleads readers

- **Severity:** 🟡 Medium · **Confidence:** high (0.98) · **Category:** technical-debt · **Effort:** S
- **Affected:** tests/compat
- **Evidence:** `tests/compat.py:1-23`

**Why it matters.** The module imports `StringIO` (always fails on Python 3 and silently falls through to `io`) and `cStringIO` (always `None` on Python 3). Any reader of tests that import from this module has to mentally trace the always-taken fallback path. `cStringIO` being `None` is used as a sentinel for a skip condition, which is a fragile contract.

**Reasoning.** At tests/compat.py:3-6, `import StringIO` always raises `ImportError` on Python 3 and falls through to `import io as StringIO`. At lines 8-11, `from cStringIO import StringIO as cStringIO` always raises `ImportError`, leaving `cStringIO = None`. The `u()` function at lines 14-23 is explicitly deprecated and emits a `DeprecationWarning` on every call — it exists only to help callers discover they should stop using it, yet it adds noise to the warning log of every test run that inadvertently invokes it.

**Remediation.** Delete tests/compat.py. Replace `from .compat import StringIO` usages with `import io` directly. Replace `cStringIO` skip guard in test_utils.py with an explicit `pytest.mark.skip` or just remove the cStringIO test case entirely. Remove the `u()` alias.

#### SEC-001 — Private keys committed to version control

- **Severity:** 🟡 Medium · **Confidence:** high (0.98) · **Category:** security · **Effort:** M
- **Affected:** tests/certs
- **Evidence:** `tests/certs/expired/ca/ca-private.key:1-29`, `tests/certs/expired/server/server.key:1-29`, `tests/certs/mtls/client/client.key:1-29`, `tests/certs/valid/server/server.key:1-29`

**Why it matters.** Committing private keys — even for self-signed test fixtures — triggers every secret-scanning tool (GitHub Advanced Security, truffleHog, gitleaks) producing noise and false-positive fatigue that degrades scanner signal. It also normalises the pattern of checking in key material, raising the risk that developers follow the same pattern with real keys. These keys are reachable forever via git history even if later deleted.

**Reasoning.** Four PKCS#8 private keys (BEGIN PRIVATE KEY blocks) are tracked in git. While the certificates are self-signed and localhost-scoped, secret scanners cannot distinguish test keys from production keys by content alone. The Makefiles already document how to regenerate all material from scratch, so there is no reproducibility argument for committing the keys.

**Remediation.** Add '*.key' and 'ca-private.key' to .gitignore under tests/certs. Remove the keys from git history using 'git filter-repo' or BFG. CI should run 'make all' in each cert directory before the test suite runs, generating ephemeral keys at test time. Add a .gitignore allowlist for .pem, .crt, .csr, .cnf, and Makefile only.

#### DEBT-004 — override_environ deletes env keys that may not exist, raising KeyError

- **Severity:** 🟡 Medium · **Confidence:** high (0.97) · **Category:** technical-debt · **Effort:** S
- **Affected:** tests/utils
- **Evidence:** `tests/utils.py:9-10`

**Why it matters.** Any test that passes a key with value None to override_environ where that key is not currently set in os.environ will raise an unhandled KeyError before yield, silently breaking the test instead of reporting a meaningful failure. This is a latent bug in shared test infrastructure used across the suite.

**Reasoning.** At tests/utils.py:9-10, the loop performs `del os.environ[key]` for `None`-valued kwargs without checking whether the key exists first. If the key is absent, `del` raises `KeyError`. The correct idiom is `os.environ.pop(key, None)`, which is a no-op when the key is missing.

**Remediation.** Replace `del os.environ[key]` on line 10 with `os.environ.pop(key, None)`.

**Patch.** `patches/DEBT-004.patch`

#### DEBT-007 — Removed Sphinx option html_use_smartypants causes build warnings and is a no-op

- **Severity:** 🟡 Medium · **Confidence:** high (0.97) · **Category:** technical-debt · **Effort:** S
- **Affected:** docs
- **Evidence:** `docs/conf.py:171`

**Why it matters.** The `html_use_smartypants` option was deprecated in Sphinx 1.6 and removed in Sphinx 2.0. With Sphinx 7.2.6 pinned in requirements.txt, this setting produces a Sphinx warning on every build and has no effect. Over time, stale config options like this mask real warnings.

**Reasoning.** Sphinx 2.0 release notes explicitly removed `html_use_smartypants`. Since the pinned version is 7.2.6 (docs/requirements.txt:3), this line is dead configuration that produces a deprecation/unknown-config warning every time `sphinx-build` runs. Such persistent warnings are noise that desensitizes developers to real build warnings.

**Remediation.** Remove line 171 (`html_use_smartypants = False`). Smart quotes are controlled in modern Sphinx via the `smartquotes` configuration key if needed.

#### DUP-001 — Redirect status-code tests are copy-pasted six times instead of parameterized

- **Severity:** 🟡 Medium · **Confidence:** high (0.96) · **Category:** duplication · **Effort:** S
- **Affected:** tests/test_requests
- **Evidence:** `tests/test_requests.py:277-318`

**Why it matters.** Six structurally identical test methods cover the 301/302/303 × POST/HEAD matrix. Each new HTTP method or redirect code requires adding another copy. The duplication means a bug in the assertion logic (e.g. wrong status code in the assert) would survive in all but one variant.

**Reasoning.** test_http_301_changes_post_to_get (277-282), test_http_302_changes_post_to_get (292-297), test_http_303_changes_post_to_get (306-311) are identical except for the status code. test_http_301_doesnt_change_head_to_get (284-290), test_http_302_doesnt_change_head_to_get (299-304), test_http_303_doesnt_change_head_to_get (313-318) are identical except for the status code. All six share the same assertion structure.

**Remediation.** Collapse into two `@pytest.mark.parametrize`-decorated tests: one for `(status_code, method='POST', expected_method='GET')` and one for `(status_code, method='HEAD', expected_method='HEAD')`, parameterized over 301, 302, 303.

#### SEC-004 — verify=False MitM-attack guidance given in plain prose, not a .. warning:: admonition

- **Severity:** 🟡 Medium · **Confidence:** high (0.95) · **Category:** security · **Effort:** S
- **Affected:** docs/user
- **Evidence:** `docs/user/advanced.rst:246-250`

**Why it matters.** RST `.. warning::` admonitions render as visually distinct alert boxes in Sphinx HTML and are indexed separately for accessibility tools. The private-key warning at advanced.rst:274 and the binary-mode warnings at advanced.rst:359 and advanced.rst:414 all use `.. warning::`. The MitM vector—arguably the highest-severity security risk documented—uses only a plain 'Note that…' paragraph, making it easy to miss when skimming.

**Reasoning.** Lines 246-250 explain that `verify=False` makes the application vulnerable to man-in-the-middle attacks and that doing so will ignore expired certificates and hostname mismatches. This is critical security guidance, yet it appears as a plain paragraph rather than the `.. warning::` admonition format used consistently for other hazards in the same file.

**Remediation.** Replace lines 246-250 with a `.. warning::` admonition block mirroring the style at line 274. Optionally add a cross-reference to the 'SSL Cert Verification' section from the Quickstart to surface the risk earlier.

#### MNT-003 — PreparedRequest.copy() aliases hooks dict by reference

- **Severity:** 🟡 Medium · **Confidence:** high (0.93) · **Category:** maintainability · **Effort:** S
- **Affected:** src/requests/models.py, PreparedRequest
- **Evidence:** `src/requests/models.py:456-465`

**Why it matters.** Shallow-copying a PreparedRequest and then registering a hook on the copy mutates the original's hooks list, because both objects share the same list references inside the dict. Session retry/redirect logic that copies prepared requests before sending is silently vulnerable to hook cross-contamination.

**Reasoning.** Line 463 assigns `p.hooks = self.hooks`. `default_hooks()` returns a dict of lists; assigning the dict directly means both the original and the copy point to the same list objects for each event. `register_hook` (line 266) appends to those lists in-place, so a hook added to the copy is visible on the original.

**Remediation.** Deep-copy the hooks structure: `p.hooks = {event: list(handlers) for event, handlers in self.hooks.items()}`.

#### MNT-010 — Streaming example uses unsafe dict key access for content-length header

- **Severity:** 🟡 Medium · **Confidence:** high (0.93) · **Category:** maintainability · **Effort:** S
- **Affected:** docs/user
- **Evidence:** `docs/user/advanced.rst:314-315`

**Why it matters.** HTTP/1.1 servers using chunked transfer encoding do not send a `Content-Length` header; HTTP/2 servers likewise omit it. The example teaches `int(r.headers['content-length'])`, which raises `KeyError` in both cases. Users copying this pattern ship code that crashes on a wide class of real-world responses, including streaming APIs and CDN-served content.

**Reasoning.** Line 314: `if int(r.headers['content-length']) < TOO_LONG:`. `CaseInsensitiveDict.__getitem__` raises `KeyError` for absent headers. The surrounding context (body-content-workflow section, line 309 sets `stream=True`) targets exactly the HTTP responses most likely to lack Content-Length.

**Remediation.** Replace with `content_length = r.headers.get('content-length'); if content_length is None or int(content_length) < TOO_LONG:` and add a note that not all servers emit this header.

#### PERF-001 — _encode_files reads entire file body into memory before encoding

- **Severity:** 🟡 Medium · **Confidence:** high (0.91) · **Category:** scalability-performance · **Effort:** L
- **Affected:** src/requests/models.py, RequestEncodingMixin
- **Evidence:** `src/requests/models.py:236-243`

**Why it matters.** For large file uploads the entire file content is buffered in a Python bytes object before being passed to urllib3's multipart encoder. A 2 GB upload allocates at least 2 GB of heap. This is an OOM risk in memory-constrained environments and prevents any streaming pipeline.

**Reasoning.** Line 239 calls `fdata = fp.read()` unconditionally for any file-like object that supports `read`. urllib3's `encode_multipart_formdata` at line 249 accepts file-like objects directly in `RequestField.data`, so buffering is unnecessary for the common case.

**Remediation.** Pass the file-like object directly to `RequestField` without calling `.read()`. Reserve `.read()` only for `(str, bytes, bytearray)` values where it is already handled on line 236-237.

#### CPLX-001 — LookupDict stores values in __dict__ rather than the dict base class, breaking the dict contract

- **Severity:** 🟡 Medium · **Confidence:** high (0.90) · **Category:** complexity · **Effort:** M
- **Affected:** src/requests/structures.py, LookupDict
- **Evidence:** `src/requests/structures.py:96-131`

**Why it matters.** LookupDict inherits from dict but routes all reads through `self.__dict__` instead of the underlying dict store. Values set via `d['key'] = value` (dict.__setitem__) are invisible to both `__getitem__` and `get`. This means standard dict operations silently produce wrong results: `'key' in d` returns False even after `d['key'] = value` if the value was set via attribute syntax. Any code that treats a LookupDict as a dict will silently get None on lookup.

**Reasoning.** Lines 118-121: `__getitem__` returns `self.__dict__.get(key, None)`. Lines 129-130: `get` also reads from `self.__dict__`. Yet `LookupDict` inherits `dict.__setitem__` unoverridden, so `d['key'] = value` writes to the dict store not `__dict__`. The `__getattr__` at line 108 reads from `self.__dict__`, which is only populated via direct attribute assignment. These two storage paths are inconsistent and invisible to `__contains__` (which uses the dict store).

**Remediation.** Either override `__setitem__` to store in `self.__dict__` (making the class a pure attribute-bag and dropping the `dict` base), or rewrite `__getitem__` and `get` to delegate to `dict.__getitem__`/`dict.get` and remove the `__dict__` indirection. The former matches the actual usage pattern in status_codes.py where values are set via attribute assignment.

#### MNT-005 — server_sock attribute may be unset when _close_server_sock_ignore_errors is called on exception

- **Severity:** 🟡 Medium · **Confidence:** high (0.90) · **Category:** maintainability · **Effort:** S
- **Affected:** Server
- **Evidence:** `tests/testserver/server.py:67-80`, `tests/testserver/server.py:88-92`

**Why it matters.** If `_create_socket_and_bind` raises before assigning `self.server_sock`, the `finally` block on line 79 calls `_close_server_sock_ignore_errors`, which references `self.server_sock` (line 90) and raises `AttributeError` — masking the original exception and producing a confusing traceback in CI.

**Reasoning.** `self.server_sock` is assigned inside `run()` at line 69 with no prior initialisation in `__init__`. The `finally` block unconditionally calls `_close_server_sock_ignore_errors` (line 79). If binding fails (port in use, permission denied, etc.) `self.server_sock` does not exist, so line 90 raises `AttributeError`. The `except OSError` on line 91 does not catch `AttributeError`, so the error propagates, replacing the more informative original exception.

**Remediation.** Initialise `self.server_sock = None` in `__init__`, and guard the close: `if self.server_sock is not None: self.server_sock.close()`.

#### ARCH-002 — TLSServer wraps socket with SSL before bind, preventing SO_REUSEADDR and causing bind failures

- **Severity:** 🟡 Medium · **Confidence:** high (0.88) · **Category:** architecture · **Effort:** M
- **Affected:** TLSServer
- **Evidence:** `tests/testserver/server.py:171-176`

**Why it matters.** Wrapping with `ssl_context.wrap_socket` before `bind` is non-standard. The idiomatic pattern is bind → listen → accept → wrap each accepted socket server-side. Wrapping the listening socket itself works with Python's ssl module but prevents setting socket options (e.g. `SO_REUSEADDR`) on the raw socket first, which causes 'Address already in use' flakiness when tests run in rapid succession.

**Reasoning.** Lines 172-175: the plain socket is immediately wrapped with SSL (`wrap_socket(sock, server_side=True)`) before `bind` and `listen`. `SO_REUSEADDR` is never set on the underlying socket. The base `Server._create_socket_and_bind` (line 83) also omits `SO_REUSEADDR`, but TLSServer overrides the method and inherits the same omission compounded by the early wrap. This is a known source of `[Errno 98] Address already in use` in test suites that exercise the server repeatedly.

**Remediation.** Set `sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)` on the raw socket before wrapping. Optionally restructure to wrap only accepted client sockets (using `ssl_context.wrap_socket(conn, server_side=True)` inside `_handle_requests`) which is the canonical pattern.

#### MNT-004 — simplejson preference over stdlib json creates non-deterministic serialisation behaviour

- **Severity:** 🟡 Medium · **Confidence:** high (0.88) · **Category:** maintainability · **Effort:** M
- **Affected:** src/requests/compat.py
- **Evidence:** `src/requests/compat.py:67-78`

**Why it matters.** If simplejson is installed in the environment, all JSON encoding and decoding silently switches to it. simplejson and stdlib json differ in Decimal handling, float precision, and error message text. Behaviour of `response.json()` and `json=` body encoding becomes environment-dependent, making bugs hard to reproduce and regression tests unreliable.

**Reasoning.** Lines 68-73 try to import simplejson first and fall back to stdlib json. The `has_simplejson` flag then drives the `JSONDecodeError` import on lines 75-78. Every consumer of `complexjson` (imported as `from .compat import json as complexjson` in models.py) gets a different implementation depending on what third-party packages happen to be installed.

**Remediation.** Remove the simplejson preference. Use `import json` unconditionally. If callers need simplejson they can configure it explicitly. This also simplifies `JSONDecodeError` to a single import path.

#### MNT-021 — Feature freeze policy buried in contributor guide rather than prominently surfaced

- **Severity:** 🟡 Medium · **Confidence:** high (0.80) · **Category:** maintainability · **Effort:** S
- **Affected:** docs/dev
- **Evidence:** `docs/dev/contributing.rst:155-166`

**Why it matters.** The feature freeze is the single most important signal for prospective contributors, yet it is the last section (lines 155-165). Contributors may invest significant time writing a feature before discovering it will be rejected, creating frustration and wasted effort for both parties.

**Reasoning.** Lines 155-157 state 'Requests is in a perpetual feature freeze, only the BDFL can add or approve of new features.' This is architectural policy that governs whether any code contribution is worth starting, but it appears after all other guidance. A contributor reading only the 'Code Contributions' section (lines 62-117) has no indication of this constraint.

**Remediation.** Move the feature freeze notice to a clearly labelled callout (e.g., an RST `.. warning::` or `.. note::` block) near the top of the document, before the 'Code Contributions' section, so contributors encounter it before investing time in a feature PR.

#### SEC-005 — urllib3 dependency allows urllib3 1.x which lacks critical security fixes

- **Severity:** 🟡 Medium · **Confidence:** high (0.75) · **Category:** security · **Effort:** S
- **Affected:** (root)
- **Evidence:** `pyproject.toml:21`, `HISTORY.md:56-58`

**Why it matters.** The lower bound `urllib3>=1.26,<3` permits urllib3 1.x which has known CVEs and lacks modern TLS improvements. HISTORY.md line 58 explicitly notes 'the full fix requires urllib3 2.7.0+' for a path-stripping bug, meaning users on urllib3 1.x are silently running with an incomplete bugfix.

**Reasoning.** pyproject.toml line 21 sets `urllib3>=1.26,<3`. HISTORY.md lines 56-58 document that the duplicate-leading-slash URI fix 'requires urllib3 2.7.0+', meaning the stated bugfix is silently partial for any user pinned to urllib3 1.x. Given urllib3 2.0 shipped in 2023 and Python 3.10+ is now required (pyproject.toml line 17), there is no technical reason to continue supporting urllib3 1.x.

**Remediation.** Raise the lower bound to `urllib3>=2.0,<3` in pyproject.toml. This aligns with the Python 3.10+ requirement, ensures the duplicate-slash fix is complete, and removes a class of legacy compatibility burden.

#### TEST-002 — Test strategy: monolithic 3k-line test module coupled to a live httpbin network service

- **Severity:** 🟡 Medium · **Confidence:** medium (0.72) · **Category:** testing · **Effort:** M
- **Affected:** tests
- **Evidence:** `tests/test_requests.py:62-67`, `tests/test_requests.py:214-249`

**Why it matters.** A single 3,095-line test file is hard to navigate, parallelize, and triage on failure. More importantly, core behavior (redirects, status handling, body replay) is exercised against the external `httpbin` fixture and real network endpoints, which makes the suite slow and flaky in CI/offline environments and conflates 'our serialization logic is correct' with 'the network and httpbin are up'.

**Reasoning.** `test_requests.py` is one module of 3,095 lines. The redirect/transport tests (e.g. lines 214-249) drive the `httpbin` fixture, and the file even hardcodes a TARPIT/INVALID_PROXY network target (lines 62-67) to provoke real connection timeouts. Network-coupled assertions belong in a clearly separated, opt-in integration tier so the deterministic unit layer (preparation, encoding, cookie/header logic) can run fast and hermetically.

**Remediation.** Split the monolith by concern (preparation, sessions, redirects, auth, transport) and separate hermetic unit tests from network-dependent integration tests via a pytest marker (e.g. `@pytest.mark.integration`/`network`), defaulting CI's fast lane to the mocked/hermetic subset and gating httpbin-backed tests behind an explicit marker.

### 🔵 Low (27)

#### MNT-001 — Recursive Makefiles use bare `make` instead of `$(MAKE)`

- **Severity:** 🔵 Low · **Confidence:** high (0.99) · **Category:** maintainability · **Effort:** S
- **Affected:** tests/certs
- **Evidence:** `tests/certs/expired/Makefile:4-13`, `tests/certs/mtls/Makefile:4-7`

**Why it matters.** Using bare 'make' in recursive invocations ignores the Make binary that initiated the build, breaking flags like -n (dry-run), -k (keep-going), and -j (parallelism). It also bypasses jobserver token passing, causing spurious sub-process spawning under parallel builds and occasional 'warning: jobserver unavailable' noise in CI.

**Reasoning.** expired/Makefile lines 4, 7, 12, 13 and mtls/Makefile lines 4, 7 invoke 'make -C ...' directly. The GNU Make manual explicitly mandates $(MAKE) for all recursive invocations so that flags are inherited and the jobserver protocol is preserved.

**Remediation.** Replace all occurrences of 'make -C' with '$(MAKE) -C' in tests/certs/expired/Makefile and tests/certs/mtls/Makefile.

#### MNT-008 — Debug print statement left in test body

- **Severity:** 🔵 Low · **Confidence:** high (0.99) · **Category:** maintainability · **Effort:** S
- **Affected:** tests/test_requests
- **Evidence:** `tests/test_requests.py:286`

**Why it matters.** A bare `print(r.content)` in a passing test produces output on every test run (unless pytest -s is suppressed), pollutes CI logs, and signals unfinished cleanup. It provides no assertion value.

**Reasoning.** At tests/test_requests.py:286, inside `test_http_301_doesnt_change_head_to_get`, `print(r.content)` is called with the response content but the value is never asserted on. It is debugging scaffolding that was not removed.

**Remediation.** Delete line 286. If the content is relevant to the test, add an assertion on `r.content` instead.

#### MNT-011 — Hardcoded stale example output embeds 2012 timestamps and version 1.2.0 user-agent

- **Severity:** 🔵 Low · **Confidence:** high (0.99) · **Category:** maintainability · **Effort:** S
- **Affected:** docs/user
- **Evidence:** `docs/user/advanced.rst:102-110`, `docs/user/advanced.rst:115-117`, `docs/user/quickstart.rst:393-396`

**Why it matters.** Example output showing `'last-modified': 'Wed, 13 Jun 2012 01:33:50 GMT'` and `'User-Agent': 'python-requests/1.2.0'` is visibly inconsistent with any response a reader will actually observe today. This erodes reader trust in the entire documentation and generates spurious bug reports ('my output doesn't match the docs'). The traceback at quickstart.rst:394 hardcodes `models.py, line 832`, which will diverge silently as the library evolves.

**Reasoning.** advanced.rst:106 `'last-modified': 'Wed, 13 Jun 2012 01:33:50 GMT'`, advanced.rst:117 `'User-Agent': 'python-requests/1.2.0'`, quickstart.rst:394 `File "requests/models.py", line 832`. All three are literal snapshots from real requests made over a decade ago; none can match live responses.

**Remediation.** Replace literal output blocks with abbreviated ellipsis forms (e.g., `{'content-type': 'text/html; charset=UTF-8', ...}`) and remove the exact line number from the traceback example, using `...` in its place to signal abbreviated output.

#### DEBT-003 — Dead Python 2 compatibility shims pollute the compat module's public surface

- **Severity:** 🔵 Low · **Confidence:** high (0.98) · **Category:** technical-debt · **Effort:** M
- **Affected:** src/requests/compat.py
- **Evidence:** `src/requests/compat.py:58-65`, `src/requests/compat.py:110-115`

**Why it matters.** Exports like `is_py2`, `is_py3`, `builtin_str`, `str = str`, `bytes = bytes`, `basestring`, `numeric_types`, and `integer_types` are artefacts of Python 2/3 dual support. They remain live exports that callers can import, but they carry no semantic value on Python 3-only codebases and silently shadow the builtins `str` and `bytes` within the `compat` module's namespace.

**Reasoning.** Lines 61 and 64 compute `is_py2` and `is_py3` which are always False and True respectively. Lines 110-115 assign `builtin_str = str`, `str = str`, `bytes = bytes`, `basestring = (str, bytes)`, `numeric_types = (int, float)`, `integer_types = (int,)`. The `str = str` and `bytes = bytes` assignments on lines 111-112 shadow the module-level builtins for any code that does `from requests.compat import str`, which is actively misleading.

**Remediation.** Delete lines 58-64 and 110-115 entirely. Audit downstream callers (primarily within models.py via `from .compat import basestring`) and replace with direct Python 3 idioms (`isinstance(x, (str, bytes))`).

#### DUP-002 — Identical binary-mode file warning duplicated verbatim three times

- **Severity:** 🔵 Low · **Confidence:** high (0.98) · **Category:** duplication · **Effort:** S
- **Affected:** docs/user
- **Evidence:** `docs/user/quickstart.rst:362-367`, `docs/user/advanced.rst:359-363`, `docs/user/advanced.rst:414-418`

**Why it matters.** The same `.. warning::` block about opening files in binary mode is copy-pasted at three separate locations. Any future correction (e.g., referencing a different Python docs anchor) must be applied in all three places, and any divergence creates inconsistent guidance. RST supports `.. include::` and substitution directives specifically to avoid this.

**Reasoning.** All three blocks begin 'It is strongly recommended that you open files in :ref:`binary mode <tut-files>`.' and carry identical body text. The quickstart and advanced docs are separate files, but the advanced doc alone repeats the block twice (streaming uploads and multipart).

**Remediation.** Extract the warning block to a shared RST snippet (e.g., `docs/_shared/binary-mode-warning.rst`) and `.. include::` it at all three sites, or define a substitution in `docs/conf.py`.

#### MNT-014 — Unfilled sphinx-quickstart boilerplate in texinfo_documents description

- **Severity:** 🔵 Low · **Confidence:** high (0.98) · **Category:** maintainability · **Effort:** S
- **Affected:** docs
- **Evidence:** `docs/conf.py:295`

**Why it matters.** The `texinfo_documents` tuple at conf.py:295 contains `"One line description of project."` — verbatim placeholder text from `sphinx-quickstart`. This is published into any Texinfo/Info output, making generated documentation look unprofessional and incomplete.

**Reasoning.** conf.py:295 has the literal string `"One line description of project."` as the description field in `texinfo_documents`. This was never replaced after the project was scaffolded from `sphinx-quickstart`. It appears in the Texinfo output's directory entry.

**Remediation.** Replace with a real description, e.g., `"Requests: HTTP for Humans. A simple HTTP library for Python."`

#### DEBT-001 — CSR intermediate build artifacts tracked in git

- **Severity:** 🔵 Low · **Confidence:** high (0.97) · **Category:** technical-debt · **Effort:** S
- **Affected:** tests/certs
- **Evidence:** `tests/certs/expired/server/server.csr:1-20`, `tests/certs/mtls/client/client.csr:1-25`, `tests/certs/valid/server/server.csr:1-20`

**Why it matters.** CSRs are one-shot intermediate artifacts consumed during signing and never used again. Committing them inflates repository size, adds churn on regeneration, and creates confusion about which files are source vs. derived. The Makefile clean targets explicitly delete them, confirming they are not intended as source artifacts.

**Reasoning.** The Makefile clean rules in expired/server/Makefile:16, mtls/client/Makefile:16, and valid/server/Makefile:16 all include 'rm -f *.csr', explicitly classifying CSRs as derived files. They are committed anyway, causing git status noise whenever certs are regenerated.

**Remediation.** Remove the .csr files from git tracking ('git rm --cached tests/certs/**/*.csr') and add '*.csr' to .gitignore under tests/certs.

#### MNT-015 — Recursive make target uses bare `make` instead of `$(MAKE)`

- **Severity:** 🔵 Low · **Confidence:** high (0.95) · **Category:** maintainability · **Effort:** S
- **Affected:** docs
- **Evidence:** `docs/Makefile:172`

**Why it matters.** The `info` target in docs/Makefile:172 uses bare `make` for recursive invocation instead of `$(MAKE)`. This breaks make flag propagation (e.g., `-j`, `-n`, `--dry-run`) and can invoke the wrong `make` binary if the build environment uses a non-default version (common in embedded or cross-compile toolchains).

**Reasoning.** GNU Make convention requires `$(MAKE)` for recursive invocations so that flags like `-n` (dry-run) or `-j` (parallel) propagate to sub-makes. The `latexpdf` and `latexpdfja` targets correctly use `$(MAKE) -C` (lines 138, 145), but the `info` target at line 172 uses bare `make -C`, which is inconsistent and subtly broken for dry-run scenarios.

**Remediation.** Change line 172 from `make -C $(BUILDDIR)/texinfo info` to `$(MAKE) -C $(BUILDDIR)/texinfo info`.

#### MOD-001 — Deprecated string-form pytest.mark.skipif used without reason argument

- **Severity:** 🔵 Low · **Confidence:** high (0.95) · **Category:** modernization · **Effort:** S
- **Affected:** tests/test_utils
- **Evidence:** `tests/test_utils.py:56-58`

**Why it matters.** pytest deprecated string-based condition evaluation in skipif in version 3.0 and will eventually remove it. Omitting the mandatory `reason` argument also suppresses clear diagnostics when the test is skipped, making CI output harder to read.

**Reasoning.** At tests/test_utils.py:57, `marks=pytest.mark.skipif("cStringIO is None")` uses the legacy string-evaluation form of skipif without a `reason` keyword. Modern pytest requires `skipif(condition, reason=...)` where `condition` is a boolean expression, not a string.

**Remediation.** Change to `marks=pytest.mark.skipif(cStringIO is None, reason="cStringIO not available on Python 3")`. Since cStringIO is always None on Python 3, the entire parameterized case can simply be removed.

#### MNT-007 — try/except/else used instead of pytest.raises context manager

- **Severity:** 🔵 Low · **Confidence:** high (0.93) · **Category:** maintainability · **Effort:** S
- **Affected:** tests/test_requests
- **Evidence:** `tests/test_requests.py:251-275`

**Why it matters.** The verbose try/except/else pattern obscures intent compared to `pytest.raises`. Any new contributor has to read the entire block to understand the expected behaviour, whereas `with pytest.raises(...)` is immediately self-documenting. It also prevents pytest from generating a clean 'expected exception' failure message.

**Reasoning.** test_HTTP_302_TOO_MANY_REDIRECTS (lines 251-260) and test_HTTP_302_TOO_MANY_REDIRECTS_WITH_PARAMS (lines 262-275) both use `try: ... except XError as e: assert ...; else: pytest.fail(...)` where `with pytest.raises(XError) as exc_info:` followed by assertions on `exc_info.value` is the idiomatic and recommended pytest pattern.

**Remediation.** Replace both try/except/else blocks with `with pytest.raises(TooManyRedirects) as exc_info:` then assert on `exc_info.value.request.url`, `exc_info.value.response.url`, and `len(exc_info.value.response.history)`.

#### DEBT-008 — language = None deprecated in Sphinx 5.0+, should be explicit string

- **Severity:** 🔵 Low · **Confidence:** high (0.92) · **Category:** technical-debt · **Effort:** S
- **Affected:** docs
- **Evidence:** `docs/conf.py:78`

**Why it matters.** Since Sphinx 5.0, setting `language = None` generates a deprecation warning. With Sphinx 7.2.6, this is now flagged on every build. While the behavior defaults to English, the warning adds noise to CI output and will become an error in a future Sphinx major version.

**Reasoning.** conf.py:78 sets `language = None`. Sphinx 5.0 changelog states: 'language: The default value is changed from None to "en".' and warns when `None` is used. The pinned Sphinx 7.2.6 enforces this deprecation warning on every build.

**Remediation.** Change line 78 to `language = "en"`.

#### DEBT-002 — CA serial file committed creates serial-reuse risk on regeneration

- **Severity:** 🔵 Low · **Confidence:** high (0.90) · **Category:** technical-debt · **Effort:** S
- **Affected:** tests/certs
- **Evidence:** `tests/certs/expired/ca/ca.srl:1-2`

**Why it matters.** The OpenSSL CA serial file is read and incremented atomically during signing. If a developer runs 'make clean && make all', the Makefile deletes the .srl file and OpenSSL recreates it from 0x01 — but the committed file in git would be restored on the next checkout with a stale serial. A developer working from a fresh checkout and then regenerating certs without cleaning git state can produce certificates with duplicate serial numbers under the same CA, which RFC 5280 §4.1.2.2 forbids and which some TLS stacks reject.

**Reasoning.** ca.srl contains a single serial value that is updated in-place by openssl x509 -CAcreateserial. It is a runtime state file analogous to a lock file, not a source artifact. Tracking it in git creates a serial-state split between what git thinks the counter is and what the filesystem may show after regeneration.

**Remediation.** Remove ca.srl from git ('git rm --cached tests/certs/expired/ca/ca.srl') and add '*.srl' to .gitignore under tests/certs. The Makefile already uses -CAcreateserial so OpenSSL will bootstrap the file on first run.

#### DEBT-009 — Migration guide contains Python 2-only import that contradicts the project's Python 3.10+ requirement

- **Severity:** 🔵 Low · **Confidence:** high (0.88) · **Category:** technical-debt · **Effort:** S
- **Affected:** docs
- **Evidence:** `docs/api.rst:177-181`

**Why it matters.** The code example in api.rst:177-180 includes `from httplib import HTTPConnection` inside an `except ImportError` branch as a Python 2 fallback. The project states Python 3.10+ support (index.rst:79), making this dead code in the documentation that misleads readers and suggests Python 2 compatibility that no longer exists.

**Reasoning.** api.rst:177-181 shows a try/except import pattern for `http.client` vs. `httplib` to support Python 2 and 3. Since Requests requires Python 3.10+ (index.rst:79) and the `httplib` module doesn't exist in Python 3, the `except ImportError` branch at lines 179-180 is dead code in the example. It teaches users a compatibility pattern that is unnecessary and potentially confusing.

**Remediation.** Simplify the code example to remove the Python 2 fallback; replace lines 177-181 with `from http.client import HTTPConnection` directly.

#### MNT-002 — `expired/ca/` hosts a long-lived CA shared by valid and mTLS scenarios, creating misleading naming

- **Severity:** 🔵 Low · **Confidence:** high (0.88) · **Category:** maintainability · **Effort:** M
- **Affected:** tests/certs
- **Evidence:** `tests/certs/valid/ca:1`, `tests/certs/mtls/client/ca:1`, `tests/certs/expired/ca/ca.crt:5`

**Why it matters.** The CA in tests/certs/expired/ca/ is valid until 2045 (ca.crt line 5: notAfter=20450324). It is shared by three test scenarios via symlinks (valid/ca → ../expired/ca, mtls/client/ca → ../../expired/ca/). Naming a long-lived shared trust root under an 'expired' directory misleads contributors into thinking the CA itself is expired, increases the risk of someone deleting or regenerating it in isolation (breaking the other scenarios), and makes the dependency graph non-obvious.

**Reasoning.** The 'expired' label in the path refers to the server leaf certificate, not the CA. But because the CA lives under tests/certs/expired/ca/ and two other subtrees symlink into it, a reader of tests/certs/valid/ or tests/certs/mtls/ must follow symlinks to understand their trust chain. Extracting the CA to tests/certs/ca/ would make the sharing explicit and correctly name the artifact.

**Remediation.** Move tests/certs/expired/ca/ to tests/certs/ca/ (a shared root CA directory). Update the symlinks in valid/ and mtls/client/ to point to ../../ca/. Update the expired/server/Makefile reference from '../ca/ca.crt' to '../../ca/ca.crt'. Update README.md files to reflect the structure.

#### DUP-003 — Four near-identical hash-wrapper closures duplicated in build_digest_header

- **Severity:** 🔵 Low · **Confidence:** high (0.85) · **Category:** duplication · **Effort:** S
- **Affected:** src/requests
- **Evidence:** `src/requests/auth.py:174-205`

**Why it matters.** The MD5/SHA/SHA-256/SHA-512 wrappers differ only by the `hashlib` constructor; the encode-if-str + `usedforsecurity=False` boilerplate is copied four times. Adding a new algorithm (or fixing the encoding handling) means editing four places, which is exactly how digest-auth algorithm bugs creep in.

**Reasoning.** Lines 176-205 define `md5_utf8`, `sha_utf8`, `sha256_utf8`, `sha512_utf8` as separate closures whose bodies are byte-for-byte identical apart from `hashlib.md5/sha1/sha256/sha512`. This is textbook duplicated business logic that should collapse into a single factory parameterised by the digest constructor.

**Remediation.** Map `_algorithm` to a `hashlib` constructor via a dict and build one closure: `ctor = {'MD5': hashlib.md5, 'SHA': hashlib.sha1, 'SHA-256': hashlib.sha256, 'SHA-512': hashlib.sha512}.get(_algorithm)`, then a single `hash_utf8 = lambda x: ctor(x.encode('utf-8') if isinstance(x, str) else x, usedforsecurity=False).hexdigest()`.

#### PERF-002 — O(n) string concatenation accumulates received bytes inside a hot loop

- **Severity:** 🔵 Low · **Confidence:** high (0.85) · **Category:** scalability-performance · **Effort:** S
- **Affected:** consume_socket_content
- **Evidence:** `tests/testserver/server.py:9-20`

**Why it matters.** Each `content += new_content` on line 20 copies the entire accumulated buffer. For large or slow responses this is O(n²) in total bytes received. In a test server the payloads are typically small, but the pattern is a latent footgun if the server is ever reused for larger fixture data.

**Reasoning.** `content` is a `bytes` object initialised to `b""` at line 9. Line 20 performs `content += new_content` inside a `while True` loop. CPython does not specialise `bytes +=` the same way it does `list.append`, so each iteration allocates a new bytes object and copies all prior content.

**Remediation.** Collect chunks in a list and join once: `chunks_list = []; ... chunks_list.append(new_content); return b"".join(chunks_list)`.

#### MNT-016 — alabaster theme dependency missing from docs/requirements.txt

- **Severity:** 🔵 Low · **Confidence:** high (0.82) · **Category:** maintainability · **Effort:** S
- **Affected:** docs
- **Evidence:** `docs/conf.py:122`, `docs/requirements.txt:1-4`

**Why it matters.** conf.py:122 sets `html_theme = "alabaster"` but `docs/requirements.txt` only pins Sphinx. Alabaster was bundled with Sphinx until 7.x but is now a separate package. On certain Sphinx versions or environments, building docs without explicitly installing `alabaster` will fail with a theme-not-found error.

**Reasoning.** Alabaster became a separately versioned package (no longer auto-bundled as of Sphinx 7.x). The docs/requirements.txt pins only `Sphinx==7.2.6` with no alabaster entry. While it may currently be installed as a transitive dependency, relying on transitive dependency resolution for a first-class theme is fragile and version-pinning unfriendly.

**Remediation.** Add `alabaster` (with an appropriate version pin) to `docs/requirements.txt`.

#### MNT-006 — __exit__ does not cancel stop_event wait when exception occurs, blocking callers

- **Severity:** 🔵 Low · **Confidence:** high (0.80) · **Category:** maintainability · **Effort:** S
- **Affected:** Server
- **Evidence:** `tests/testserver/server.py:123-135`

**Why it matters.** When an exception is raised inside a `with Server(...)` block, `__exit__` skips the `stop_event.wait` (line 125) but still calls `join()` (line 134). If the server thread is blocked in `_accept_connection`'s select (up to `WAIT_EVENT_TIMEOUT = 5 s`), the join hangs for the full timeout, slowing down test failure reporting.

**Reasoning.** Lines 123-134: on the exception path (`exc_type is not None`), `_close_server_sock_ignore_errors` is called (line 133) which should unblock `select` inside `_accept_connection`, but only if the thread has already entered `select`. If the thread hasn't yet accepted a connection and the socket close races, `join()` may still block up to `WAIT_EVENT_TIMEOUT`. Explicitly setting `stop_event` before `join` would signal any future waits and make the shutdown deterministic.

**Remediation.** Before `self.join()` on line 134, call `self.stop_event.set()` so the server thread can exit any wait loops promptly regardless of timing.

#### MNT-023 — Runtime guard `is_prepared` is a no-op, so `assert _is_prepared(...)` validates nothing at runtime

- **Severity:** 🔵 Low · **Confidence:** high (0.80) · **Category:** maintainability · **Effort:** S
- **Affected:** src/requests
- **Evidence:** `src/requests/_types.py:47-52`, `src/requests/cookies.py:45-49`

**Why it matters.** The codebase reads as though it verifies a request is fully prepared (URL+method present) before use, but the check only exists for the type checker. At runtime an unprepared request flows straight through, surfacing later as a confusing `None`-related failure deep inside cookie/header handling instead of at the assertion site.

**Reasoning.** `is_prepared` returns the real predicate only under `TYPE_CHECKING` and `return True` at runtime (lines 49-52). `MockRequest.__init__` then does `assert _is_prepared(request)` (cookies.py:46) — which is always true and is additionally elided under `-O`. The static `TypeIs` narrowing is valuable, but pairing it with an `assert` creates a false impression of defensive validation that doesn't exist.

**Remediation.** Either make the runtime path actually validate (`return request.url is not None and request.method is not None`) so the assert has teeth, or drop the `assert` and rely solely on static narrowing plus a comment that no runtime check is performed — don't keep a guard that reads as runtime validation but isn't.

#### DEBT-010 — pytest pinned to >=3 with no upper bound while pytest-httpbin is pinned to an exact version, mixing pinning strategies

- **Severity:** 🔵 Low · **Confidence:** high (0.78) · **Category:** technical-debt · **Effort:** S
- **Affected:** (root)
- **Evidence:** `pyproject.toml:61-66`

**Why it matters.** Exact-pinning pytest-httpbin==2.1.0 (line 61) alongside a loose `pytest>=3` (line 66) means CI can silently pick up new pytest majors that may break the test suite while the test server fixture remains frozen. This asymmetry is a latent source of unexpected CI failures.

**Reasoning.** Lines 61-66 show mixed pinning: exact for pytest-httpbin and httpbin, but open-ended for pytest itself. A future pytest major breaking change would not be caught until CI runs, and the exact pin on the httpbin packages implies these are fragile—suggesting the suite is sensitive to test-infrastructure versions in general.

**Remediation.** Either adopt consistent loose pinning (`pytest>=6,<9`, `pytest-httpbin>=2.1`) or use a lockfile (pip-tools/uv) to pin all test dependencies deterministically. The current hybrid gives the worst of both worlds.

#### SEC-006 — Dependency compatibility checks rely on bare `assert`, silently disabled under `python -O`

- **Severity:** 🔵 Low · **Confidence:** high (0.78) · **Category:** security · **Effort:** S
- **Affected:** src/requests
- **Evidence:** `src/requests/__init__.py:60-96`

**Why it matters.** Assertions are stripped when the interpreter runs with `-O`/`PYTHONOPTIMIZE`. The entire version-compatibility gate (including the explicit 'verify urllib3 isn't installed from git' check) becomes a no-op in optimized deployments, so an incompatible/unsupported transport stack loads with no warning at all.

**Reasoning.** `check_compatibility` enforces every constraint via `assert` (lines 66, 76, 78, 85, 90) and the caller only catches `AssertionError`/`ValueError` to convert it into a warning. Under `-O` the asserts never execute, so neither the warning nor the validation fires. Using `assert` for runtime control-flow validation in a widely-deployed library is an anti-pattern precisely because optimized runtimes are common in containers/serverless.

**Remediation.** Replace the assertions with explicit conditionals that raise/warn unconditionally (e.g. `if urllib3_version_list == ['dev']: warnings.warn(...)`), independent of optimization level. Keep the single outer try/except for the int-parsing path only.

#### MNT-022 — `authors.rst` uses a fragile relative include path to `AUTHORS.rst`

- **Severity:** 🔵 Low · **Confidence:** high (0.75) · **Category:** maintainability · **Effort:** S
- **Affected:** docs/dev
- **Evidence:** `docs/dev/authors.rst:4`

**Why it matters.** The `.. include:: ../../AUTHORS.rst` directive (line 4) is a depth-relative path. If the docs directory structure changes by even one level, the include silently produces an empty page rather than a build error, which is hard to catch without a full Sphinx build in CI.

**Reasoning.** RST `.. include::` resolves paths relative to the source file. Two levels of `../` from `docs/dev/` lands at the repo root, which is correct now, but this is invisible to a reader and breaks silently on restructure. Sphinx provides `.. include:: /AUTHORS.rst` (rooted at the `confdir`) which is more robust.

**Remediation.** Change line 4 to `.. include:: /AUTHORS.rst` to use Sphinx's source-root-relative include, which is immune to directory depth changes and self-documents the intent.

#### MNT-017 — chardet optional extra accepts versions up to <8 while charset_normalizer is capped at <4, creating asymmetric version bounds

- **Severity:** 🔵 Low · **Confidence:** medium (0.72) · **Category:** maintainability · **Effort:** S
- **Affected:** (root)
- **Evidence:** `pyproject.toml:19`, `pyproject.toml:56`

**Why it matters.** Inconsistent upper-bound policies across the two encoding libraries make it hard to reason about which decoder versions are tested and supported, and increase the risk of silent behavioral differences between deployments using chardet vs charset_normalizer.

**Reasoning.** Line 19 pins `charset_normalizer>=2,<4`; line 56 pins `chardet>=3.0.2,<8`. The wide upper bound on chardet (<8) compared to charset_normalizer (<4) suggests these were not updated in tandem and likely reflect different points in time when each was last touched. The typecheck dependency group (lines 69-75) includes chardet for type-checking but not charset_normalizer, further indicating uneven treatment.

**Remediation.** Audit the chardet upper bound against current chardet release history and align the policy (e.g., both capped at next major). Add charset_normalizer to the typecheck dependency group to ensure both codepaths are covered during type analysis.

#### MNT-020 — Stale maintainer contact info references personal sites that may drift

- **Severity:** 🔵 Low · **Confidence:** medium (0.72) · **Category:** maintainability · **Effort:** S
- **Affected:** docs/dev
- **Evidence:** `docs/dev/contributing.rst:14-19`

**Why it matters.** Contributors directed to reach maintainers via personal URLs (lines 17-19) or by email will hit dead links or wrong contacts if maintainers change — common in long-lived OSS projects. No central canonical contact point (e.g., GitHub Discussions, mailing list) is offered as a fallback.

**Reasoning.** Lines 14-15 name three specific individuals and lines 17-19 hardcode their personal domain URLs. Personal sites are outside the project's control and can silently go stale. If any maintainer steps down or changes their URL, the contributor guide becomes misleading with no automated way to detect the breakage.

**Remediation.** Replace or supplement personal URLs with a stable project-owned contact channel (e.g., GitHub Discussions link or the psf/requests issue tracker). Add a Sphinx `linkcheck` CI step to catch dead external links automatically.

#### ARCH-003 — Heavy global side effects executed at package import time

- **Severity:** 🔵 Low · **Confidence:** medium (0.70) · **Category:** architecture · **Effort:** M
- **Affected:** src/requests
- **Evidence:** `src/requests/__init__.py:111-152`, `src/requests/__init__.py:216-219`

**Why it matters.** Simply `import requests` mutates process-global state: it runs dependency-version probing, conditionally monkey-patches urllib3 via `pyopenssl.inject_into_urllib3()`, and rewrites the global `warnings` filter registry. This makes import non-idempotent in spirit, can surprise hosts that manage their own warning/SSL configuration, and complicates reasoning about import order in larger applications.

**Reasoning.** At top level the package calls `check_compatibility(...)` (111-124), injects pyopenssl into urllib3 (135-145), and calls `warnings.simplefilter(...)` twice (152, 219) — globally altering warning behavior for the entire interpreter. Mutating global SSL transport and warning filters as an import side effect is an architectural smell: library import should ideally be inert, deferring such configuration to explicit initialization.

**Remediation.** Keep symbol binding at import but move global mutations (warning-filter changes, SNI/pyopenssl injection) into a lazy/explicit init path or guard them so they don't override caller-configured `warnings` state; at minimum document the side effects prominently and make the pyopenssl injection opt-out.

#### DEBT-011 — No CI link-check step referenced for external URLs in contributor docs

- **Severity:** 🔵 Low · **Confidence:** medium (0.65) · **Category:** technical-debt · **Effort:** S
- **Affected:** docs/dev
- **Evidence:** `docs/dev/contributing.rst:35`, `docs/dev/contributing.rst:106-107`

**Why it matters.** The contributing guide contains multiple external URLs (PSF Code of Conduct, pre-commit, Sphinx, reStructuredText, GitHub issues — lines 35, 106-107, 135-136, 149). Without automated linkcheck, these can rot silently and mislead contributors.

**Reasoning.** The guide references at least six distinct external domains. Sphinx ships with a `linkcheck` builder that validates all hyperlinks; nothing in this file or the described CI process (lines 99-101) references it. Link rot in contributor-facing docs is a common but avoidable maintenance burden.

**Remediation.** Add `sphinx-build -b linkcheck docs/ docs/_build/linkcheck` as a CI job step. Annotate any intentionally non-resolvable links with `linkcheck_ignore` in `conf.py` rather than skipping the check entirely.

#### MNT-019 — pyproject.toml classifiers include Python 3.14 and 3.15 (pre-release) without conditional markers

- **Severity:** 🔵 Low · **Confidence:** medium (0.65) · **Category:** maintainability · **Effort:** S
- **Affected:** (root)
- **Evidence:** `pyproject.toml:39-40`, `HISTORY.md:47-48`

**Why it matters.** Classifiers for Python 3.14 and 3.15 (lines 39-40) are based on beta testing (HISTORY.md lines 47-48). PyPI classifiers are informational only, but advertising support for unreleased Python versions before the `requires-python` constraint is updated can mislead downstream users and packaging tools about actual compatibility guarantees.

**Reasoning.** HISTORY.md lines 47-48 note 3.14 and 3.15 support was added 'based on beta1'. The classifiers (pyproject.toml lines 39-40) reflect this, but `requires-python = ">=3.10"` (line 17) does not cap at a known-stable version. If a 3.14/3.15 final release introduces a breaking change, users will get runtime failures with no packaging-level signal. The 'Free Threading :: 2 - Beta' classifier (line 44) further signals experimental territory.

**Remediation.** Track pre-release Python support in release notes and CI matrices rather than PyPI classifiers until the Python version reaches GA. Remove or mark classifiers as provisional, and document the beta-support policy explicitly.

### ⚪ Info (2)

#### MNT-018 — HISTORY.md 'dev' placeholder section never removed before release

- **Severity:** ⚪ Info · **Confidence:** high (0.90) · **Category:** maintainability · **Effort:** S
- **Affected:** (root)
- **Evidence:** `HISTORY.md:4-8`

**Why it matters.** The unreleased 'dev' section at lines 4-8 with a placeholder bullet is present in the shipped artifact. While cosmetic, it indicates the release process does not enforce removal of the dev stub, and automated changelog tooling may misparse the version history.

**Reasoning.** Lines 4-8 contain a 'dev' heading and a literal `[Short description of non-trivial change.]` placeholder. This is a process gap: the release checklist does not appear to strip or populate this section before tagging. Tools that parse HISTORY.md programmatically (e.g., changelog generators) will encounter an invalid version entry.

**Remediation.** Add a release checklist step (or pre-commit/CI check) that verifies the 'dev' section is empty or absent before a version tag is created. Alternatively, use a tool like `towncrier` to manage changelog fragments automatically.

#### MOD-002 — Python 2 / 3 compatibility shims remain in compat.py as dead modernization debt

- **Severity:** ⚪ Info · **Confidence:** high (0.82) · **Category:** modernization · **Effort:** M
- **Affected:** src/requests
- **Evidence:** `src/requests/compat.py:57-64`, `src/requests/compat.py:110-115`

**Why it matters.** On a Python 3-only codebase, `is_py2`, `str = str`, `bytes = bytes`, `basestring`, `numeric_types`, and `integer_types` are constants/identities that exist only to support a runtime that is no longer supported. They add surface area, mislead readers about supported runtimes, and the `basestring`/`isinstance(..., basestring)` pattern propagates the legacy idiom into models.py and auth.py.

**Reasoning.** Lines 60-64 compute `is_py2`/`is_py3` against `sys.version_info`, and 110-115 alias built-ins to themselves. The module docstring (lines 5-7) explicitly states these are retained 'until the next major version' — i.e. acknowledged debt. Downstream code still branches on `basestring`, which is just `(str, bytes)`, so the cruft actively shapes call-site idioms.

**Remediation.** Track removal behind the documented 3.0 boundary: replace `isinstance(x, basestring)` with `isinstance(x, (str, bytes))` at call sites, delete the self-aliases and `is_py2`/`is_py3`, and keep only the genuinely cross-version re-exports (urllib3 detection, json/simplejson, urllib.parse) in compat.py.

## Proposed Improvements

- `patches/SEC-002.patch` — SEC-002 — 🟡 proposed (unverified)
- `patches/MNT-012.patch` — MNT-012 — 🟡 proposed (unverified)
- `patches/SEC-003.patch` — SEC-003 — 🟡 proposed (unverified)
- `patches/MNT-009.patch` — MNT-009 — 🟡 proposed (unverified)
- `patches/DEBT-004.patch` — DEBT-004 — 🟡 proposed (unverified)

## Appendix

### Coverage
- Files analyzed: 124 (37 parsed precisely) · 19583 LOC · 106 dependency edges · 16 components
- Skipped during ingest: 5 binary, 1 too-large, 0 ignored
- Languages: python (37)

### Analysis
- Passes: 8 deep-dives + cross-cutting
- Findings: 53 raw → 53 grounded (0 dropped by the evidence gate)
- LLM: 16 calls · 63877 tokens · ~$2.5566 · 1 model substitutions

---
_Every finding above cites evidence that resolves to real source lines; ungrounded findings were dropped automatically._
