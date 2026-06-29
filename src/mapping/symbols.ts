/** Structural facts extracted from a single file. */

export type SymbolKind = "function" | "class" | "method" | "interface" | "type";

export interface SymbolDef {
  readonly name: string;
  readonly kind: SymbolKind;
  /** 1-based inclusive line range of the whole definition. */
  readonly startLine: number;
  readonly endLine: number;
}

export interface ImportRef {
  /** Raw module specifier as written (e.g. `app.utils`, `./helpers`, `react`). */
  readonly spec: string;
  readonly line: number;
}

export interface ParsedFile {
  readonly symbols: readonly SymbolDef[];
  readonly imports: readonly ImportRef[];
  /** True when extracted by a precise grammar; false for the heuristic fallback. */
  readonly precise: boolean;
}
