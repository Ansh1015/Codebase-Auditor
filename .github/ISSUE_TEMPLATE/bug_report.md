---
name: Bug report
about: Something the auditor got wrong or crashed on
title: ""
labels: needs-triage
---

**What happened**
A clear description of the bug.

**Target repo**
The repo you audited (a public URL is ideal, since the bug often lives in
ingest/mapping of a specific layout).

**Command**
```
auditor <target> <flags>
```

**Provider**
`api` / `subscription` / `auto`, and Node version (`node -v`).

**Expected vs actual**
What you expected, and what you got (paste the relevant `run-manifest.json` or
error output).

**Was it a hallucinated finding?**
If a finding looks wrong, paste it — the grounding gate is supposed to drop
findings whose evidence doesn't resolve, so this is high-signal.
