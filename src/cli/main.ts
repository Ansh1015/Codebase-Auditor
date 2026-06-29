#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { type CliOverrides, loadConfig } from "../config/config.js";
import type { ProviderKind, Severity } from "../domain/taxonomy.js";
import { VERSION } from "../index.js";
import { BudgetExceededError, ProviderUnavailableError } from "../llm/types.js";
import { runAuditCli } from "./audit.js";
import { TargetError } from "./target.js";

interface RawOpts {
  out?: string;
  provider: ProviderKind;
  cache: boolean;
  patches: boolean;
  apply?: boolean;
  crossCut: boolean;
  concurrency?: string;
  maxComponents?: string;
  maxCost?: string;
  maxCalls?: string;
  severityThreshold?: Severity;
  config?: string;
  verifyCommand?: string;
}

const program = new Command();

program
  .name("auditor")
  .description("Autonomous AI Codebase Auditor — reviews any Git repo like a Staff Engineer.")
  .version(VERSION);

program
  .argument("[target]", "path to a local repo or a Git URL to audit")
  .option("-o, --out <dir>", "output directory")
  .option("--provider <kind>", "llm provider: auto | api | subscription", "auto")
  .option("--no-cache", "disable the content-addressed cache")
  .option("--no-patches", "skip machine-generated patch proposals")
  .option("--apply", "apply verified patches to the working tree")
  .option("--no-cross-cut", "skip the holistic cross-cutting pass")
  .option("--concurrency <n>", "parallel deep-dives")
  .option("--max-components <n>", "cap the number of components deep-dived")
  .option("--max-cost <usd>", "abort once estimated spend exceeds this many USD")
  .option("--max-calls <n>", "abort once this many provider calls are made")
  .option("--severity-threshold <s>", "minimum severity to report (critical|high|medium|low|info)")
  .option("--verify-command <cmd>", "command used to verify generated patches")
  .option("--config <path>", "path to auditor.toml")
  .action(async (target: string | undefined, opts: RawOpts) => {
    if (!target) {
      program.help();
      return;
    }

    const overrides: CliOverrides = {
      provider: opts.provider,
      cache: opts.cache,
      patches: opts.patches,
      crossCut: opts.crossCut,
      ...(opts.out ? { out: opts.out } : {}),
      ...(opts.apply ? { apply: opts.apply } : {}),
      ...(opts.concurrency ? { concurrency: Number(opts.concurrency) } : {}),
      ...(opts.maxComponents ? { maxComponents: Number(opts.maxComponents) } : {}),
      ...(opts.maxCost ? { maxCostUsd: Number(opts.maxCost) } : {}),
      ...(opts.maxCalls ? { maxCalls: Number(opts.maxCalls) } : {}),
      ...(opts.severityThreshold ? { severityThreshold: opts.severityThreshold } : {}),
      ...(opts.verifyCommand ? { verifyCommand: opts.verifyCommand } : {}),
    };

    const config = await loadConfig(process.cwd(), overrides, opts.config);

    const start = Date.now();
    const result = await runAuditCli(target, config);
    const secs = ((Date.now() - start) / 1000).toFixed(1);

    const rel = path.relative(process.cwd(), result.outDir) || result.outDir;
    console.log("");
    if (!result.analyzed) {
      console.log(pc.bold("No analyzable source found — nothing to audit."));
      console.log(pc.dim("  (empty, binary-only, or fully ignored repository)"));
      console.log(`  Report:       ${path.join(rel, "report.md")}`);
      return;
    }

    const patchCount = result.report.patches.filter((p) => p.status.kind !== "rejected").length;
    const { costUsd, calls } = result.report.budget;
    console.log(pc.bold(`Audit complete in ${secs}s`));
    console.log(`  Health score: ${pc.bold(`${result.score}/100`)}`);
    console.log(`  Findings:     ${result.findingCount}`);
    if (patchCount > 0) console.log(`  Patches:      ${patchCount}`);
    console.log(`  Cost:         ~$${costUsd.toFixed(4)} (${calls} calls)`);
    console.log(`  Report:       ${path.join(rel, "report.md")}`);
    console.log(`  JSON:         ${path.join(rel, "findings.json")}`);
  });

// Exit-code contract: 0 ok · 1 unexpected · 2 bad target · 3 no provider · 4 budget.
program.parseAsync().catch((err: unknown) => {
  if (err instanceof TargetError) {
    console.error(pc.red(`auditor: ${err.message}`));
    process.exitCode = 2;
  } else if (err instanceof ProviderUnavailableError) {
    console.error(pc.red(`auditor: ${err.message}`));
    process.exitCode = 3;
  } else if (err instanceof BudgetExceededError) {
    console.error(pc.yellow(`auditor: budget cap reached — ${err.message}.`));
    console.error(
      pc.dim(
        "  Completed calls are cached; raise the cap with --max-cost / --max-calls and re-run (cached calls are free).",
      ),
    );
    process.exitCode = 4;
  } else {
    console.error(pc.red(`auditor: ${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 1;
  }
});
