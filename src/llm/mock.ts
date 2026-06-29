/**
 * Deterministic in-memory provider for tests (and a possible `--dry-run`). Lets
 * us exercise prompt assembly, the read loop, budget tracking, and response
 * parsing with zero quota cost and zero flakiness.
 */

import type { BudgetTracker } from "./budget.js";
import type { CompleteRequest, CompleteResult, LlmProvider } from "./types.js";

export type MockResponder = (req: CompleteRequest, callIndex: number) => string;

export class MockProvider implements LlmProvider {
  readonly kind = "api" as const;
  readonly requests: CompleteRequest[] = [];
  private callIndex = 0;

  constructor(
    private readonly responder: MockResponder,
    private readonly tracker?: BudgetTracker,
  ) {}

  describe(): string {
    return "MockProvider (test)";
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.tracker?.checkBeforeCall();
    this.requests.push(req);
    const text = this.responder(req, this.callIndex++);
    const result: CompleteResult = {
      text,
      modelUsed: `mock-${req.tier}`,
      tierRequested: req.tier,
      usage: { inputTokens: req.user.length >> 2, outputTokens: text.length >> 2 },
      costUsd: 0,
      substituted: false,
    };
    this.tracker?.record(result);
    return result;
  }
}
