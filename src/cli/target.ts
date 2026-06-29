/**
 * Resolve an audit target — a local path or a Git URL (shallow-cloned to a temp
 * dir, cleaned up afterwards). Also resolves the HEAD commit for the manifest.
 */

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";

/** A target that can't be resolved (bad path, failed clone). Maps to exit 2. */
export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

export interface ResolvedTarget {
  /** Absolute path to the repo on disk. */
  readonly dir: string;
  /** Display name (repo basename). */
  readonly name: string;
  readonly commit?: string;
  /** Remove any temp clone. No-op for local paths. */
  cleanup(): Promise<void>;
}

const URL_RE = /^(https?:\/\/|git@|ssh:\/\/)/;

export function looksLikeGitUrl(target: string): boolean {
  return URL_RE.test(target) || target.endsWith(".git");
}

async function headCommit(dir: string): Promise<string | undefined> {
  const res = await execa("git", ["-C", dir, "rev-parse", "HEAD"], { reject: false });
  return res.exitCode === 0 ? res.stdout.trim() : undefined;
}

function repoNameFromUrl(url: string): string {
  const last = url
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .pop();
  return last && last.length > 0 ? last : "repo";
}

export async function resolveTarget(target: string): Promise<ResolvedTarget> {
  if (looksLikeGitUrl(target)) {
    const base = await mkdtemp(path.join(tmpdir(), "auditor-"));
    const dir = path.join(base, repoNameFromUrl(target));
    const clone = await execa("git", ["clone", "--depth", "1", target, dir], { reject: false });
    if (clone.exitCode !== 0) {
      await rm(base, { recursive: true, force: true });
      throw new TargetError(`git clone failed: ${clone.stderr.slice(0, 300)}`);
    }
    const commit = await headCommit(dir);
    return {
      dir,
      name: repoNameFromUrl(target),
      ...(commit ? { commit } : {}),
      cleanup: () => rm(base, { recursive: true, force: true }),
    };
  }

  const abs = path.resolve(target);
  const info = await stat(abs).catch(() => null);
  if (!info?.isDirectory()) {
    throw new TargetError(`not a directory: ${abs}`);
  }
  const commit = await headCommit(abs);
  return {
    dir: abs,
    name: path.basename(abs),
    ...(commit ? { commit } : {}),
    cleanup: async () => {},
  };
}
