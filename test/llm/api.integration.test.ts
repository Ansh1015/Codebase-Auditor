/**
 * Live api-backend smoke test. Skipped unless ANTHROPIC_API_KEY is set, so it is
 * free in CI/dev but provides real end-to-end proof when a key is present:
 *
 *   ANTHROPIC_API_KEY=sk-... npm test -- api.integration
 */
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../src/llm/api.js";
import { BudgetTracker } from "../../src/llm/budget.js";

const KEY = process.env.ANTHROPIC_API_KEY;
const live = KEY ? describe : describe.skip;

live("ApiProvider (live)", () => {
  it("completes a minimal real call and records usage", async () => {
    const tracker = new BudgetTracker({ maxCalls: 1, maxCostUsd: 0.5 });
    const provider = new ApiProvider(tracker, { apiKey: KEY as string });

    const res = await provider.complete({
      system: "You are a test probe. Reply with exactly the word: PONG.",
      user: "ping",
      tier: "triage",
      maxOutputTokens: 16,
    });

    expect(res.text.trim().length).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
    expect(tracker.summary().calls).toBe(1);
  }, 30_000);
});
