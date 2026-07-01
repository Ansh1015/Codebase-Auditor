/**
 * Context-grounding guards — the second line of the anti-hallucination defence.
 *
 * The evidence gate (`ground.ts`) proves a finding's cited `file:line` *exists*.
 * It cannot prove the *claim about that line* is true when the claim depends on
 * something outside the provided code:
 *   - external resources (does this URL resolve? is this remote version real?);
 *   - documentation snippets judged as if they were build code;
 *   - whole-project facts ("this file doesn't exist", "this is a TS project")
 *     asserted from a cluster that contained no source.
 *
 * These are exactly the failure classes validation surfaced (V-003, V-004): the
 * model, lacking context, asserts an unverifiable claim with high confidence and
 * can even ship a patch for it. The guards are deterministic and model-free: they
 * detect those shapes and *cap confidence* below the patch-eligibility threshold,
 * which both sinks the finding down the report and makes it patch-ineligible.
 * They never weaken the evidence gate — they only ever make output MORE cautious.
 */

import type { FileRole } from "../domain/taxonomy.js";

export type GroundingCaveat =
  | { readonly kind: "external-resource"; readonly note: string }
  | { readonly kind: "doc-as-code"; readonly note: string }
  | { readonly kind: "phantom-structure"; readonly note: string };

/**
 * Confidence ceiling for a caveated finding. Below `selectPatchable`'s "high"
 * threshold (score ≥ 0.75) so a caveated finding can never auto-generate a patch,
 * and low enough to honestly reflect "we couldn't verify this locally".
 */
export const CAVEAT_CONFIDENCE_CAP = 0.4;

export interface FindingText {
  readonly title: string;
  readonly reasoning: string;
  readonly remediation: string;
}

/** A literal URL, or a bare host ending in a real public TLD (so internal dotted
 * identifiers like `request.query.url` or `a.b.c` don't trip it). */
const URL_OR_DOMAIN =
  /(https?:\/\/\S+|\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?:io|org|com|net|dev|app|co|gov|edu|info|rs|sh)\b)/i;

/** Words asserting an external link/address is wrong — the unverifiable claim. */
const URL_VALIDITY =
  /\b(typos?|misspell\w*|broken|dead\s+link|404|unreachable|(?:does\s*n.?t|won.?t|fails?\s+to)\s+(?:resolve|load)|(?:wrong|incorrect|invalid)\s+(?:url|link|domain|address))\b/i;

/** Words asserting code won't compile / is syntactically invalid. Scoped so an
 * incidental "syntax highlighting" or "the compiled asset" doesn't trip it. */
const CODE_VALIDITY =
  /\b(compilation\s+(?:error|failure)|(?:fails?|failing|unable)\s+to\s+compile|(?:won.?t|does\s*n.?t|will\s+not|can.?t)\s+compile|syntax\s+error|invalid\s+syntax|undefined\s+variable|unresolvable|undeclared|won.?t\s+run|fails?\s+to\s+run|(?:not\s+valid|isn.?t\s+valid|invalid)\s+(?:java\s?script|type\s?script|python|js|ts|code))\b/i;

/** Words asserting a repo file/structure is absent — scoped to the repo so a true
 * language fact ("httplib doesn't exist in Python 3") doesn't trip the guard. */
const PHANTOM =
  /\b(no\s+such\s+file|non-?existent|(?:do(?:es)?\s*n.?t|don.?t)\s+exist\s+in\s+(?:the|this)\s+(?:repo|repository|code\s?base|project)|not\s+present\s+in\s+(?:the|this)\s+(?:repo|repository|code\s?base|project)|copy-?pasted|wrong\s+(?:ecosystem|project\s+type))\b/i;

/** Claim that the audited repo IS some language/type — the determiner ("this/a/an")
 * scopes it to the project under review, not an upstream reference ("the Go project"). */
const WRONG_PROJECT =
  /\b(?:this|a|an)\s+(?:type\s?script|java\s?script|python|golang|go|rust|java|ruby|php)\s+(?:project|code\s?base|repo)\b/i;

function blob(t: FindingText): string {
  return `${t.title}\n${t.reasoning}\n${t.remediation}`;
}

function allNonSource(roles: readonly FileRole[]): boolean {
  return roles.length > 0 && roles.every((r) => r !== "source" && r !== "test");
}

function allDocs(roles: readonly FileRole[]): boolean {
  return roles.length > 0 && roles.every((r) => r === "docs");
}

/**
 * Detect whether a finding rests on a claim the deterministic core cannot verify
 * from the provided code. Returns the caveat to attach (and cap on), or undefined.
 * `evidenceRoles` are the roles of the finding's RESOLVED evidence files.
 */
export function detectGroundingCaveat(
  text: FindingText,
  evidenceRoles: readonly FileRole[],
): GroundingCaveat | undefined {
  const b = blob(text);

  // V-003: a claim that an external URL/domain is wrong — unverifiable offline.
  if (URL_OR_DOMAIN.test(b) && URL_VALIDITY.test(b)) {
    return {
      kind: "external-resource",
      note: "Rests on an external resource (URL/domain) the auditor cannot verify offline — confirm manually before acting.",
    };
  }

  // V-004a: documentation snippet judged as build code.
  if (allDocs(evidenceRoles) && CODE_VALIDITY.test(b)) {
    return {
      kind: "doc-as-code",
      note: "Target is documentation; illustrative snippets are not necessarily runnable code, so compile/syntax claims may not apply.",
    };
  }

  // V-004b: whole-project claim (missing files / wrong project type) asserted from
  // a cluster containing no source — the model couldn't have seen the real tree.
  if (allNonSource(evidenceRoles) && (PHANTOM.test(b) || WRONG_PROJECT.test(b))) {
    return {
      kind: "phantom-structure",
      note: "Claims about project structure/type could not be grounded from the cited non-source files alone — verify against the full tree.",
    };
  }

  return undefined;
}
