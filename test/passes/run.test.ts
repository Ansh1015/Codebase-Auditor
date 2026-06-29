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

const responder = (req: { tier: string }) => {
  if (req.tier === "triage") {
    return JSON.stringify({
      architectureOverview: "A small Python order service with duplicated helper logic.",
      priorityComponents: ["src/app"],
    });
  }
  // deep-dive: one grounded finding (real line) + one ungrounded (ghost path)
  return [
    "```json",
    JSON.stringify({
      findings: [
        {
          title: "Hardcoded Stripe secret",
          category: "security",
          severity: "critical",
          confidenceScore: 0.95,
          impactRationale: "A live credential is committed to source control.",
          effort: "S",
          affectedFiles: [{ path: "src/app/services.py", startLine: 6, endLine: 6 }],
          affectedComponents: ["src/app"],
          reasoning: "STRIPE_API_KEY is a live secret in source.",
          remediation: "Load it from an environment variable.",
        },
        {
          title: "Phantom complexity",
          category: "complexity",
          severity: "low",
          confidenceScore: 0.5,
          impactRationale: "n/a",
          effort: "S",
          affectedFiles: [{ path: "src/app/ghost.py", startLine: 1, endLine: 1 }],
          affectedComponents: ["src/app"],
          reasoning: "cites a file that does not exist",
          remediation: "n/a",
        },
      ],
    }),
    "```",
  ].join("\n");
};

describe("runAudit (mock provider, python fixture)", () => {
  it("triages, deep-dives, and drops ungrounded findings end-to-end", async () => {
    const ingest = await ingestRepo(PY_FIXTURE);
    const map = await buildRepoMap(ingest, createParser());
    const provider = new MockProvider(responder, new BudgetTracker());

    const result = await runAudit(provider, ingest, map, {
      maxComponents: 1,
      maxCharsPerComponent: 48_000,
      maxLinesPerFile: 500,
      concurrency: 1,
      crossCut: false,
    });

    expect(result.architectureOverview).toContain("duplicated");
    expect(result.findings).toHaveLength(1);

    const f = result.findings[0];
    expect(f?.id).toBe("SEC-001");
    expect(f?.category).toBe("security");
    expect(f?.evidence[0]?.path).toBe("src/app/services.py");

    expect(result.passStats.deepDives).toBe(1);
    expect(result.passStats.rawFindings).toBe(2);
    expect(result.passStats.groundedFindings).toBe(1);
    expect(result.passStats.droppedUngrounded).toBe(1);
  });
});
