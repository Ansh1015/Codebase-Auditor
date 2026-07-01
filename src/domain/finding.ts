/**
 * The Finding model — the unit of output. JSON is the source of truth; the
 * Markdown report is rendered from these objects.
 */

import type { ComponentId, FindingId, RepoRelPath } from "./brand.js";
import type { Category, ConfidenceLevel, Effort, Severity } from "./taxonomy.js";

/** A concrete, resolvable pointer into the repo. The grounding gate checks these. */
export interface EvidenceRef {
  readonly path: RepoRelPath;
  /** 1-based inclusive line range. `endLine` defaults to `startLine` when omitted. */
  readonly startLine: number;
  readonly endLine: number;
}

export interface Impact {
  /** Why this matters, in engineering terms. */
  readonly rationale: string;
  /** Rough remediation effort. */
  readonly effort: Effort;
}

export interface Confidence {
  readonly level: ConfidenceLevel;
  /** 0–1 calibrated score. `level` is derived from this via `confidenceLevel`. */
  readonly score: number;
}

export interface Finding {
  readonly id: FindingId;
  readonly title: string;
  readonly category: Category;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly impact: Impact;
  readonly affectedComponents: readonly ComponentId[];
  readonly evidence: readonly EvidenceRef[];
  /** The Staff-Engineer argument: what's wrong and why. */
  readonly reasoning: string;
  /** Concrete, actionable recommended fix. */
  readonly remediation: string;
  /**
   * Set by a context-grounding guard when the finding rests on a claim the
   * deterministic core could not verify locally (external URL, doc-as-code,
   * whole-project structure). When present, confidence has been capped and the
   * finding is patch-ineligible. Human-readable rationale for the cap.
   */
  readonly caveat?: string;
  /** Filename of a generated patch under patches/, if one was produced. */
  readonly patchRef?: string;
}

/**
 * Outcome of sandboxed patch verification — a discriminated union so each state
 * carries exactly the data that makes sense for it (and no more).
 */
export type VerificationStatus =
  | { readonly kind: "verified"; readonly checks: readonly VerificationCheck[] }
  | { readonly kind: "proposed-unverified"; readonly reason: string }
  | { readonly kind: "rejected"; readonly failure: string };

export interface VerificationCheck {
  readonly name: string; // e.g. "applies", "parses", "tests"
  readonly passed: boolean;
  readonly detail?: string;
}

export interface ProposedPatch {
  /** Finding this patch resolves. */
  readonly findingId: FindingId;
  /** Filename written under patches/ (e.g. `SEC-001.patch`). */
  readonly filename: string;
  /** Unified-diff text. */
  readonly diff: string;
  readonly status: VerificationStatus;
}
