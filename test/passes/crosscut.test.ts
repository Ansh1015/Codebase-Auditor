import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ingestRepo } from "../../src/ingest/ingest.js";
import { BudgetTracker } from "../../src/llm/budget.js";
import { MockProvider } from "../../src/llm/mock.js";
import { buildRepoMap } from "../../src/mapping/build.js";
import { createParser } from "../../src/mapping/parse.js";
import { runAudit } from "../../src/passes/run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PY_FIXTURE = path.resolve(here, "../fixtures/py-sample");

/** Triage + an empty deep-dive + a grounded cross-cutting finding from synthesis. */
const responder = (req: { tier: string }) => {
  if (req.tier === "triage") {
    return JSON.stringify({ architectureOverview: "small service", priorityComponents: [] });
  }
  if (req.tier === "synthesis") {
    return JSON.stringify({
      findings: [
        {
          title: "Duplicated order-total logic across modules",
          category: "duplication",
          severity: "medium",
          confidenceScore: 0.8,
          impactRationale: "The same calculation is maintained in two places.",
          effort: "M",
          affectedFiles: [{ path: "src/app/services.py", startLine: 6, endLine: 6 }],
          affectedComponents: ["src/app"],
          reasoning: "Cross-file duplication only visible at the system level.",
          remediation: "Extract a shared helper.",
        },
      ],
    });
  }
  // deep-dive: no findings, so the only output comes from the cross-cut pass
  return JSON.stringify({ findings: [] });
};

describe("runAudit cross-cutting pass", () => {
  it("runs the synthesis pass and grounds its findings into the result", async () => {
    const ingest = await ingestRepo(PY_FIXTURE);
    const map = await buildRepoMap(ingest, createParser());
    const provider = new MockProvider(responder, new BudgetTracker());

    const result = await runAudit(provider, ingest, map, {
      maxComponents: 1,
      maxCharsPerComponent: 48_000,
      maxLinesPerFile: 500,
      concurrency: 1,
      crossCut: true,
    });

    expect(result.passStats.crossCut).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.category).toBe("duplication");
    expect(result.findings[0]?.evidence[0]?.path).toBe("src/app/services.py");

    // A synthesis-tier call must actually have been issued.
    const tiers = provider.requests.map((r) => r.tier);
    expect(tiers).toContain("synthesis");
  });
});
