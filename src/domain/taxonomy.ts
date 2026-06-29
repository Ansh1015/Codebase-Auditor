/**
 * Closed vocabularies for the audit domain.
 *
 * Each is a `const` tuple + a union derived from it, so we get a single source
 * of truth that is usable both as runtime values (validation, iteration) and as
 * compile-time types. `assertNever` enforces exhaustiveness at every switch.
 */

export const CATEGORIES = [
  "architecture",
  "maintainability",
  "scalability-performance",
  "security",
  "testing",
  "technical-debt",
  "duplication",
  "complexity",
  "modernization",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** S/M/L remediation effort estimate. */
export const EFFORTS = ["S", "M", "L"] as const;
export type Effort = (typeof EFFORTS)[number];

export const FILE_ROLES = ["source", "test", "config", "docs", "infra"] as const;
export type FileRole = (typeof FILE_ROLES)[number];

/** Logical model tiers, mapped to concrete models per provider/plan. */
export const MODEL_TIERS = ["triage", "deep", "synthesis", "patch"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const PROVIDER_KINDS = ["auto", "api", "subscription"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Numeric weight used to rank/sort by severity (higher = worse). */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/** Map a 0–1 confidence score to a coarse level (kept consistent everywhere). */
export function confidenceLevel(score: number): ConfidenceLevel {
  if (score >= 0.75) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

/** Exhaustiveness guard for discriminated-union switches. */
export function assertNever(value: never, context = "unexpected variant"): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`);
}
