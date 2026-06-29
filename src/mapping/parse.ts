/**
 * Parser router: tuned languages go through tree-sitter (precise); everything
 * else (and any tree-sitter failure) falls back to the heuristic extractor.
 */

import type { Language } from "../ingest/language.js";
import { heuristicParse } from "./heuristic.js";
import type { ParsedFile } from "./symbols.js";
import { TreeSitterEngine } from "./treesitter.js";

export type SyntaxCheck = "ok" | "error" | "unknown";

export interface RepoParser {
  parse(content: string, lang: Language): Promise<ParsedFile>;
  /** Verify syntactic validity. "unknown" when no precise grammar is available. */
  checkSyntax(content: string, lang: Language): Promise<SyntaxCheck>;
}

export function createParser(): RepoParser {
  const engine = new TreeSitterEngine();

  return {
    async parse(content, lang) {
      if (TreeSitterEngine.supports(lang)) {
        try {
          const parsed = await engine.parse(content, lang);
          if (parsed) return parsed;
        } catch {
          // grammar/parse error → degrade rather than fail the whole audit
        }
      }
      return heuristicParse(content, lang);
    },

    async checkSyntax(content, lang) {
      if (!TreeSitterEngine.supports(lang)) return "unknown";
      try {
        const errored = await engine.hasSyntaxError(content, lang);
        if (errored === null) return "unknown";
        return errored ? "error" : "ok";
      } catch {
        return "unknown";
      }
    },
  };
}
