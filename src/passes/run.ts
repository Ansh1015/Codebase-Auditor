/**
 * Pass orchestration: triage → per-component deep-dives (parallel) → cross-cutting
 * → ground + dedupe. Single-round per pass (the model gets a budgeted, line-
 * numbered slice of code and returns findings); a future enhancement lets a pass
 * request more files across rounds, behind the same provider interface.
 */

import { z } from "zod";
import type { ComponentId } from "../domain/brand.js";
import type { Finding } from "../domain/finding.js";
import type { FileRole } from "../domain/taxonomy.js";
import {
  extractJson,
  groundFindings,
  parseFindingsResponse,
  sortFindings,
} from "../findings/ground.js";
import type { RepoIndex } from "../findings/ground.js";
import type { IngestResult } from "../ingest/ingest.js";
import type { LlmProvider } from "../llm/types.js";
import type { Component, RepoMap } from "../mapping/repomap.js";
import {
  FINDINGS_SYSTEM,
  TRIAGE_SYSTEM,
  contentLookup,
  renderComponentContext,
  renderFileWithLineNumbers,
  renderProjectFactSheet,
  renderRepoMapSummary,
} from "./prompts.js";

const triageSchema = z.object({
  architectureOverview: z.string().default(""),
  priorityComponents: z.array(z.string()).default([]),
});

export interface AuditOptions {
  readonly maxComponents: number;
  readonly maxCharsPerComponent: number;
  readonly maxLinesPerFile: number;
  readonly concurrency: number;
  readonly crossCut: boolean;
}

export const DEFAULT_AUDIT_OPTIONS: AuditOptions = {
  maxComponents: 8,
  maxCharsPerComponent: 48_000,
  maxLinesPerFile: 500,
  concurrency: 3,
  crossCut: true,
};

export interface PassStats {
  readonly deepDives: number;
  readonly crossCut: boolean;
  readonly rawFindings: number;
  readonly groundedFindings: number;
  readonly droppedUngrounded: number;
}

export interface AuditResult {
  readonly architectureOverview: string;
  readonly findings: readonly Finding[];
  readonly passStats: PassStats;
}

export function buildRepoIndex(ingest: IngestResult): RepoIndex {
  const lines = new Map<string, number>();
  const roles = new Map<string, FileRole>();
  for (const f of ingest.files) {
    lines.set(f.path, f.lineCount);
    roles.set(f.path, f.role);
  }
  return {
    has: (p) => lines.has(p),
    lineCount: (p) => lines.get(p),
    role: (p) => roles.get(p),
  };
}

async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runTriage(
  provider: LlmProvider,
  map: RepoMap,
): Promise<{ architectureOverview: string; priorityComponents: string[] }> {
  const res = await provider.complete({
    system: TRIAGE_SYSTEM,
    user: renderRepoMapSummary(map),
    tier: "triage",
    maxOutputTokens: 1500,
  });
  const parsed = triageSchema.safeParse(extractJson(res.text));
  if (parsed.success) return parsed.data;
  return { architectureOverview: "", priorityComponents: [] };
}

/** Order components: triage priorities first (if valid), then by importance. */
function orderComponents(map: RepoMap, priorities: string[], cap: number): Component[] {
  const byId = new Map(map.components.map((c) => [c.id as string, c]));
  const ordered: Component[] = [];
  const seen = new Set<string>();
  for (const id of priorities) {
    const c = byId.get(id);
    if (c && !seen.has(id)) {
      ordered.push(c);
      seen.add(id);
    }
  }
  for (const c of map.components) {
    if (!seen.has(c.id)) {
      ordered.push(c);
      seen.add(c.id);
    }
  }
  return ordered.slice(0, cap);
}

async function runDeepDive(
  provider: LlmProvider,
  component: Component,
  map: RepoMap,
  contentOf: (path: string) => string | undefined,
  opts: AuditOptions,
  factSheet: string,
): Promise<ReturnType<typeof parseFindingsResponse>> {
  const ctx = renderComponentContext(component, map, contentOf, {
    maxChars: opts.maxCharsPerComponent,
    maxLinesPerFile: opts.maxLinesPerFile,
  });
  const res = await provider.complete({
    system: FINDINGS_SYSTEM,
    user: `${factSheet}\n\nAudit this component for engineering issues. Cite exact file:line from the gutter.\n\n${ctx.body}`,
    tier: "deep",
    maxOutputTokens: 4096,
  });
  return parseFindingsResponse(res.text);
}

async function runCrossCut(
  provider: LlmProvider,
  map: RepoMap,
  contentOf: (path: string) => string | undefined,
  opts: AuditOptions,
  factSheet: string,
): Promise<ReturnType<typeof parseFindingsResponse>> {
  const summary = renderRepoMapSummary(map);
  const parts: string[] = [];
  let used = 0;
  for (const path of map.ranked) {
    const content = contentOf(path);
    if (content === undefined) continue;
    const rendered = renderFileWithLineNumbers(path, content, 250);
    if (used + rendered.length > opts.maxCharsPerComponent * 2 && parts.length > 0) break;
    parts.push(rendered);
    used += rendered.length;
  }
  const res = await provider.complete({
    system: FINDINGS_SYSTEM,
    user: `${factSheet}\n\nPerform a CROSS-CUTTING review of the whole system. Focus on architecture consistency, duplicated business logic ACROSS files, security posture, and testing strategy. Cite exact file:line.\n\n${summary}\n\n=== KEY FILES ===\n${parts.join("\n\n")}`,
    tier: "synthesis",
    maxOutputTokens: 4096,
  });
  return parseFindingsResponse(res.text);
}

/** De-duplicate by (category|title|first-path), keeping the highest confidence. */
function dedupe(findings: readonly Finding[]): Finding[] {
  const best = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.category}|${f.title.toLowerCase()}|${f.evidence[0]?.path ?? ""}`;
    const prev = best.get(key);
    if (!prev || f.confidence.score > prev.confidence.score) best.set(key, f);
  }
  return [...best.values()];
}

export async function runAudit(
  provider: LlmProvider,
  ingest: IngestResult,
  map: RepoMap,
  options: AuditOptions = DEFAULT_AUDIT_OPTIONS,
): Promise<AuditResult> {
  const contentOf = contentLookup(ingest.files);
  const index = buildRepoIndex(ingest);

  const factSheet = renderProjectFactSheet(map);
  const triage = await runTriage(provider, map);
  const components = orderComponents(map, triage.priorityComponents, options.maxComponents);

  const deepResults = await runPool(components, options.concurrency, (c) =>
    runDeepDive(provider, c, map, contentOf, options, factSheet),
  );
  const raws = deepResults.flat();

  if (options.crossCut) {
    raws.push(...(await runCrossCut(provider, map, contentOf, options, factSheet)));
  }

  const grounded = groundFindings(raws, index);
  const findings = sortFindings(dedupe(grounded));

  return {
    architectureOverview: triage.architectureOverview,
    findings,
    passStats: {
      deepDives: components.length,
      crossCut: options.crossCut,
      rawFindings: raws.length,
      groundedFindings: grounded.length,
      droppedUngrounded: raws.length - grounded.length,
    },
  };
}
