# Triage labels

Canonical roles → label strings (defaults; no remote tracker to reconcile with):

| Role            | Label             | Meaning |
|-----------------|-------------------|---------|
| needs-triage    | `needs-triage`    | maintainer must evaluate |
| needs-info      | `needs-info`      | waiting on reporter |
| ready-for-agent | `ready-for-agent` | fully specified, AFK-ready |
| ready-for-human | `ready-for-human` | needs human implementation |
| wontfix         | `wontfix`         | will not be actioned |

In local-markdown mode, a label is a `Labels: <label>` line in the issue file.
