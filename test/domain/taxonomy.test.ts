import { describe, expect, it } from "vitest";
import {
  SEVERITIES,
  SEVERITY_RANK,
  type Severity,
  assertNever,
  confidenceLevel,
} from "../../src/domain/taxonomy.js";

describe("confidenceLevel", () => {
  it("maps scores to coarse levels at the documented thresholds", () => {
    expect(confidenceLevel(0.9)).toBe("high");
    expect(confidenceLevel(0.75)).toBe("high");
    expect(confidenceLevel(0.6)).toBe("medium");
    expect(confidenceLevel(0.45)).toBe("medium");
    expect(confidenceLevel(0.2)).toBe("low");
    expect(confidenceLevel(0)).toBe("low");
  });
});

describe("SEVERITY_RANK", () => {
  it("orders severities monotonically", () => {
    const ordered = [...SEVERITIES].sort((a, b) => SEVERITY_RANK[b] - SEVERITY_RANK[a]);
    expect(ordered).toEqual(["critical", "high", "medium", "low", "info"]);
  });

  it("has a rank for every severity", () => {
    for (const s of SEVERITIES) {
      expect(typeof SEVERITY_RANK[s]).toBe("number");
    }
  });
});

describe("assertNever", () => {
  it("throws on an unexpected variant", () => {
    const rogue = "purple" as unknown as never;
    expect(() => assertNever(rogue)).toThrow();
  });

  it("is reachable only when a switch is non-exhaustive", () => {
    // Compile-time proof: this switch covers all Severity members, so the
    // default branch's assertNever call typechecks (value is `never`).
    const classify = (s: Severity): string => {
      switch (s) {
        case "critical":
        case "high":
          return "act now";
        case "medium":
        case "low":
          return "soon";
        case "info":
          return "fyi";
        default:
          return assertNever(s);
      }
    };
    expect(classify("critical")).toBe("act now");
    expect(classify("info")).toBe("fyi");
  });
});
