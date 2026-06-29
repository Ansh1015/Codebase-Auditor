/**
 * The evidence-grounding gate — the anti-hallucination heart of the auditor.
 *
 * Every finding must cite at least one `file:line` that actually resolves in the
 * repo. Findings with no resolving evidence are DROPPED; findings that lose some
 * evidence are kept but down-confidenced in proportion to what was discarded.
 * Deterministic and model-independent, so it can't be argued out of doing its job.
 */

import { type FindingId, componentId, findingId, repoRelPath } from "../domain/brand.js";
import type { EvidenceRef, Finding } from "../domain/finding.js";
import { type Category, SEVERITY_RANK, confidenceLevel } from "../domain/taxonomy.js";
import { type RawFinding, findingsEnvelopeSchema, rawFindingSchema } from "./schema.js";

export interface RepoIndex {
  has(path: string): boolean;
  /** Total lines in the file, or undefined if unknown/absent. */
  lineCount(path: string): number | undefined;
}

const CATEGORY_PREFIX: Readonly<Record<Category, string>> = {
  architecture: "ARCH",
  maintainability: "MNT",
  "scalability-performance": "PERF",
  security: "SEC",
  testing: "TEST",
  "technical-debt": "DEBT",
  duplication: "DUP",
  complexity: "CPLX",
  modernization: "MOD",
};

/** Max fraction of confidence removed when ALL-but-one evidence refs are dropped. */
const MAX_PENALTY = 0.5;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Tolerant JSON extraction: fenced block → whole string → first balanced span. */
export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    const p = tryParse(fence[1].trim());
    if (p !== undefined) return p;
  }
  const direct = tryParse(text.trim());
  if (direct !== undefined) return direct;

  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) {
    const p = tryParse(text.slice(objStart, objEnd + 1));
    if (p !== undefined) return p;
  }
  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) {
    const p = tryParse(text.slice(arrStart, arrEnd + 1));
    if (p !== undefined) return p;
  }
  return undefined;
}

/** Parse + validate a model response into RawFindings, skipping malformed ones. */
export function parseFindingsResponse(text: string): RawFinding[] {
  const obj = extractJson(text);
  if (obj === undefined) return [];

  let items: unknown[];
  const envelope = findingsEnvelopeSchema.safeParse(obj);
  if (envelope.success) items = envelope.data.findings;
  else if (Array.isArray(obj)) items = obj;
  else return [];

  const out: RawFinding[] = [];
  for (const item of items) {
    const parsed = rawFindingSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Apply the evidence gate, assign ids, and compute calibrated confidence. */
export function groundFindings(raws: readonly RawFinding[], index: RepoIndex): Finding[] {
  const counters = new Map<Category, number>();
  const out: Finding[] = [];

  for (const raw of raws) {
    const evidence: EvidenceRef[] = [];
    for (const ev of raw.affectedFiles) {
      const lc = index.lineCount(ev.path);
      if (!index.has(ev.path) || lc === undefined) continue;
      if (ev.startLine < 1 || ev.startLine > lc) continue;
      const end = Math.min(ev.endLine ?? ev.startLine, lc);
      evidence.push({
        path: repoRelPath(ev.path),
        startLine: ev.startLine,
        endLine: Math.max(ev.startLine, end),
      });
    }

    if (evidence.length === 0) continue; // ungrounded → dropped

    const total = raw.affectedFiles.length;
    const droppedFraction = total > 0 ? 1 - evidence.length / total : 0;
    const score = round3(raw.confidenceScore * (1 - MAX_PENALTY * droppedFraction));

    const n = (counters.get(raw.category) ?? 0) + 1;
    counters.set(raw.category, n);
    const id: FindingId = findingId(
      `${CATEGORY_PREFIX[raw.category]}-${String(n).padStart(3, "0")}`,
    );

    out.push({
      id,
      title: raw.title,
      category: raw.category,
      severity: raw.severity,
      confidence: { score, level: confidenceLevel(score) },
      impact: { rationale: raw.impactRationale, effort: raw.effort },
      affectedComponents: raw.affectedComponents.map(componentId),
      evidence,
      reasoning: raw.reasoning,
      remediation: raw.remediation,
    });
  }

  return out;
}

/** Stable ordering for reports: severity desc, then confidence desc, then id. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    const conf = b.confidence.score - a.confidence.score;
    if (conf !== 0) return conf;
    return a.id.localeCompare(b.id);
  });
}
