# Security

## Reporting a vulnerability

Please report security issues privately by opening a
[GitHub security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, rather than a public issue. We'll acknowledge within a few
days.

## Trust model & known limitations

The auditor reads a target repository's source and sends slices of it to an LLM
provider. Treat these as the operative facts:

- **Repository content is sent to your configured provider.** With `--provider api`
  it goes to the Anthropic API under your `ANTHROPIC_API_KEY`; with `subscription`
  it goes through your local `claude` CLI session. Do not audit a repo you are not
  comfortable transmitting to that provider. Nothing else is sent anywhere.

- **Source is untrusted input to the model.** A repository can contain text in
  comments, docstrings, or filenames crafted to influence the model
  (prompt injection). The deterministic **grounding gate** is the backstop: every
  finding must cite evidence that resolves to a real `file:line`, and ungrounded
  findings are dropped. But a maliciously crafted repo could still steer the
  *wording* of findings. Hardening the passes against adversarial source is
  tracked for a future release.

- **`--apply` writes model-derived patches to your working tree.** Patches are
  conservative (single-file, syntax-checked, optionally sandbox-verified), but
  `--apply` is opt-in for a reason: review the diff in `audit-output/patches/`
  before applying, and run against a clean working tree so changes are easy to
  revert. Patches labelled `rejected` are never applied.

- **No code from the target is executed** unless you pass `--verify-command`,
  which runs your command against a copy to verify a patch. Only pass a command
  you trust for the repo under audit.
