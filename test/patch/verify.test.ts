import { describe, expect, it } from "vitest";
import { componentId, findingId, repoRelPath } from "../../src/domain/brand.js";
import type { Finding } from "../../src/domain/finding.js";
import { createParser } from "../../src/mapping/parse.js";
import { selectPatchable } from "../../src/patch/select.js";
import { decideStatus } from "../../src/patch/verify.js";

const mkFinding = (over: Partial<Finding> = {}): Finding => ({
  id: findingId("SEC-001"),
  title: "secret",
  category: "security",
  severity: "critical",
  confidence: { level: "high", score: 0.95 },
  impact: { rationale: "x", effort: "S" },
  affectedComponents: [componentId("src/app")],
  evidence: [{ path: repoRelPath("src/app/services.py"), startLine: 6, endLine: 6 }],
  reasoning: "x",
  remediation: "x",
  ...over,
});

describe("selectPatchable", () => {
  it("selects single-file, small, high-confidence, non-architectural findings", () => {
    const ok = mkFinding();
    const multiFile = mkFinding({
      id: findingId("DUP-001"),
      category: "duplication",
      evidence: [
        { path: repoRelPath("a.py"), startLine: 1, endLine: 1 },
        { path: repoRelPath("b.py"), startLine: 1, endLine: 1 },
      ],
    });
    const bigRefactor = mkFinding({
      id: findingId("ARCH-001"),
      category: "architecture",
      impact: { rationale: "x", effort: "L" },
    });
    const lowConf = mkFinding({
      id: findingId("MNT-001"),
      confidence: { level: "low", score: 0.3 },
    });

    const picked = selectPatchable([ok, multiFile, bigRefactor, lowConf], { maxPatches: 10 });
    expect(picked.map((p) => p.finding.id)).toEqual(["SEC-001"]);
  });

  it("respects maxPatches and orders by severity", () => {
    const crit = mkFinding({ id: findingId("SEC-001"), severity: "critical" });
    const med = mkFinding({
      id: findingId("MNT-001"),
      category: "maintainability",
      severity: "medium",
    });
    const picked = selectPatchable([med, crit], { maxPatches: 1 });
    expect(picked.map((p) => p.finding.id)).toEqual(["SEC-001"]);
  });
});

describe("decideStatus (pure trust policy)", () => {
  it("rejects on syntax error", () => {
    expect(decideStatus("error")).toMatchObject({ kind: "rejected" });
  });
  it("verifies when a verify command passes", () => {
    expect(decideStatus("ok", { ran: true, passed: true })).toMatchObject({ kind: "verified" });
  });
  it("rejects when a verify command fails", () => {
    expect(decideStatus("ok", { ran: true, passed: false })).toMatchObject({ kind: "rejected" });
  });
  it("is honest (proposed-unverified) when only syntax could be checked", () => {
    expect(decideStatus("ok")).toMatchObject({ kind: "proposed-unverified" });
    expect(decideStatus("unknown")).toMatchObject({ kind: "proposed-unverified" });
  });
});

describe("syntax check via tree-sitter", () => {
  it("accepts valid python and rejects broken python", async () => {
    const parser = createParser();
    expect(await parser.checkSyntax("def f(x):\n    return x + 1\n", "python")).toBe("ok");
    expect(await parser.checkSyntax("def f(:\n    return\n", "python")).toBe("error");
  });

  it("returns 'unknown' for languages without a grammar", async () => {
    const parser = createParser();
    expect(await parser.checkSyntax("SELECT 1;", "unknown")).toBe("unknown");
  });
});
