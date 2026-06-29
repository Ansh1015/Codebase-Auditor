/**
 * Extension → language mapping. Drives the parser adapters (precise for the
 * tuned languages, generic tree-sitter/heuristic fallback elsewhere).
 */

export const LANGUAGES = [
  "python",
  "javascript",
  "typescript",
  "tsx",
  "jsx",
  "go",
  "java",
  "ruby",
  "rust",
  "c",
  "cpp",
  "csharp",
  "php",
  "swift",
  "kotlin",
  "scala",
  "shell",
  "unknown",
] as const;
export type Language = (typeof LANGUAGES)[number];

/** Languages we extract precise imports/symbols for. */
export const TUNED_LANGUAGES: ReadonlySet<Language> = new Set([
  "python",
  "javascript",
  "typescript",
  "tsx",
  "jsx",
]);

const EXT_TO_LANG: Readonly<Record<string, Language>> = {
  py: "python",
  pyi: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  go: "go",
  java: "java",
  rb: "ruby",
  rs: "rust",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
};

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function languageOf(path: string): Language {
  return EXT_TO_LANG[extensionOf(path)] ?? "unknown";
}

export function isTuned(lang: Language): boolean {
  return TUNED_LANGUAGES.has(lang);
}
