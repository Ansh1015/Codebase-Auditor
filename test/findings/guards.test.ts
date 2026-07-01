import { describe, expect, it } from "vitest";
import type { FileRole } from "../../src/domain/taxonomy.js";
import { detectGroundingCaveat } from "../../src/findings/guards.js";

// Text taken verbatim (trimmed) from the real validation corpus so the guards are
// tested against the actual hallucinations they exist to catch — and the real
// legitimate findings they must NOT touch.

describe("detectGroundingCaveat — V-003 external-resource", () => {
  it("caps the certifi URL false-positive (requests MNT-009)", () => {
    const c = detectGroundingCaveat(
      {
        title: "Fix typo in certifi hyperlink target (double 'i' produces broken URL)",
        reasoning:
          "Line 295 reads `.. _certifi: https://certifiio.readthedocs.io/`. 'certifiio' is a doubled-'i' typo; the canonical documentation lives at certifi.io.",
        remediation: "Change line 295 to https://certifi.readthedocs.io/ to restore the link.",
      },
      ["docs"],
    );
    expect(c?.kind).toBe("external-resource");
  });

  it("does NOT cap a real code finding that merely mentions a url-ish identifier (got SEC-001)", () => {
    const c = detectGroundingCaveat(
      {
        title: "SSRF vulnerability in proxy example passes raw user input to got.stream",
        reasoning:
          "got.stream(request.query.url) forwards attacker-controlled input to a server-side request — a classic SSRF.",
        remediation: "Validate and allow-list the target host before calling got.stream.",
      },
      ["docs"],
    );
    expect(c).toBeUndefined();
  });

  it("does NOT cap a version finding with no URL (requests SEC-005)", () => {
    const c = detectGroundingCaveat(
      {
        title: "urllib3 dependency allows urllib3 1.x which lacks critical security fixes",
        reasoning: "The pin urllib3>=1.26,<3 permits the 1.x line.",
        remediation: "Raise the lower bound.",
      },
      ["config"],
    );
    expect(c).toBeUndefined();
  });
});

describe("detectGroundingCaveat — V-004a doc-as-code", () => {
  it("caps ellipsis-placeholder-as-code (got MNT-021)", () => {
    const c = detectGroundingCaveat(
      {
        title: "Code examples use Unicode ellipsis (U+2026) which is invalid JavaScript syntax",
        reasoning:
          "instance(…, {searchParams: undefined}) uses U+2026, which is invalid JavaScript.",
        remediation: "Replace the ellipsis with valid code.",
      },
      ["docs"],
    );
    expect(c?.kind).toBe("doc-as-code");
  });

  it("caps doc snippet judged as non-compiling (cobra DEBT-001)", () => {
    const c = detectGroundingCaveat(
      {
        title:
          "completionCmd.Long uses unresolvable `cmd` variable at package-level initialization",
        reasoning: "`cmd` is undefined at that scope. As written the snippet fails to compile.",
        remediation: "Move the assignment into init().",
      },
      ["docs"],
    );
    expect(c?.kind).toBe("doc-as-code");
  });

  it("does NOT fire doc-as-code on a real source finding with compile words", () => {
    const c = detectGroundingCaveat(
      {
        title: "Type error: value may be undefined",
        reasoning: "This will not compile under strict null checks.",
        remediation: "Add a guard.",
      },
      ["source"],
    );
    expect(c).toBeUndefined();
  });
});

describe("detectGroundingCaveat — V-004b phantom-structure", () => {
  it("caps the 'TypeScript project' hallucination (cobra DEBT-004)", () => {
    const c = detectGroundingCaveat(
      {
        title: "Dependabot configures Go modules instead of npm for a TypeScript project",
        reasoning: "No such file exists in this TypeScript codebase. The correct ecosystem is npm.",
        remediation: "Replace the gomod block with package-ecosystem: npm.",
      },
      ["infra"],
    );
    expect(c?.kind).toBe("phantom-structure");
  });

  it("caps the 'files do not exist' hallucination (cobra DEBT-005)", () => {
    const c = detectGroundingCaveat(
      {
        title: "Labeler globs reference Go/Cobra source files that do not exist in this repo",
        reasoning: "None of these paths correspond to anything in this TypeScript codebase.",
        remediation: "Rewrite labeler.yml to match the actual project structure.",
      },
      ["infra"],
    );
    expect(c?.kind).toBe("phantom-structure");
  });

  it("does NOT cap the legitimate matrix.go config finding (cobra DEBT-002)", () => {
    const c = detectGroundingCaveat(
      {
        title: "test-win cache key references undefined matrix.go variable",
        reasoning:
          "The test-win job has no matrix block, so ${{ matrix.go }} is undefined and the cache key degrades.",
        remediation: "Add a matrix or drop the interpolation.",
      },
      ["infra"],
    );
    expect(c).toBeUndefined();
  });

  it("does NOT fire phantom-structure when evidence includes source", () => {
    const roles: FileRole[] = ["source", "infra"];
    const c = detectGroundingCaveat(
      {
        title: "Config references a file that does not exist",
        reasoning: "This is a TypeScript project and the path is wrong.",
        remediation: "Fix it.",
      },
      roles,
    );
    expect(c).toBeUndefined();
  });
});
