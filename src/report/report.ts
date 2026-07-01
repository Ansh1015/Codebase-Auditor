/**
 * Report assembly + rendering. findings.json is the source of truth; the
 * Markdown report and the run manifest are both derived from the same
 * AuditReport object so they can never disagree.
 */

import type { Finding, ProposedPatch } from "../domain/finding.js";
import { SEVERITIES, SEVERITY_RANK, type Severity } from "../domain/taxonomy.js";
import type { IngestStats } from "../ingest/ingest.js";
import type { BudgetSummary } from "../llm/budget.js";
import type { RepoMapStats } from "../mapping/repomap.js";
import type { PassStats } from "../passes/run.js";

export interface AuditReport {
  readonly target: string;
  readonly generatedAt: string;
  readonly providerDescription: string;
  readonly commit?: string;
  readonly architectureOverview: string;
  readonly findings: readonly Finding[];
  readonly patches: readonly ProposedPatch[];
  readonly repoStats: RepoMapStats;
  readonly ingestStats: IngestStats;
  readonly passStats: PassStats;
  readonly budget: BudgetSummary;
}

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "🔴 Critical",
  high: "🟠 High",
  medium: "🟡 Medium",
  low: "🔵 Low",
  info: "⚪ Info",
};

function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/**
 * A 0–100 headline health score. Each finding contributes a severity-weighted,
 * confidence-scaled penalty; the total is mapped through a saturating hyperbola
 * (`100·H/(penalty+H)`) rather than subtracted linearly. The old `100 − penalty`
 * form clamped flat at 0 after ~8 high findings, so a flagship-quality repo and a
 * genuinely broken one both read "0/100" — destroying the score's signal. The
 * curve keeps dynamic range: 0 penalty → 100, `penalty = H` → 50, and it only
 * approaches (never reaches) the floor, so even a heavily-flagged repo gets a
 * meaningful number. `H` is the penalty that maps to 50/100 (tunable).
 */
const HEALTH_HALF_PENALTY = 150;

