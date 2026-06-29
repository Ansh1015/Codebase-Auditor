/**
 * Intra-repo import resolution. Turns raw import specifiers into edges between
 * repo files (the precise part of "any language": Python + JS/TS get real
 * resolvers; other languages resolve only what the heuristic can match).
 */

import { type RepoRelPath, repoRelPath } from "../domain/brand.js";
import type { Language } from "../ingest/language.js";
import type { ImportRef } from "./symbols.js";

const SOURCE_ROOT_PREFIXES = ["src/", "lib/", "app/", "source/"];
const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const REWRITABLE_EXT_RE = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/;

export interface ResolverContext {
  readonly paths: ReadonlySet<string>;
  /** python module path (e.g. `app.utils`) → repo file path. */
  readonly pyModules: ReadonlyMap<string, string>;
}

function stripSourceRoot(path: string): string {
  for (const p of SOURCE_ROOT_PREFIXES) {
    if (path.startsWith(p)) return path.slice(p.length);
  }
  return path;
}

/** Build the resolver context once for the whole repo. */
export function buildResolverContext(paths: readonly string[]): ResolverContext {
  const pyModules = new Map<string, string>();
  for (const path of paths) {
    if (!path.endsWith(".py")) continue;
    const noExt = path.slice(0, -3);
    const variants = new Set<string>([noExt, stripSourceRoot(noExt)]);
    for (const v of variants) {
      const asModule = v.replace(/\/__init__$/, "").replaceAll("/", ".");
      if (asModule.length > 0 && !pyModules.has(asModule)) pyModules.set(asModule, path);
    }
  }
  return { paths: new Set(paths), pyModules };
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function joinPath(base: string, rel: string): string {
  const parts = base.length > 0 ? base.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function resolvePython(spec: string, fromPath: string, ctx: ResolverContext): string | null {
  if (spec.startsWith(".")) {
    // relative_import: leading dots = levels up from the current package
    const dots = spec.match(/^\.+/)?.[0].length ?? 1;
    const rest = spec.slice(dots).replaceAll(".", "/");
    let base = dirOf(fromPath);
    for (let i = 1; i < dots; i++) base = dirOf(base);
    const target = rest.length > 0 ? joinPath(base, rest) : base;
    for (const cand of [`${target}.py`, `${target}/__init__.py`]) {
      if (ctx.paths.has(cand)) return cand;
    }
    return null;
  }
  const exact = ctx.pyModules.get(spec);
  if (exact) return exact;
  // Fall back to the longest dotted prefix that resolves (e.g. `app.x.y` → `app.x`).
  const parts = spec.split(".");
  for (let len = parts.length - 1; len >= 1; len--) {
    const hit = ctx.pyModules.get(parts.slice(0, len).join("."));
    if (hit) return hit;
  }
  return null;
}

function resolveJsLike(spec: string, fromPath: string, ctx: ResolverContext): string | null {
  if (!spec.startsWith(".")) return null; // bare specifier → external package
  const target = joinPath(dirOf(fromPath), spec);
  const candidates = [target];
  for (const e of JS_EXTS) {
    candidates.push(`${target}${e}`, `${target}/index${e}`);
  }
  // NodeNext/ESM: a specifier may carry a runtime extension (`./queue.js`) while
  // the source on disk is `./queue.ts`. Rewrite the trailing JS/TS extension to
  // each sibling extension so these resolve. This is the common modern TS style.
  const ext = target.match(REWRITABLE_EXT_RE);
  if (ext) {
    const base = target.slice(0, target.length - ext[0].length);
    for (const e of JS_EXTS) candidates.push(`${base}${e}`);
  }
  for (const cand of candidates) {
    if (ctx.paths.has(cand)) return cand;
  }
  return null;
}

export interface ResolvedImports {
  readonly resolved: readonly RepoRelPath[];
  readonly external: readonly string[];
}

export function resolveImports(
  fromPath: string,
  language: Language,
  imports: readonly ImportRef[],
  ctx: ResolverContext,
): ResolvedImports {
  const resolved = new Set<string>();
  const external = new Set<string>();

  for (const imp of imports) {
    let hit: string | null = null;
    if (language === "python") hit = resolvePython(imp.spec, fromPath, ctx);
    else hit = resolveJsLike(imp.spec, fromPath, ctx);

    if (hit && hit !== fromPath) resolved.add(hit);
    else if (!hit) external.add(imp.spec);
  }

  return {
    resolved: [...resolved].map(repoRelPath),
    external: [...external],
  };
}
