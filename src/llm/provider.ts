/**
 * Provider factory with auto-detection.
 *
 * auto: ANTHROPIC_API_KEY present → api; else an authenticated `claude` CLI →
 * subscription; else a friendly error telling the user how to enable one.
 */

import { execa } from "execa";
import type { ModelTier, ProviderKind } from "../domain/taxonomy.js";
import { ApiProvider } from "./api.js";
import type { BudgetTracker } from "./budget.js";
import type { ModelAlias } from "./models.js";
import { SubscriptionProvider } from "./subscription.js";
import { type LlmProvider, ProviderUnavailableError } from "./types.js";

export interface ProviderConfig {
  readonly kind: ProviderKind;
  readonly tracker: BudgetTracker;
  readonly overrides?: Partial<Record<ModelTier, ModelAlias>>;
  readonly apiKey?: string;
  readonly claudeBin?: string;
}

async function claudeAvailable(bin: string): Promise<boolean> {
  try {
    const { exitCode } = await execa(bin, ["--version"], { reject: false, timeout: 15_000 });
    return exitCode === 0;
  } catch {
    return false;
  }
}

export async function createProvider(config: ProviderConfig): Promise<LlmProvider> {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const bin = config.claudeBin ?? "claude";

  const overridesOpt = config.overrides ? { overrides: config.overrides } : {};

  const makeApi = () => {
    if (!apiKey) {
      throw new ProviderUnavailableError("provider 'api' requires ANTHROPIC_API_KEY to be set.");
    }
    return new ApiProvider(config.tracker, { apiKey, ...overridesOpt });
  };

  const makeSubscription = async () => {
    if (!(await claudeAvailable(bin))) {
      throw new ProviderUnavailableError(
        "provider 'subscription' requires the `claude` CLI (logged in via Pro/Max).",
      );
    }
    return new SubscriptionProvider(config.tracker, { bin, ...overridesOpt });
  };

  switch (config.kind) {
    case "api":
      return makeApi();
    case "subscription":
      return makeSubscription();
    case "auto": {
      if (apiKey) return makeApi();
      if (await claudeAvailable(bin)) return makeSubscription();
      throw new ProviderUnavailableError(
        "No LLM provider available. Set ANTHROPIC_API_KEY, or install and log in to " +
          "the `claude` CLI (Pro/Max), then re-run.",
      );
    }
  }
}
