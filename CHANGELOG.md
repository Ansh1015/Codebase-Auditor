# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Resilience.** Transient provider failures (HTTP 429/408/409/5xx and
  network-level errors) now retry with exponential backoff + full jitter,
  honouring `Retry-After`, on both the `api` and `subscription` backends. A
  single blip no longer aborts a whole audit.
- **Cost guardrails.** Default budget caps (`maxCalls: 60`, `maxCostUsd: 10`),
  new `--max-cost` / `--max-calls` flags, a pre-run budget preview, and a
  friendly (non-crashing) message when a cap is reached.
- **Exit-code contract.** `0` success · `1` unexpected error · `2` bad target ·
  `3` no provider available · `4` budget cap reached.
- **Degenerate-repo handling.** Empty, binary-only, or fully-ignored repos now
  short-circuit cleanly to "nothing to audit" — without requiring a provider or
  credentials — instead of erroring.
- CI (GitHub Actions, Node 20 & 22), `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`,
  a "how to add a language" guide, and issue/PR templates.

### Fixed
- **Dependency resolver.** NodeNext/ESM-style imports (`import x from './y.js'`
  where the file on disk is `y.ts`) are now resolved to their TypeScript sibling.
  Previously such repos produced an empty dependency graph and degraded
  importance ranking. Found by validating against real repositories.

## [0.1.0]

Initial release: holistic, evidence-grounded codebase audit with verified
machine-generated patches, over an `api` or `subscription` provider.
