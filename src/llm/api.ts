/**
 * API backend: the Anthropic SDK with an API key. Honours tiers exactly and
 * uses prompt caching on the system block (the repo map / persona is reused
 * across many deep-dive calls).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ModelTier } from "../domain/taxonomy.js";
import type { BudgetTracker } from "./budget.js";
import { type ModelAlias, resolveModel } from "./models.js";
import { isTransientLlmError, retryAfterMsFromError, withRetry } from "./retry.js";
import type { CompleteRequest, CompleteResult, LlmProvider } from "./types.js";

/** Minimal slice of the SDK we depend on — lets tests inject a fake client. */
export type MessagesClient = Pick<Anthropic, "messages">;

// Approx blended $/Mtok by alias, for budget estimation when the SDK doesn't
// return cost. Intentionally rough — caps are guardrails, not billing.
const COST_PER_MTOK: Record<ModelAlias, { in: number; out: number }> = {
  haiku: { in: 1, out: 5 },
  sonnet: { in: 3, out: 15 },
  opus: { in: 15, out: 75 },
};

export interface ApiOptions {
  readonly apiKey: string;
  readonly overrides?: Partial<Record<ModelTier, ModelAlias>>;
  /** Injectable client for tests; defaults to a real SDK instance. */
  readonly client?: MessagesClient;
  /** Total attempts per call including the first. Default 4. */
  readonly maxAttempts?: number;
}

export class ApiProvider implements LlmProvider {
  readonly kind = "api" as const;
  private readonly client: MessagesClient;
  private readonly maxAttempts: number;

  constructor(
    private readonly tracker: BudgetTracker,
    private readonly options: ApiOptions,
  ) {
    // maxRetries: 0 — we own retry/backoff explicitly (see withRetry below) so
    // it is observable, jittered, and honours Retry-After consistently with the
    // subscription backend.
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 0 });
    this.maxAttempts = options.maxAttempts ?? 4;
  }

  describe(): string {
    return "Anthropic API (ANTHROPIC_API_KEY)";
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.tracker.checkBeforeCall();
    const resolved = resolveModel(req.tier, "api", this.options.overrides);

    const message = await withRetry(
      () =>
        this.client.messages.create({
          model: resolved.id,
          max_tokens: req.maxOutputTokens ?? 4096,
          temperature: req.temperature ?? 0,
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: req.user }],
        }),
      {
        maxAttempts: this.maxAttempts,
        isRetryable: isTransientLlmError,
        retryAfterMs: retryAfterMsFromError,
      },
    );

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const cost = COST_PER_MTOK[resolved.alias];
    const result: CompleteResult = {
      text,
      modelUsed: resolved.id,
      tierRequested: req.tier,
      usage: { inputTokens, outputTokens },
      costUsd: (inputTokens * cost.in + outputTokens * cost.out) / 1_000_000,
      substituted: resolved.substituted,
    };
    this.tracker.record(result);
    return result;
  }
}
