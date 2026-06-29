import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../../src/config/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// A directory with no auditor.toml → pure defaults + overrides.
const NO_TOML_DIR = path.resolve(here, "../fixtures/ts-sample");

describe("config budget guardrails", () => {
  it("ships a default cost and call cap", () => {
    expect(DEFAULT_CONFIG.budget.maxCalls).toBe(60);
    expect(DEFAULT_CONFIG.budget.maxCostUsd).toBe(10);
  });

  it("lets CLI flags override the budget caps", async () => {
    const config = await loadConfig(NO_TOML_DIR, { maxCostUsd: 2.5, maxCalls: 5 });
    expect(config.budget.maxCostUsd).toBe(2.5);
    expect(config.budget.maxCalls).toBe(5);
  });

  it("keeps defaults when no override is given", async () => {
    const config = await loadConfig(NO_TOML_DIR, {});
    expect(config.budget.maxCostUsd).toBe(10);
    expect(config.budget.maxCalls).toBe(60);
  });
});
