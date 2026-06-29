/**
 * Provider-agnostic LLM interface. A single-turn `complete()` is the whole
 * surface: the bounded "agentic reading" loop is orchestrated by the passes
 * layer (one complete() per round), so the api and subscription backends behave
 * identically. Native tool-use, if ever added, is an api-only optimization that
 * lives behind this same interface.
 */

import type { ModelTier, ProviderKind } from "../domain/taxonomy.js";

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CompleteRequest {
  /** System / persona + output-contract instructions. */
  readonly system: string;
  /** The task + inlined context. */
  readonly user: string;
  readonly tier: ModelTier;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
}

export interface CompleteResult {
  readonly text: string;
  readonly modelUsed: string;
  readonly tierRequested: ModelTier;
  readonly usage: Usage;
  readonly costUsd?: number;
  /** Set when the resolved model differs from the tier's default (degradation). */
  readonly substituted?: boolean;
}

export interface LlmProvider {
  readonly kind: Exclude<ProviderKind, "auto">;
  /** Human-readable description for the run manifest. */
  describe(): string;
  complete(req: CompleteRequest): Promise<CompleteResult>;
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}
