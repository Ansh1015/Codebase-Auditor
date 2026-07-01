import { describe, expect, it } from "vitest";
import type { AbsPath } from "../../src/domain/brand.js";
import { componentId, findingId, repoRelPath } from "../../src/domain/brand.js";
import type { Finding } from "../../src/domain/finding.js";
import type { IngestedFile } from "../../src/ingest/ingest.js";
import { MockProvider } from "../../src/llm/mock.js";
import { createParser } from "../../src/mapping/parse.js";
import { generatePatches } from "../../src/patch/run.js";
import type { PatchCandidate } from "../../src/patch/select.js";

function file(p: string, content: string): IngestedFile {
  return {
    path: repoRelPath(p),
    absPath: `/abs/${p}` as AbsPath,
    role: "source",
    language: "python",
    bytes: content.length,
    lineCount: content.split("\n").length,
    content,
  };
}

function candidate(id: string, p: string): PatchCandidate {
  const finding: Finding = {
    id: findingId(id),
    title: "fix me",
    category: "security",
    severity: "high",
    confidence: { level: "high", score: 0.9 },
    impact: { rationale: "x", effort: "S" },
    affectedComponents: [componentId("src")],
    evidence: [{ path: repoRelPath(p), startLine: 1, endLine: 1 }],
    reasoning: "x",
    remediation: "x",
  };
  return { finding, path: repoRelPath(p) };
}

describe("generatePatches — resilience (patch-gen hang/failure hardening)", () => {
  it("skips a candidate whose LLM call throws, and still produces the others", async () => {
    const files = [
      file("bad.py", "def g():\n    return 1\n"),
      file("good.py", "def f(x):\n    return x\n"),
    ];
    const candidates = [candidate("SEC-001", "bad.py"), candidate("SEC-002", "good.py")];

    // The provider throws for the first candidate (simulating a stuck/erroring CLI
    // call after its timeout+retries) and returns a valid patch for the second.
    const provider = new MockProvider((req) => {
      if (req.user.includes("SEC-001")) throw new Error("simulated CLI hang/timeout");
      return JSON.stringify({ action: "patch", newContent: "def f(x):\n    return x + 1\n" });
    });

    const patches = await generatePatches(provider, createParser(), files, candidates, {
      maxPatches: 10,
      repoRoot: ".",
    });

    // No throw propagated; the failing candidate is skipped, the good one survives.
    expect(patches.map((p) => String(p.findingId))).toEqual(["SEC-002"]);
  });

  it("returns [] (never throws) when every candidate fails", async () => {
    const files = [file("a.py", "def a():\n    return 1\n")];
    const candidates = [candidate("SEC-001", "a.py")];
    const provider = new MockProvider(() => {
      throw new Error("everything is down");
    });

    const patches = await generatePatches(provider, createParser(), files, candidates, {
      maxPatches: 10,
      repoRoot: ".",
    });

    expect(patches).toEqual([]);
  });
});
