/**
 * Logical tier → concrete model resolution.
 *
 * The api backend honours tiers exactly. The subscription backend can't select
 * Haiku and only reaches Opus on Max plans, so it degrades: Haiku→Sonnet, and
 * Opus→Sonnet is handled at call time on failure (see subscription.ts). Every
 * substitution is recorded so the run manifest is honest about what ran.
 */

import type { ModelTier } from "../domain/taxonomy.js";

export const MODEL_IDS = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
} as const;
export type ModelAlias = keyof typeof MODEL_IDS;

const API_TIER_MODEL: Readonly<Record<ModelTier, ModelAlias>> = {
  triage: "haiku",
  deep: "sonnet",
  synthesis: "opus",
  patch: "sonnet",
};

/** Subscription default: no Haiku; Opus only attempted for synthesis. */
const SUBSCRIPTION_TIER_MODEL: Readonly<Record<ModelTier, ModelAlias>> = {
  triage: "sonnet",
  deep: "sonnet",
  synthesis: "opus",
  patch: "sonnet",
};

export interface ResolvedModel {
  readonly alias: ModelAlias;
  readonly id: string;
  /** True when this differs from the api-canonical tier model. */
  readonly substituted: boolean;
}

export function resolveModel(
  tier: ModelTier,
  kind: "api" | "subscription",
  overrides?: Partial<Record<ModelTier, ModelAlias>>,
): ResolvedModel {
  const canonical = API_TIER_MODEL[tier];
  const table = kind === "api" ? API_TIER_MODEL : SUBSCRIPTION_TIER_MODEL;
  const alias = overrides?.[tier] ?? table[tier];
  return { alias, id: MODEL_IDS[alias], substituted: alias !== canonical };
}
