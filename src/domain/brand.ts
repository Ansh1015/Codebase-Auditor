/**
 * Nominal (branded) types.
 *
 * A `Brand<T, B>` is structurally `T` at runtime but nominally distinct at the
 * type level, so a raw `string` can't be passed where a `FilePath` is expected.
 * This kills a whole class of "which string is this?" bugs across the pipeline
 * (repo-relative paths vs absolute paths vs content hashes vs component ids).
 */

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** A path relative to the repository root, POSIX-separated (e.g. `src/cli/main.ts`). */
export type RepoRelPath = Brand<string, "RepoRelPath">;

/** An absolute filesystem path (OS-native separators). */
export type AbsPath = Brand<string, "AbsPath">;

/** A git commit SHA. */
export type CommitSha = Brand<string, "CommitSha">;

/** Stable identifier for a logical component/cluster of files. */
export type ComponentId = Brand<string, "ComponentId">;

/** Stable identifier for a finding (`CATEGORY-NNN`). */
export type FindingId = Brand<string, "FindingId">;

/** A content-addressed cache key (sha256 hex). */
export type CacheKey = Brand<string, "CacheKey">;

// Smart constructors. Validation lives at the boundary; internal code trusts the brand.

export function repoRelPath(value: string): RepoRelPath {
  return value.replaceAll("\\", "/") as RepoRelPath;
}

export function absPath(value: string): AbsPath {
  return value as AbsPath;
}

export function commitSha(value: string): CommitSha {
  return value as CommitSha;
}

export function componentId(value: string): ComponentId {
  return value as ComponentId;
}

export function findingId(value: string): FindingId {
  return value as FindingId;
}

export function cacheKey(value: string): CacheKey {
  return value as CacheKey;
}
