/**
 * Hard budget guardrails. Checked before every call so a runaway audit fails
 * loudly (and resumably, via the cache) instead of silently draining tokens or
 * a subscription's usage window.
 */

import { BudgetExceededError, type CompleteResult } from "./types.js";

export interface BudgetCaps {
  readonly maxTotalTokens?: number;
  readonly maxCostUsd?: number;
  readonly maxCalls?: number;
}

export interface BudgetSummary {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly substitutions: number;
}

export class BudgetTracker {
  private calls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;
  private substitutions = 0;

  constructor(private readonly caps: BudgetCaps = {}) {}

  /** Throws if a cap is already met. Call immediately before issuing a request. */
  checkBeforeCall(): void {
    const { maxCalls, maxTotalTokens, maxCostUsd } = this.caps;
    if (maxCalls !== undefined && this.calls >= maxCalls) {
      throw new BudgetExceededError(`call cap reached (${maxCalls})`);
    }
    if (maxTotalTokens !== undefined && this.totalTokens() >= maxTotalTokens) {
      throw new BudgetExceededError(`token cap reached (${maxTotalTokens})`);
    }
    if (maxCostUsd !== undefined && this.costUsd >= maxCostUsd) {
      throw new BudgetExceededError(`cost cap reached ($${maxCostUsd})`);
    }
  }

  record(result: CompleteResult): void {
    this.calls += 1;
    this.inputTokens += result.usage.inputTokens;
    this.outputTokens += result.usage.outputTokens;
    this.costUsd += result.costUsd ?? 0;
    if (result.substituted) this.substitutions += 1;
  }

  totalTokens(): number {
    return this.inputTokens + this.outputTokens;
  }

  summary(): BudgetSummary {
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.totalTokens(),
      costUsd: Math.round(this.costUsd * 1e6) / 1e6,
      substitutions: this.substitutions,
    };
  }
}
