import { describe, expect, it } from "vitest";
import { componentId, findingId, repoRelPath } from "../../src/domain/brand.js";
import type { Finding } from "../../src/domain/finding.js";
import {
  type AuditReport,
  findingsJson,
  healthScore,
  renderMarkdown,
} from "../../src/report/report.js";

const finding: Finding = {
  id: findingId("SEC-001"),
  title: "Hardcoded Stripe secret",
  category: "security",
  severity: "critical",
  confidence: { level: "high", score: 0.95 },
  impact: { rationale: "A live credential is committed to source.", effort: "S" },
  affectedComponents: [componentId("src/app")],
  evidence: [{ path: repoRelPath("src/app/services.py"), startLine: 6, endLine: 6 }],
  reasoning: "STRIPE_API_KEY is a live secret in source.",
  remediation: "Load it from an environment variable.",
};

const report: AuditReport = {
  target: "py-sample",
  generatedAt: "2026-06-27T00:00:00Z",
  providerDescription: "MockProvider (test)",
  architectureOverview: "A small Python order service.",
  findings: [finding],
  patches: [],
  repoStats: {
    fileCount: 12,
    totalLoc: 200,
    edgeCount: 2,
    componentCount: 4,
    languageBreakdown: { python: 7, unknown: 5 },
    preciseFiles: 7,
  },
  ingestStats: {
    considered: 16,
    ingested: 12,
    skippedBinary: 1,
    skippedTooLarge: 0,
    skippedIgnored: 3,
  },
  passStats: {
    deepDives: 1,
    crossCut: false,
    rawFindings: 2,
    groundedFindings: 1,
    droppedUngrounded: 1,
  },
  budget: {
    calls: 2,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    costUsd: 0.09,
    substitutions: 1,
  },
};

describe("report rendering", () => {
  it("renders the key sections and the finding", () => {
    const md = renderMarkdown(report);
    expect(md).toContain("# Engineering Audit — py-sample");
    expect(md).toContain("## Executive Summary");
    expect(md).toContain("## Architecture Overview");
    expect(md).toContain("SEC-001 — Hardcoded Stripe secret");
    expect(md).toContain("`src/app/services.py:6`");
    expect(md).toContain("dropped by the evidence gate");
  });

  it("emits findings.json as valid JSON with a health score", () => {
    const parsed = JSON.parse(findingsJson(report));
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.healthScore).toBe(healthScore(report.findings));
    expect(parsed.counts.critical).toBe(1);
  });

  it("penalises health score for severe findings", () => {
    expect(healthScore([])).toBe(100);
    expect(healthScore(report.findings)).toBeLessThan(100);
  });
});
