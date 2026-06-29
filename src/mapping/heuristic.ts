/**
 * Regex-based extraction. Used for languages without a bundled grammar, and as
 * a graceful fallback if tree-sitter ever fails on a tuned file. Coarser than
 * tree-sitter but never crashes — exactly the "degrade gracefully" contract.
 */

import type { Language } from "../ingest/language.js";
import type { ImportRef, ParsedFile, SymbolDef, SymbolKind } from "./symbols.js";

interface Rule {
  readonly re: RegExp;
  readonly kind: SymbolKind;
  readonly group: number;
}

const SYMBOL_RULES: Rule[] = [
  { re: /^\s*def\s+([A-Za-z_]\w*)/, kind: "function", group: 1 },
  { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class", group: 1 },
  {
    re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    kind: "function",
    group: 1,
  },
  { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", group: 1 },
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function", group: 1 }, // go
  {
    re: /^\s*(?:public|private|protected)?\s*interface\s+([A-Za-z_]\w*)/,
    kind: "interface",
    group: 1,
  },
];

const IMPORT_RULES: RegExp[] = [
  /^\s*from\s+([.\w]+)\s+import\b/, // python
  /^\s*import\s+([.\w]+)/, // python / java / go (single)
  /\bimport\s+(?:[^'"]*\bfrom\s+)?['"]([^'"]+)['"]/, // js/ts
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/, // node require
  /^\s*#include\s*[<"]([^>"]+)[>"]/, // c/cpp
];

export function heuristicParse(content: string, _lang: Language): ParsedFile {
  const symbols: SymbolDef[] = [];
  const imports: ImportRef[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const rule of SYMBOL_RULES) {
      const m = rule.re.exec(line);
      if (m?.[rule.group]) {
        symbols.push({
          name: m[rule.group] as string,
          kind: rule.kind,
          startLine: i + 1,
          endLine: i + 1,
        });
        break;
      }
    }
    for (const re of IMPORT_RULES) {
      const m = re.exec(line);
      if (m?.[1]) {
        imports.push({ spec: m[1], line: i + 1 });
        break;
      }
    }
  }

  return { symbols, imports, precise: false };
}
