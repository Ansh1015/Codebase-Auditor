/**
 * Repository ingestion: decide which files are "relevant", read them, and tag
 * each with role + language. Relevant = tracked/untracked-not-ignored,
 * non-generated, non-binary, under the size cap.
 *
 * When the target is a git repo we lean on `git ls-files` so .gitignore (incl.
 * nested + global excludes) is honoured for free; otherwise we walk with a
 * gitignore-aware globber and apply built-in default ignores.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { globby } from "globby";
import { type AbsPath, type RepoRelPath, repoRelPath } from "../domain/brand.js";
import type { FileRole } from "../domain/taxonomy.js";
import { classifyRole } from "./classify.js";
import { type Language, languageOf } from "./language.js";

export interface IngestedFile {
  readonly path: RepoRelPath;
  readonly absPath: AbsPath;
  readonly role: FileRole;
  readonly language: Language;
  readonly bytes: number;
  readonly lineCount: number;
  readonly content: string;
}

export interface IngestStats {
  readonly considered: number;
  readonly ingested: number;
  readonly skippedBinary: number;
  readonly skippedTooLarge: number;
  readonly skippedIgnored: number;
}

export interface IngestResult {
  readonly root: AbsPath;
  readonly files: readonly IngestedFile[];
  readonly stats: IngestStats;
}

export interface IngestOptions {
  /** Max bytes per file before it is skipped. Default 1 MiB. */
  readonly maxFileBytes?: number;
  /** Extra ignore dir-names (in addition to the defaults). */
  readonly extraIgnoreDirs?: readonly string[];
}

const DEFAULT_MAX_BYTES = 1024 * 1024;

const DEFAULT_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  "env",
  "dist",
  "build",
  "out",
  "target",
  "bin",
  "obj",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  "bower_components",
  ".idea",
  ".gradle",
  "Pods",
]);

const GENERATED_FILE_RE =
  /(\.min\.(js|css)|\.bundle\.js|\.map|-lock\.(json|yaml|yml)|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.generated\.[a-z]+|_pb2\.py|\.pb\.go)$/i;

function hasIgnoredSegment(relPath: string, extra: ReadonlySet<string>): boolean {
  for (const seg of relPath.split("/")) {
    if (DEFAULT_IGNORE_DIRS.has(seg) || extra.has(seg)) return true;
  }
  return false;
}

/** Heuristic binary sniff: a NUL byte in the first 8 KiB. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

async function candidatePaths(root: string): Promise<string[]> {
  const isGit = await stat(path.join(root, ".git"))
    .then(() => true)
    .catch(() => false);

  if (isGit) {
    try {
      const { stdout } = await execa(
        "git",
        ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { reject: false },
      );
      const list = stdout.split("\0").filter((p) => p.length > 0);
      if (list.length > 0) return list;
    } catch {
      // fall through to globby
    }
  }

  return globby(["**/*"], {
    cwd: root,
    gitignore: true,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
}

export async function ingestRepo(
  rootInput: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const root = path.resolve(rootInput);
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_BYTES;
  const extra = new Set(options.extraIgnoreDirs ?? []);

  const candidates = await candidatePaths(root);

  const files: IngestedFile[] = [];
  let skippedBinary = 0;
  let skippedTooLarge = 0;
  let skippedIgnored = 0;

  for (const raw of candidates) {
    const rel = raw.replaceAll("\\", "/");
    if (hasIgnoredSegment(rel, extra) || GENERATED_FILE_RE.test(rel)) {
      skippedIgnored++;
      continue;
    }

    const abs = path.join(root, rel);
    let size: number;
    try {
      size = (await stat(abs)).size;
    } catch {
      continue; // vanished / unreadable
    }
    if (size > maxBytes) {
      skippedTooLarge++;
      continue;
    }

    let buf: Buffer;
    try {
      buf = await readFile(abs);
    } catch {
      continue;
    }
    if (looksBinary(buf)) {
      skippedBinary++;
      continue;
    }

    const content = buf.toString("utf8");
    files.push({
      path: repoRelPath(rel),
      absPath: abs as AbsPath,
      role: classifyRole(rel),
      language: languageOf(rel),
      bytes: size,
      lineCount: countLines(content),
      content,
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    root: root as AbsPath,
    files,
    stats: {
      considered: candidates.length,
      ingested: files.length,
      skippedBinary,
      skippedTooLarge,
      skippedIgnored,
    },
  };
}
