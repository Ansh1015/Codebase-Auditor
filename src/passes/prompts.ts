/**
 * Prompt construction. The system prompt pins the Staff-Engineer persona and the
 * exact JSON output contract (including the hard rule: cite real file:line). Code
 * is rendered with line numbers so the model can cite accurately — which is what
 * makes the downstream evidence-grounding gate effective rather than punitive.
 */

import { CATEGORIES } from "../domain/taxonomy.js";
import type { IngestedFile } from "../ingest/ingest.js";
import type { Component, FileNode, RepoMap } from "../mapping/repomap.js";

export const FINDINGS_SYSTEM = `You are a Staff Software Engineer performing a rigorous, holistic engineering review of a codebase. You reason about architecture, cross-component relationships, maintainability, scalability, security posture, testing strategy, technical debt, duplicated logic, unnecessary complexity, and modernization opportunities — not surface-level lint.

Output ONLY a single JSON object, no prose, of this exact shape:
{
  "findings": [
    {
      "title": "short imperative title",
      "category": one of ${JSON.stringify(CATEGORIES)},
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "confidenceScore": number 0..1,
      "impactRationale": "why this matters in engineering terms",
      "effort": "S" | "M" | "L",
      "affectedFiles": [{ "path": "<exact repo path>", "startLine": <int>, "endLine": <int> }],
      "affectedComponents": ["<component id>"],
      "reasoning": "the staff-engineer argument: what is wrong and why",
      "remediation": "concrete, actionable recommended fix"
    }
  ]
}

HARD RULES:
- Every finding MUST cite at least one real file:line from the PROVIDED code, using the exact line numbers shown in the gutter. Never invent a path or a line number.
- Prefer fewer, high-confidence findings over many speculative ones. If unsure, lower confidenceScore or omit.
- Base claims only on the code shown. Do not assume code you cannot see.`;

export const TRIAGE_SYSTEM = `You are a Staff Software Engineer forming a first mental model of a codebase from its structural map. Output ONLY a single JSON object:
{
  "architectureOverview": "2-4 paragraph plain-English description of what this system is, its main components, how they depend on each other, and notable patterns or smells visible from structure alone",
  "priorityComponents": ["<component id>", ...]  // ordered, highest-concern first
}
Pick priorityComponents by where engineering risk likely concentrates (size, centrality, churn, breadth of responsibility).`;

/** Render a file with a line-number gutter, capped to `maxLines`. */
export function renderFileWithLineNumbers(path: string, content: string, maxLines: number): string {
  const lines = content.split("\n");
  const shown = lines.slice(0, maxLines);
  const width = String(shown.length).length;
  const body = shown.map((line, i) => `${String(i + 1).padStart(width, " ")}| ${line}`).join("\n");
  const truncated = lines.length > maxLines ? `\n… (${lines.length - maxLines} more lines)` : "";
  return `FILE: ${path} (${lines.length} lines)\n${body}${truncated}`;
}

/** Compact textual summary of the whole repo map for the triage pass. */
export function renderRepoMapSummary(map: RepoMap): string {
  const langs = Object.entries(map.stats.languageBreakdown)
    .filter(([l]) => l !== "unknown")
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l}:${n}`)
    .join(", ");

  const components = map.components
    .slice(0, 40)
    .map(
      (c) =>
        `- ${c.id} (${c.files.length} files, ${c.loc} loc, importance ${c.importance.toFixed(2)})`,
    )
    .join("\n");

  const topFiles = map.ranked
    .slice(0, 25)
    .map((p) => {
      const f = map.files.find((x) => x.path === p);
      return f
        ? `- ${p} [${f.role}/${f.language}, ${f.loc} loc, in-deps via importance ${f.importance.toFixed(2)}]`
        : `- ${p}`;
    })
    .join("\n");

  return [
    `Repository structural map:`,
    `Files: ${map.stats.fileCount} | Total LOC: ${map.stats.totalLoc} | Dependency edges: ${map.stats.edgeCount}`,
    `Languages: ${langs || "n/a"}`,
    ``,
    `Components (by importance):`,
    components,
    ``,
    `Most important files:`,
    topFiles,
  ].join("\n");
}

export interface ComponentContext {
  readonly component: Component;
  readonly body: string;
}

/**
 * Build the code context for a component's deep-dive: its files rendered with
 * line numbers, most-important first, capped to a character budget.
 */
export function renderComponentContext(
  component: Component,
  map: RepoMap,
  contentOf: (path: string) => string | undefined,
  opts: { maxChars: number; maxLinesPerFile: number },
): ComponentContext {
  const members: FileNode[] = component.files
    .map((p) => map.files.find((f) => f.path === p))
    .filter((f): f is FileNode => f !== undefined)
    .sort((a, b) => b.importance - a.importance);

  const parts: string[] = [];
  let used = 0;
  for (const f of members) {
    const content = contentOf(f.path);
    if (content === undefined) continue;
    const rendered = renderFileWithLineNumbers(f.path, content, opts.maxLinesPerFile);
    if (used + rendered.length > opts.maxChars && parts.length > 0) break;
    parts.push(rendered);
    used += rendered.length;
  }

  return {
    component,
    body: `Component: ${component.id}\n\n${parts.join("\n\n")}`,
  };
}

export function contentLookup(
  files: readonly IngestedFile[],
): (path: string) => string | undefined {
  const map = new Map(files.map((f) => [f.path as string, f.content]));
  return (path) => map.get(path);
}
