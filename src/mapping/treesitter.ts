/**
 * Tree-sitter (WASM) parsing for the tuned languages. Loads grammars lazily and
 * caches them. Uses `query.matches` so each match groups the definition node
 * with its name node, giving precise kind + line ranges.
 */

import { createRequire } from "node:module";
import type { Language } from "../ingest/language.js";
import type { ImportRef, ParsedFile, SymbolDef, SymbolKind } from "./symbols.js";

const require = createRequire(import.meta.url);

// biome-ignore lint/suspicious/noExplicitAny: web-tree-sitter ships loose types in this build.
type TS = any;

/** Languages with a bundled grammar + extraction queries. */
const GRAMMAR_WASM: Partial<Record<Language, string>> = {
  python: "tree-sitter-python.wasm",
  javascript: "tree-sitter-javascript.wasm",
  jsx: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
};

const PY_SYMBOLS = `
  (function_definition name: (identifier) @name) @def
  (class_definition name: (identifier) @name) @def
`;
const JS_SYMBOLS = `
  (function_declaration name: (identifier) @name) @def
  (class_declaration name: (identifier) @name) @def
  (method_definition name: (property_identifier) @name) @def
  (variable_declarator name: (identifier) @name value: (arrow_function)) @def
  (variable_declarator name: (identifier) @name value: (function_expression)) @def
`;
const TS_SYMBOLS = `
  (function_declaration name: (identifier) @name) @def
  (class_declaration name: (type_identifier) @name) @def
  (method_definition name: (property_identifier) @name) @def
  (variable_declarator name: (identifier) @name value: (arrow_function)) @def
  (interface_declaration name: (type_identifier) @name) @def
  (type_alias_declaration name: (type_identifier) @name) @def
`;

const SYMBOL_QUERIES: Partial<Record<Language, string>> = {
  python: PY_SYMBOLS,
  javascript: JS_SYMBOLS,
  jsx: JS_SYMBOLS,
  typescript: TS_SYMBOLS,
  tsx: TS_SYMBOLS,
};

const PY_IMPORTS = `
  (import_statement (dotted_name) @mod)
  (import_statement (aliased_import (dotted_name) @mod))
  (import_from_statement module_name: (dotted_name) @mod)
  (import_from_statement module_name: (relative_import) @mod)
`;
const JS_IMPORTS = `
  (import_statement source: (string) @mod)
  (export_statement source: (string) @mod)
  (call_expression function: (identifier) @callee arguments: (arguments (string) @mod))
`;

const IMPORT_QUERIES: Partial<Record<Language, string>> = {
  python: PY_IMPORTS,
  javascript: JS_IMPORTS,
  jsx: JS_IMPORTS,
  typescript: JS_IMPORTS,
  tsx: JS_IMPORTS,
};

const DEF_KIND: Record<string, SymbolKind> = {
  function_definition: "function",
  function_declaration: "function",
  class_definition: "class",
  class_declaration: "class",
  method_definition: "method",
  variable_declarator: "function", // arrow/function expression assigned to a const
  interface_declaration: "interface",
  type_alias_declaration: "type",
};

function stripQuotes(text: string): string {
  return text.replace(/^['"`]/, "").replace(/['"`]$/, "");
}

export class TreeSitterEngine {
  private parserCtor: TS = null;
  private readonly langs = new Map<Language, TS>();
  private readonly wasmDir: string;

  constructor() {
    this.wasmDir = require
      .resolve("tree-sitter-wasms/package.json")
      .replace(/package\.json$/, "out/");
  }

  static supports(lang: Language): boolean {
    return lang in GRAMMAR_WASM;
  }

  private async init(): Promise<void> {
    if (this.parserCtor) return;
    const Parser = (await import("web-tree-sitter")).default as TS;
    await Parser.init();
    this.parserCtor = Parser;
  }

  private async language(lang: Language): Promise<TS | null> {
    const wasm = GRAMMAR_WASM[lang];
    if (!wasm) return null;
    const cached = this.langs.get(lang);
    if (cached) return cached;
    await this.init();
    const loaded = await this.parserCtor.Language.load(this.wasmDir + wasm);
    this.langs.set(lang, loaded);
    return loaded;
  }

  async parse(content: string, lang: Language): Promise<ParsedFile | null> {
    const language = await this.language(lang);
    if (!language) return null;

    const parser = new this.parserCtor();
    parser.setLanguage(language);
    const tree = parser.parse(content);
    const root = tree.rootNode;

    const symbols = this.extractSymbols(language, root, lang);
    const imports = this.extractImports(language, root, lang);
    return { symbols, imports, precise: true };
  }

  /** True if the grammar reports a syntax error. null when unsupported. */
  async hasSyntaxError(content: string, lang: Language): Promise<boolean | null> {
    const language = await this.language(lang);
    if (!language) return null;
    const parser = new this.parserCtor();
    parser.setLanguage(language);
    const root = parser.parse(content).rootNode;
    const he = root.hasError;
    return typeof he === "function" ? Boolean(he.call(root)) : Boolean(he);
  }

  private extractSymbols(language: TS, root: TS, lang: Language): SymbolDef[] {
    const queryStr = SYMBOL_QUERIES[lang];
    if (!queryStr) return [];
    const query = language.query(queryStr);
    const out: SymbolDef[] = [];
    for (const match of query.matches(root)) {
      const def = match.captures.find((c: TS) => c.name === "def")?.node;
      const name = match.captures.find((c: TS) => c.name === "name")?.node;
      if (!def || !name) continue;
      const kind = DEF_KIND[def.type];
      if (!kind) continue;
      out.push({
        name: name.text,
        kind,
        startLine: def.startPosition.row + 1,
        endLine: def.endPosition.row + 1,
      });
    }
    return out;
  }

  private extractImports(language: TS, root: TS, lang: Language): ImportRef[] {
    const queryStr = IMPORT_QUERIES[lang];
    if (!queryStr) return [];
    const query = language.query(queryStr);
    const out: ImportRef[] = [];
    for (const match of query.matches(root)) {
      const callee = match.captures.find((c: TS) => c.name === "callee")?.node;
      // For call-expression matches, only keep require(...) / import(...).
      if (callee && callee.text !== "require" && callee.text !== "import") continue;
      const mod = match.captures.find((c: TS) => c.name === "mod")?.node;
      if (!mod) continue;
      const spec = stripQuotes(mod.text);
      if (spec.length === 0) continue;
      out.push({ spec, line: mod.startPosition.row + 1 });
    }
    return out;
  }
}
