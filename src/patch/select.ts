/**
 * Choose which findings are safe to auto-patch. Deliberately conservative:
 * single-file, small-effort, high-confidence, non-architectural. Sweeping
 * refactors stay as recommendations — auto-generating a correct multi-file
 * refactor is a trust-destroying gamble.
 */

import type { RepoRelPath } from "../domain/brand.js";
import type { Finding } from "../domain/finding.js";
import { SEVERITY_RANK } from "../domain/taxonomy.js";

export interface PatchCandidate {
  readonly finding: Finding;
  readonly path: RepoRelPath;
}

export interface SelectOptions {
  readonly maxPatches: number;
}

export function selectPatchable(
  findings: readonly Finding[],
  opts: SelectOptions,
): PatchCandidate[] {
  const eligible = findings.filter((f) => {
    const files = new Set(f.evidence.map((e) => e.path));
    return (
      files.size === 1 &&
      f.impact.effort === "S" &&
      f.confidence.level === "high" &&
      f.category !== "architecture"
    );
  });

  return [...eligible]
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        b.confidence.score - a.confidence.score,
    )
    .slice(0, opts.maxPatches)
    .map((finding) => ({ finding, path: finding.evidence[0]?.path as RepoRelPath }));
}
