/**
 * Patch verification — the trust gate for autonomous fixes.
 *
 * `decideStatus` is the pure policy: a syntax error always rejects; a passing
 * verify command promotes to `verified`; otherwise we honestly report
 * `proposed-unverified`. Keeping it pure makes the trust rules unit-testable.
 */

import type { VerificationStatus } from "../domain/finding.js";
import type { SyntaxCheck } from "../mapping/parse.js";

export interface CommandOutcome {
  readonly ran: boolean;
  readonly passed: boolean;
  readonly detail?: string;
}

export function decideStatus(syntax: SyntaxCheck, command?: CommandOutcome): VerificationStatus {
  if (syntax === "error") {
    return { kind: "rejected", failure: "patched file has a syntax error" };
  }

  if (command?.ran) {
    if (command.passed) {
      return {
        kind: "verified",
        checks: [
          { name: "applies", passed: true },
          {
            name: "parses",
            passed: syntax !== "unknown",
            ...(syntax === "unknown" ? { detail: "no grammar; not checked" } : {}),
          },
          {
            name: "verify-command",
            passed: true,
            ...(command.detail ? { detail: command.detail } : {}),
          },
        ],
      };
    }
    return {
      kind: "rejected",
      failure: `verify command failed${command.detail ? `: ${command.detail}` : ""}`,
    };
  }

  // No behavioural check available — be honest rather than over-claim.
  const reason =
    syntax === "ok"
      ? "syntax valid; no verify command configured to confirm behaviour"
      : "no grammar to verify syntax; provide --verify-command to confirm";
  return { kind: "proposed-unverified", reason };
}