export function healthScore(findings: readonly Finding[]): number {
  const weight: Record<Severity, number> = { critical: 25, high: 12, medium: 5, low: 2, info: 0 };
  const penalty = findings.reduce((s, f) => s + weight[f.severity] * f.confidence.score, 0);
  const score = (100 * HEALTH_HALF_PENALTY) / (penalty + HEALTH_HALF_PENALTY);
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** The machine-readable source of truth. */
export function findingsJson(report: AuditReport): string {
  return `${JSON.stringify(
    {
      target: report.target,
      generatedAt: report.generatedAt,
      commit: report.commit,
      healthScore: healthScore(report.findings),
      counts: countBySeverity(report.findings),
      findings: report.findings,
      patches: report.patches,
    },
    null,
    2,
  )}\n`;
}

/** Compact run record for run-manifest.json. */
export function runManifest(report: AuditReport): string {
  return `${JSON.stringify(
    {
      target: report.target,
      generatedAt: report.generatedAt,
      commit: report.commit,
      provider: report.providerDescription,
      repo: report.repoStats,
      ingest: report.ingestStats,
      passes: report.passStats,
      budget: report.budget,
      findingCount: report.findings.length,
      patchCount: report.patches.length,
    },
    null,
    2,
  )}\n`;
}

function renderFinding(f: Finding): string {
  const evidence = f.evidence
    .map((e) => `\`${e.path}:${e.startLine}${e.endLine > e.startLine ? `-${e.endLine}` : ""}\``)
    .join(", ");
  const components = f.affectedComponents.length > 0 ? f.affectedComponents.join(", ") : "—";
  const lines = [
    `#### ${f.id} — ${f.title}`,
    ``,
    `- **Severity:** ${SEVERITY_LABEL[f.severity]} · **Confidence:** ${f.confidence.level} (${f.confidence.score.toFixed(2)}) · **Category:** ${f.category} · **Effort:** ${f.impact.effort}`,
    `- **Affected:** ${components}`,
    `- **Evidence:** ${evidence || "—"}`,
    ``,
    `**Why it matters.** ${f.impact.rationale}`,
    ``,
    `**Reasoning.** ${f.reasoning}`,
    ``,
    `**Remediation.** ${f.remediation}`,
  ];
  if (f.caveat) lines.push(``, `> ⚠️ **Caveat (confidence capped).** ${f.caveat}`);
  if (f.patchRef) lines.push(``, `**Patch.** \`patches/${f.patchRef}\``);
  return lines.join("\n");
}

export function renderMarkdown(report: AuditReport): string {
  const counts = countBySeverity(report.findings);
  const score = healthScore(report.findings);
  const out: string[] = [];

  out.push(`# Engineering Audit — ${report.target}`);
  out.push("");
  out.push(
    `_Generated ${report.generatedAt}${report.commit ? ` · commit \`${report.commit.slice(0, 10)}\`` : ""} · via ${report.providerDescription}_`,
  );
  out.push("");

  // Executive summary
  out.push(`## Executive Summary`);
  out.push("");
  out.push(`**Health score: ${score}/100**`);
  out.push("");
  out.push(`| ${SEVERITIES.map((s) => SEVERITY_LABEL[s].split(" ")[1]).join(" | ")} | Total |`);
  out.push(`|${"---|".repeat(SEVERITIES.length + 1)}`);
  out.push(`| ${SEVERITIES.map((s) => counts[s]).join(" | ")} | ${report.findings.length} |`);
  out.push("");
  const top = [...report.findings]
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    .slice(0, 5);
  if (top.length > 0) {
    out.push(`**Top risks:**`);
    for (const f of top) {
      out.push(`- ${SEVERITY_LABEL[f.severity]} — **${f.id}** ${f.title}`);
    }
    out.push("");
  }

  // Architecture overview
  if (report.architectureOverview.trim().length > 0) {
    out.push(`## Architecture Overview`);
    out.push("");
    out.push(report.architectureOverview.trim());
    out.push("");
  }

  // Findings by severity
  out.push(`## Findings`);
  out.push("");
  if (report.findings.length === 0) {
    out.push(`_No findings surfaced above the configured threshold._`);
    out.push("");
  } else {
    for (const sev of SEVERITIES) {
      const group = report.findings.filter((f) => f.severity === sev);
      if (group.length === 0) continue;
      out.push(`### ${SEVERITY_LABEL[sev]} (${group.length})`);
      out.push("");
      for (const f of group) {
        out.push(renderFinding(f));
        out.push("");
      }
    }
  }

  // Proposed improvements
  out.push(`## Proposed Improvements`);
  out.push("");
  if (report.patches.length === 0) {
    out.push(`_No machine-generated patches in this run._`);
  } else {
    for (const p of report.patches) {
      const status =
        p.status.kind === "verified"
          ? "✅ verified"
          : p.status.kind === "proposed-unverified"
            ? "🟡 proposed (unverified)"
            : "❌ rejected";
      out.push(`- \`patches/${p.filename}\` — ${p.findingId} — ${status}`);
    }
  }
  out.push("");

  // Appendix
  out.push(`## Appendix`);
  out.push("");
  out.push(`### Coverage`);
  out.push(
    `- Files analyzed: ${report.repoStats.fileCount} (${report.repoStats.preciseFiles} parsed precisely) · ${report.repoStats.totalLoc} LOC · ${report.repoStats.edgeCount} dependency edges · ${report.repoStats.componentCount} components`,
  );
  out.push(
    `- Skipped during ingest: ${report.ingestStats.skippedBinary} binary, ${report.ingestStats.skippedTooLarge} too-large, ${report.ingestStats.skippedIgnored} ignored`,
  );
  const langs = Object.entries(report.repoStats.languageBreakdown)
    .filter(([l]) => l !== "unknown")
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l} (${n})`)
    .join(", ");
  out.push(`- Languages: ${langs || "n/a"}`);
  out.push("");
  out.push(`### Analysis`);
  out.push(
    `- Passes: ${report.passStats.deepDives} deep-dives${report.passStats.crossCut ? " + cross-cutting" : ""}`,
  );
  out.push(
    `- Findings: ${report.passStats.rawFindings} raw → ${report.passStats.groundedFindings} grounded (${report.passStats.droppedUngrounded} dropped by the evidence gate)`,
  );
  out.push(
    `- LLM: ${report.budget.calls} calls · ${report.budget.totalTokens} tokens · ~$${report.budget.costUsd.toFixed(4)}${report.budget.substitutions > 0 ? ` · ${report.budget.substitutions} model substitutions` : ""}`,
  );
  out.push("");
  out.push(`---`);
  out.push(
    `_Every finding above cites evidence that resolves to real source lines; ungrounded findings were dropped automatically._`,
  );
  out.push("");

  return out.join("\n");
}
