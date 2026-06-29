/**
 * Assemble the RepoMap from ingestion + parsing + git metadata.
 *
 * Importance = weighted blend of graph in-degree (who depends on me), churn
 * (how often I change), and size — so deep-dives spend budget on files that are
 * central, volatile, or large rather than an arbitrary slice.
 */

import { type ComponentId, type RepoRelPath, componentId } from "../domain/brand.js";
import type { IngestResult } from "../ingest/ingest.js";
import { estimateComplexity, gitChurn } from "./metrics.js";
import type { RepoParser } from "./parse.js";
import type { Component, DependencyEdge, FileNode, RepoMap, RepoMapStats } from "./repomap.js";
import { buildResolverContext, resolveImports } from "./resolve.js";

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function componentOf(path: string): string {
  const dir = dirOf(path);
  if (dir === "") return "(root)";
  const segs = dir.split("/");
  return segs.slice(0, Math.min(2, segs.length)).join("/");
}

function norm(value: number, max: number): number {
  return max > 0 ? value / max : 0;
}

interface Draft {
  node: Omit<FileNode, "importance" | "component">;
  inDegree: number;
}

export async function buildRepoMap(ingest: IngestResult, parser: RepoParser): Promise<RepoMap> {
  const churn = await gitChurn(ingest.root);
  const ctx = buildResolverContext(ingest.files.map((f) => f.path));

  const drafts = new Map<string, Draft>();
  const edges: DependencyEdge[] = [];
  let preciseFiles = 0;

  for (const file of ingest.files) {
    const parsed =
      file.language === "unknown"
        ? { symbols: [], imports: [], precise: false }
        : await parser.parse(file.content, file.language);
    if (parsed.precise) preciseFiles++;

    const { resolved, external } = resolveImports(file.path, file.language, parsed.imports, ctx);

    drafts.set(file.path, {
      inDegree: 0,
      node: {
        path: file.path,
        role: file.role,
        language: file.language,
        loc: file.lineCount,
        symbols: parsed.symbols,
        complexity: estimateComplexity(file.content),
        churn: churn.get(file.path) ?? 0,
        importsResolved: resolved,
        importsExternal: external,
      },
    });

    for (const to of resolved) {
      edges.push({ from: file.path, to });
    }
  }

  // In-degree from resolved edges.
  for (const edge of edges) {
    const d = drafts.get(edge.to);
    if (d) d.inDegree += 1;
  }

  const maxIn = Math.max(1, ...[...drafts.values()].map((d) => d.inDegree));
  const maxChurn = Math.max(1, ...[...drafts.values()].map((d) => d.node.churn));
  const maxLoc = Math.max(1, ...[...drafts.values()].map((d) => d.node.loc));

  const files: FileNode[] = [];
  for (const draft of drafts.values()) {
    const importance =
      0.5 * norm(draft.inDegree, maxIn) +
      0.3 * norm(draft.node.churn, maxChurn) +
      0.2 * norm(draft.node.loc, maxLoc);
    files.push({
      ...draft.node,
      importance: Math.round(importance * 1000) / 1000,
      component: componentId(componentOf(draft.node.path)),
    });
  }

  // Components.
  const byComponent = new Map<string, FileNode[]>();
  for (const f of files) {
    const arr = byComponent.get(f.component) ?? [];
    arr.push(f);
    byComponent.set(f.component, arr);
  }
  const components: Component[] = [...byComponent.entries()]
    .map(([id, members]) => ({
      id: componentId(id) as ComponentId,
      files: members.map((m) => m.path),
      loc: members.reduce((s, m) => s + m.loc, 0),
      importance: members.reduce((s, m) => s + m.importance, 0) / Math.max(1, members.length),
    }))
    .sort((a, b) => b.importance - a.importance);

  const ranked: RepoRelPath[] = [...files]
    .sort((a, b) => b.importance - a.importance)
    .map((f) => f.path);

  const languageBreakdown: Record<string, number> = {};
  for (const f of files) {
    languageBreakdown[f.language] = (languageBreakdown[f.language] ?? 0) + 1;
  }

  const stats: RepoMapStats = {
    fileCount: files.length,
    totalLoc: files.reduce((s, f) => s + f.loc, 0),
    edgeCount: edges.length,
    componentCount: components.length,
    languageBreakdown,
    preciseFiles,
  };

  return { files, edges, components, ranked, stats };
}
