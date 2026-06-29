/**
 * End-to-end audit: resolve target → ingest → map → provider → passes →
 * ground/filter → write artifacts. Single place the whole pipeline is wired.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyPatch } from "diff";
import pc from "picocolors";
import { CachingProvider } from "../cache/cache.js";
import type { AuditorConfig } from "../config/config.js";
import type { Finding, ProposedPatch } from "../domain/finding.js";
import { SEVERITY_RANK, type Severity } from "../domain/taxonomy.js";
import { ingestRepo } from "../ingest/ingest.js";
import { type BudgetCaps, BudgetTracker } from "../llm/budget.js";
import { createProvider } from "../llm/provider.js";
import { buildRepoMap } from "../mapping/build.js";
import { createParser } from "../mapping/parse.js";
import { type PassStats, runAudit } from "../passes/run.js";
import { generatePatches } from "../patch/run.js";
import { selectPatchable } from "../patch/select.js";
import {
  type AuditReport,
  findingsJson,
  healthScore,
  renderMarkdown,
  runManifest,
} from "../report/report.js";
import { looksLikeGitUrl, resolveTarget } from "./target.js";

const MAX_PATCHES = 6;

const ZERO_PASS_STATS: PassStats = {
  deepDives: 0,
  crossCut: false,
  rawFindings: 0,
  groundedFindings: 0,
  droppedUngrounded: 0,
};

export interface RunResult {
  readonly outDir: string;
  readonly findingCount: number;
  readonly score: number;
  readonly report: AuditReport;
  /** False when there was no analyzable source, so no LLM pass ran. */
  readonly analyzed: boolean;
}

/** Human-readable summary of the active budget caps, for the pre-run preview. */
function describeBudget(caps: BudgetCaps): string {
  const parts: string[] = [];
  if (caps.maxCalls !== undefined) parts.push(`≤${caps.maxCalls} calls`);
  if (caps.maxCostUsd !== undefined) parts.push(`≤$${caps.maxCostUsd}`);
  if (caps.maxTotalTokens !== undefined) parts.push(`≤${caps.maxTotalTokens} tokens`);
  return parts.length > 0
    ? `${parts.join(", ")} (override with --max-cost / --max-calls)`
    : "uncapped";
}

function filterBySeverity(findings: readonly Finding[], threshold: Severity): Finding[] {
  const min = SEVERITY_RANK[threshold];
  return findings.filter((f) => SEVERITY_RANK[f.severity] >= min);
}

function attachPatchRefs(
  findings: readonly Finding[],
  patches: readonly ProposedPatch[],
): Finding[] {
  const byId = new Map(
    patches
      .filter((p) => p.status.kind !== "rejected")
      .map((p) => [p.findingId as string, p.filename]),
  );
  return findings.map((f) => {
    const filename = byId.get(f.id);
    return filename ? { ...f, patchRef: filename } : f;
  });
}

async function applyPatches(
  repoDir: string,
  target: string,
  findings: readonly Finding[],
  patches: readonly ProposedPatch[],
  log: (msg: string) => void,
): Promise<number> {
  if (looksLikeGitUrl(target)) {
    log(pc.yellow("  --apply skipped: target is a remote clone (nothing to write back to)"));
    return 0;
  }
  const pathById = new Map(findings.map((f) => [f.id as string, f.evidence[0]?.path as string]));
  let count = 0;
  for (const p of patches) {
    if (p.status.kind === "rejected") continue;
    const rel = pathById.get(p.findingId);
    if (!rel) continue;
    const abs = path.join(repoDir, rel);
    const orig = await readFile(abs, "utf8").catch(() => null);
    if (orig === null) continue;
    const patched = applyPatch(orig, p.diff);
    if (patched === false) continue;
    await writeFile(abs, patched, "utf8");
    count++;
  }
  return count;
}

export async function runAuditCli(
  target: string,
  config: AuditorConfig,
  log: (msg: string) => void = (m) => console.error(m),
): Promise<RunResult> {
  const resolved = await resolveTarget(target);
  try {
    log(pc.dim(`• Ingesting ${resolved.name}…`));
    const ingest = await ingestRepo(resolved.dir);
    log(
      pc.dim(`  ${ingest.stats.ingested} files ingested (${ingest.stats.skippedIgnored} ignored)`),
    );

    log(pc.dim("• Mapping structure…"));
    const parser = createParser();
    const map = await buildRepoMap(ingest, parser);
    log(
      pc.dim(
        `  ${map.stats.fileCount} files · ${map.stats.edgeCount} edges · ${map.stats.componentCount} components · ${map.stats.preciseFiles} parsed precisely`,
      ),
    );

    const tracker = new BudgetTracker(config.budget);

    let architectureOverview = "";
    let findings: Finding[] = [];
    let patches: ProposedPatch[] = [];
    let passStats: PassStats = ZERO_PASS_STATS;
    let providerDescription = "n/a (no analyzable source)";
    // No source means no LLM pass — and no provider/credentials required.
    const analyzed = ingest.files.length > 0;

    if (analyzed) {
      const baseProvider = await createProvider({ kind: config.provider, tracker });
      const provider = config.cache
        ? new CachingProvider(baseProvider, path.resolve(".auditor-cache"))
        : baseProvider;
      providerDescription = provider.describe();
      log(pc.dim(`• Auditing via ${providerDescription}…`));
      log(pc.dim(`  Budget: ${describeBudget(config.budget)}`));

      const audit = await runAudit(provider, ingest, map, config.audit);
      architectureOverview = audit.architectureOverview;
      findings = filterBySeverity(audit.findings, config.severityThreshold);
      passStats = audit.passStats;

      // Autonomous improvements: conservative single-file fixes, sandbox-verified.
      if (config.patches && findings.length > 0) {
        const candidates = selectPatchable(findings, { maxPatches: MAX_PATCHES });
        if (candidates.length > 0) {
          log(pc.dim(`• Generating ${candidates.length} candidate patch(es)…`));
          patches = await generatePatches(provider, parser, ingest.files, candidates, {
            maxPatches: MAX_PATCHES,
            repoRoot: resolved.dir,
            ...(config.verifyCommand ? { verifyCommand: config.verifyCommand } : {}),
          });
          findings = attachPatchRefs(findings, patches);
        }
      }
    } else {
      log(pc.yellow("  No analyzable source files found — nothing to audit."));
    }

    const report: AuditReport = {
      target: resolved.name,
      generatedAt: new Date().toISOString(),
      providerDescription,
      ...(resolved.commit ? { commit: resolved.commit } : {}),
      architectureOverview,
      findings,
      patches,
      repoStats: map.stats,
      ingestStats: ingest.stats,
      passStats,
      budget: tracker.summary(),
    };

    const outDir = path.resolve(config.out);
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "findings.json"), findingsJson(report), "utf8");
    await writeFile(path.join(outDir, "report.md"), renderMarkdown(report), "utf8");
    await writeFile(path.join(outDir, "run-manifest.json"), runManifest(report), "utf8");

    if (patches.length > 0) {
      await mkdir(path.join(outDir, "patches"), { recursive: true });
      for (const p of patches) {
        if (p.status.kind === "rejected") continue;
        await writeFile(path.join(outDir, "patches", p.filename), p.diff, "utf8");
      }
    }

    if (config.apply && analyzed) {
      const applied = await applyPatches(resolved.dir, target, findings, patches, log);
      log(pc.dim(`  applied ${applied} patch(es) to working tree`));
    }

    return {
      outDir,
      findingCount: findings.length,
      score: healthScore(findings),
      report,
      analyzed,
    };
  } finally {
    await resolved.cleanup();
  }
}
