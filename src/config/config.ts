/**
 * Zero-config defaults, overlaid by auditor.toml, overlaid by CLI flags.
 * Precedence: CLI > auditor.toml > defaults.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ProviderKind, Severity } from "../domain/taxonomy.js";
import { SEVERITIES } from "../domain/taxonomy.js";
import type { BudgetCaps } from "../llm/budget.js";
import { type AuditOptions, DEFAULT_AUDIT_OPTIONS } from "../passes/run.js";

export interface AuditorConfig {
  provider: ProviderKind;
  out: string;
  cache: boolean;
  apply: boolean;
  patches: boolean;
  severityThreshold: Severity;
  audit: AuditOptions;
  budget: BudgetCaps;
  verifyCommand?: string;
}

export const DEFAULT_CONFIG: AuditorConfig = {
  provider: "auto",
  out: "audit-output",
  cache: true,
  apply: false,
  patches: true,
  severityThreshold: "info",
  audit: DEFAULT_AUDIT_OPTIONS,
  // Safety net for `npx auditor ./repo`: cap calls and spend so a large or
  // pathological repo can't run away with a bill. Both are overridable via
  // auditor.toml ([budget]) or CLI (--max-calls / --max-cost).
  budget: { maxCalls: 60, maxCostUsd: 10 },
};

function isSeverity(v: unknown): v is Severity {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Overlay a parsed auditor.toml (best-effort; unknown keys ignored). */
function overlayToml(base: AuditorConfig, toml: Record<string, unknown>): AuditorConfig {
  const budgetToml = (toml.budget ?? {}) as Record<string, unknown>;
  const auditToml = (toml.audit ?? {}) as Record<string, unknown>;

  const budget: BudgetCaps = {
    ...base.budget,
    ...(num(budgetToml.max_calls) !== undefined
      ? { maxCalls: num(budgetToml.max_calls) as number }
      : {}),
    ...(num(budgetToml.max_cost_usd) !== undefined
      ? { maxCostUsd: num(budgetToml.max_cost_usd) as number }
      : {}),
    ...(num(budgetToml.max_total_tokens) !== undefined
      ? { maxTotalTokens: num(budgetToml.max_total_tokens) as number }
      : {}),
  };

  const audit: AuditOptions = {
    ...base.audit,
    ...(num(auditToml.max_components) !== undefined
      ? { maxComponents: num(auditToml.max_components) as number }
      : {}),
    ...(num(auditToml.concurrency) !== undefined
      ? { concurrency: num(auditToml.concurrency) as number }
      : {}),
    ...(typeof auditToml.cross_cut === "boolean" ? { crossCut: auditToml.cross_cut } : {}),
  };

  return {
    ...base,
    budget,
    audit,
    ...(typeof toml.provider === "string" ? { provider: toml.provider as ProviderKind } : {}),
    ...(typeof toml.out === "string" ? { out: toml.out } : {}),
    ...(typeof toml.cache === "boolean" ? { cache: toml.cache } : {}),
    ...(typeof toml.patches === "boolean" ? { patches: toml.patches } : {}),
    ...(isSeverity(toml.severity_threshold) ? { severityThreshold: toml.severity_threshold } : {}),
    ...(typeof toml.verify_command === "string" ? { verifyCommand: toml.verify_command } : {}),
  };
}

export interface CliOverrides {
  provider?: ProviderKind;
  out?: string;
  cache?: boolean;
  apply?: boolean;
  patches?: boolean;
  severityThreshold?: Severity;
  crossCut?: boolean;
  concurrency?: number;
  maxComponents?: number;
  maxCostUsd?: number;
  maxCalls?: number;
  verifyCommand?: string;
}

export async function loadConfig(
  cwd: string,
  overrides: CliOverrides = {},
  configPath?: string,
): Promise<AuditorConfig> {
  let config = DEFAULT_CONFIG;

  const tomlPath = configPath ?? path.join(cwd, "auditor.toml");
  const raw = await readFile(tomlPath, "utf8").catch(() => null);
  if (raw) {
    try {
      config = overlayToml(config, parseToml(raw) as Record<string, unknown>);
    } catch {
      // malformed toml → ignore, keep defaults
    }
  }

  // CLI wins.
  const audit: AuditOptions = {
    ...config.audit,
    ...(overrides.crossCut !== undefined ? { crossCut: overrides.crossCut } : {}),
    ...(overrides.concurrency !== undefined ? { concurrency: overrides.concurrency } : {}),
    ...(overrides.maxComponents !== undefined ? { maxComponents: overrides.maxComponents } : {}),
  };

  const budget: BudgetCaps = {
    ...config.budget,
    ...(overrides.maxCostUsd !== undefined ? { maxCostUsd: overrides.maxCostUsd } : {}),
    ...(overrides.maxCalls !== undefined ? { maxCalls: overrides.maxCalls } : {}),
  };

  return {
    ...config,
    audit,
    budget,
    ...(overrides.provider !== undefined ? { provider: overrides.provider } : {}),
    ...(overrides.out !== undefined ? { out: overrides.out } : {}),
    ...(overrides.cache !== undefined ? { cache: overrides.cache } : {}),
    ...(overrides.apply !== undefined ? { apply: overrides.apply } : {}),
    ...(overrides.patches !== undefined ? { patches: overrides.patches } : {}),
    ...(overrides.severityThreshold !== undefined
      ? { severityThreshold: overrides.severityThreshold }
      : {}),
    ...(overrides.verifyCommand !== undefined ? { verifyCommand: overrides.verifyCommand } : {}),
  };
}
