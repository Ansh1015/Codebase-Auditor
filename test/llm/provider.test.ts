import { describe, expect, it } from "vitest";
import { BudgetTracker } from "../../src/llm/budget.js";
import { MockProvider } from "../../src/llm/mock.js";
import { MODEL_IDS, resolveModel } from "../../src/llm/models.js";
import { BudgetExceededError, type CompleteRequest } from "../../src/llm/types.js";

const req = (over: Partial<CompleteRequest> = {}): CompleteRequest => ({
  system: "you are an auditor",
  user: "analyze this",
  tier: "deep",
  ...over,
});

describe("resolveModel", () => {
  it("honours tiers exactly on the api backend", () => {
    expect(resolveModel("triage", "api")).toMatchObject({
      id: MODEL_IDS.haiku,
      substituted: false,
    });
    expect(resolveModel("synthesis", "api")).toMatchObject({
      id: MODEL_IDS.opus,
      substituted: false,
    });
  });

  it("degrades on the subscription backend and flags substitutions", () => {
    // No Haiku on subscription → triage runs on Sonnet (substituted).
    expect(resolveModel("triage", "subscription")).toMatchObject({
      id: MODEL_IDS.sonnet,
      substituted: true,
    });
    // Opus is the canonical synthesis model → not a substitution.
    expect(resolveModel("synthesis", "subscription")).toMatchObject({
      id: MODEL_IDS.opus,
      substituted: false,
    });
  });

  it("respects explicit overrides", () => {
    expect(resolveModel("deep", "api", { deep: "opus" })).toMatchObject({
      id: MODEL_IDS.opus,
    });
  });
});

describe("BudgetTracker", () => {
  it("enforces the call cap before issuing a request", async () => {
    const tracker = new BudgetTracker({ maxCalls: 2 });
    const provider = new MockProvider(() => "ok", tracker);
    await provider.complete(req());
    await provider.complete(req());
    await expect(provider.complete(req())).rejects.toBeInstanceOf(BudgetExceededError);
    expect(tracker.summary().calls).toBe(2);
  });

  it("accumulates usage", async () => {
    const tracker = new BudgetTracker();
    const provider = new MockProvider(() => "response text", tracker);
    await provider.complete(req());
    const s = tracker.summary();
    expect(s.calls).toBe(1);
    expect(s.totalTokens).toBeGreaterThan(0);
  });
});

describe("MockProvider", () => {
  it("captures requests and scripts responses by call index", async () => {
    const provider = new MockProvider((_r, i) => `call-${i}`);
    const a = await provider.complete(req({ user: "first" }));
    const b = await provider.complete(req({ user: "second" }));
    expect(a.text).toBe("call-0");
    expect(b.text).toBe("call-1");
    expect(provider.requests.map((r) => r.user)).toEqual(["first", "second"]);
  });
});
