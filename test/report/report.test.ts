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

  describe("healthScore — dynamic range (V-002)", () => {
    const mk = (severity: Finding["severity"], n: number, score = 0.9): Finding[] =>
      Array.from({ length: n }, (_, i) => ({
        ...finding,
        id: findingId(`SEC-${String(i + 1).padStart(3, "0")}`),
        severity,
        confidence: { level: "high", score },
      }));

    it("returns 100 for a clean repo and stays within [0,100]", () => {
      expect(healthScore([])).toBe(100);
      for (const fs of [mk("low", 1), mk("high", 50), mk("critical", 100)]) {
        const s = healthScore(fs);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(100);
      }
    });

    it("does NOT saturate to 0 after a handful of high findings (the V-002 bug)", () => {
      // Old linear formula hit 0 at ~8 highs. The curve must keep dynamic range.
      expect(healthScore(mk("high", 9))).toBeGreaterThan(20);
      // Even a heavily-flagged repo keeps a meaningful, non-zero score.
      expect(healthScore(mk("high", 40))).toBeGreaterThan(0);
    });

    it("is monotonic: more findings never raise the score", () => {
      let prev = healthScore([]);
      for (let n = 1; n <= 20; n++) {
        const s = healthScore(mk("high", n));
        expect(s).toBeLessThanOrEqual(prev);
        prev = s;
      }
    });

    it("makes severity bite: one critical scores below one low", () => {
      expect(healthScore(mk("critical", 1))).toBeLessThan(healthScore(mk("low", 1)));
    });

    it("scales penalty by confidence: a low-confidence finding hurts less", () => {
      expect(healthScore(mk("high", 3, 0.3))).toBeGreaterThan(healthScore(mk("high", 3, 1)));
    });
  });
});
