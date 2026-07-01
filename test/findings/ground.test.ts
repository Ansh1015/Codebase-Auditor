import { describe, expect, it } from "vitest";
import { groundFindings, parseFindingsResponse } from "../../src/findings/ground.js";
import type { RepoIndex } from "../../src/findings/ground.js";
import type { RawFinding } from "../../src/findings/schema.js";

// A tiny repo index: services.py has 40 lines, utils.py has 14.
const index: RepoIndex = {
  has: (p) => p === "src/app/services.py" || p === "src/app/utils.py",
  lineCount: (p) => (p === "src/app/services.py" ? 40 : p === "src/app/utils.py" ? 14 : undefined),
  role: (p) => (p === "src/app/services.py" || p === "src/app/utils.py" ? "source" : undefined),
};

const raw = (over: Partial<RawFinding> = {}): RawFinding => ({
  title: "Hardcoded API key",
  category: "security",
  severity: "critical",
  confidenceScore: 0.9,
  impactRationale: "Leaks a live credential.",
  effort: "S",
  affectedFiles: [{ path: "src/app/services.py", startLine: 9, endLine: 9 }],
  affectedComponents: ["src/app"],
  reasoning: "A live secret is committed to source.",
  remediation: "Move it to an env var.",
  ...over,
});

describe("groundFindings — evidence gate", () => {
  it("keeps findings whose evidence resolves, and assigns category-prefixed ids", () => {
    const out = groundFindings([raw()], index);
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("SEC-001");
    expect(out[0]?.evidence[0]?.path).toBe("src/app/services.py");
    expect(out[0]?.confidence.score).toBe(0.9);
  });

  it("DROPS a finding when none of its evidence resolves (anti-hallucination)", () => {
    const ghost = raw({
      title: "Phantom bug",
      affectedFiles: [{ path: "src/app/does-not-exist.py", startLine: 1, endLine: 2 }],
    });
    expect(groundFindings([ghost], index)).toHaveLength(0);
  });

  it("DROPS a finding when the cited line is beyond the file length", () => {
    const overshoot = raw({
      affectedFiles: [{ path: "src/app/utils.py", startLine: 999, endLine: 1000 }],
    });
    expect(groundFindings([overshoot], index)).toHaveLength(0);
  });

  it("down-confidences when SOME evidence is dropped but at least one resolves", () => {
    const mixed = raw({
      confidenceScore: 0.9,
      affectedFiles: [
        { path: "src/app/services.py", startLine: 9, endLine: 9 }, // ok
        { path: "src/app/ghost.py", startLine: 1, endLine: 1 }, // dropped
      ],
    });
    const out = groundFindings([mixed], index);
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence).toHaveLength(1);
    expect(out[0]?.confidence.score).toBeLessThan(0.9);
  });

  it("caps confidence + attaches a caveat for an unverifiable doc-as-code claim", () => {
    const docIndex: RepoIndex = {
      has: (p) => p === "docs/guide.md",
      lineCount: (p) => (p === "docs/guide.md" ? 100 : undefined),
      role: (p) => (p === "docs/guide.md" ? "docs" : undefined),
    };
    const docFinding = raw({
      category: "maintainability",
      confidenceScore: 1,
      title: "Example uses ellipsis which is invalid JavaScript syntax",
      reasoning: "The snippet won't compile.",
      affectedFiles: [{ path: "docs/guide.md", startLine: 5, endLine: 5 }],
    });
    const out = groundFindings([docFinding], docIndex);
    expect(out).toHaveLength(1);
    expect(out[0]?.caveat).toBeTruthy();
    expect(out[0]?.confidence.score).toBeLessThanOrEqual(0.4);
    // Capped below "high" → patch-ineligible by selectPatchable's gate.
    expect(out[0]?.confidence.level).not.toBe("high");
  });

  it("leaves a normal source finding un-caveated and at full confidence", () => {
    const out = groundFindings([raw()], index);
    expect(out[0]?.caveat).toBeUndefined();
    expect(out[0]?.confidence.score).toBe(0.9);
  });

  it("numbers ids per-category independently", () => {
    const out = groundFindings(
      [raw(), raw({ title: "second sec" }), raw({ category: "duplication", title: "dup" })],
      index,
    );
    const ids = out.map((f) => f.id);
    expect(ids).toContain("SEC-001");
    expect(ids).toContain("SEC-002");
    expect(ids).toContain("DUP-001");
  });
});

describe("parseFindingsResponse", () => {
  it("extracts a fenced JSON array and validates it", () => {
    const text = [
      "Here are my findings:",
      "```json",
      JSON.stringify({ findings: [raw()] }),
      "```",
    ].join("\n");
    const parsed = parseFindingsResponse(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.category).toBe("security");
  });

  it("skips malformed findings without throwing", () => {
    const text = JSON.stringify({
      findings: [raw(), { title: "missing required fields" }],
    });
    const parsed = parseFindingsResponse(text);
    expect(parsed).toHaveLength(1);
  });

  it("returns [] when no JSON object is present", () => {
    expect(parseFindingsResponse("no json here, sorry")).toEqual([]);
  });
});
