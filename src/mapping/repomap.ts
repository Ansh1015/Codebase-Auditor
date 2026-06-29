/**
 * The repo map — the compact, whole-system view the LLM passes reason over.
 * Deterministic and cheap: built from ingestion + parsing + git metadata, never
 * from the model. This is what makes "holistic" affordable at scale.
 */

import type { ComponentId, RepoRelPath } from "../domain/brand.js";
import type { FileRole } from "../domain/taxonomy.js";
import type { Language } from "../ingest/language.js";
import type { SymbolDef } from "./symbols.js";

export interface FileNode {
  readonly path: RepoRelPath;
  readonly role: FileRole;
  readonly language: Language;
  readonly loc: number;
  readonly symbols: readonly SymbolDef[];
  /** Cheap cyclomatic-ish complexity estimate. */
  readonly complexity: number;
  /** Number of commits touching this file (0 when git metadata is unavailable). */
  readonly churn: number;
  /** Repo-relative paths this file imports (resolved intra-repo edges only). */
  readonly importsResolved: readonly RepoRelPath[];
  /** External/unresolved import specifiers (e.g. `react`, stdlib). */
  readonly importsExternal: readonly string[];
  /** 0–1 importance score (graph centrality + churn + size). */
  readonly importance: number;
  readonly component: ComponentId;
}

export interface DependencyEdge {
  readonly from: RepoRelPath;
  readonly to: RepoRelPath;
}

export interface Component {
  readonly id: ComponentId;
  readonly files: readonly RepoRelPath[];
  readonly loc: number;
  /** Mean importance of member files — used to order deep-dives. */
  readonly importance: number;
}

export interface RepoMapStats {
  readonly fileCount: number;
  readonly totalLoc: number;
  readonly edgeCount: number;
  readonly componentCount: number;
  readonly languageBreakdown: Readonly<Record<string, number>>;
  readonly preciseFiles: number;
}

export interface RepoMap {
  readonly files: readonly FileNode[];
  readonly edges: readonly DependencyEdge[];
  readonly components: readonly Component[];
  /** File paths ranked by importance, descending. */
  readonly ranked: readonly RepoRelPath[];
  readonly stats: RepoMapStats;
}
