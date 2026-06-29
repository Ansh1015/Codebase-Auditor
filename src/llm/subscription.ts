/**
 * Subscription backend: drives the local `claude` CLI in print mode, reusing
 * the user's Claude Code OAuth (Pro/Max) — no API key required. Prompt goes via
 * stdin (no arg-length limit); `--max-turns 1` keeps it a single completion
 * rather than an autonomous agent run.
 */

import { execa } from "execa";
import type { ModelTier } from "../domain/taxonomy.js";
import type { BudgetTracker } from "./budget.js";
import { MODEL_IDS, type ModelAlias, resolveModel } from "./models.js";
import { withRetry } from "./retry.js";
import type { CompleteRequest, CompleteResult, LlmProvider } from "./types.js";

/** Error carrying whether the CLI failure looks worth retrying. */
class CliError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "CliError";
  }
}

const TRANSIENT_PATTERN =
  /overload|rate.?limit|\b429\b|\b50[023]\b|timed?.?out|temporarily|try again|connection|network/i;

function looksTransient(text: string): boolean {
  return TRANSIENT_PATTERN.test(text);
}

function isTransientCliError(err: unknown): boolean {
  return err instanceof CliError && err.transient;
}

interface ClaudeCliResult {
  readonly type: string;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly total_cost_usd?: number;
  readonly usage?: { input_tokens?: number; output_tokens?: number };
  readonly modelUsage?: Record<string, unknown>;
}

export interface SubscriptionOptions {
  readonly bin?: string;
  readonly overrides?: Partial<Record<ModelTier, ModelAlias>>;
  readonly timeoutMs?: number;
  /** Total attempts per call including the first. Default 4. */
  readonly maxAttempts?: number;
}

export class SubscriptionProvider implements LlmProvider {
  readonly kind = "subscription" as const;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly tracker: BudgetTracker,
    private readonly options: SubscriptionOptions = {},
  ) {
    this.bin = options.bin ?? "claude";
    this.timeoutMs = options.timeoutMs ?? 240_000;
    this.maxAttempts = options.maxAttempts ?? 4;
  }

  describe(): string {
    return "Claude Code subscription (claude CLI, OAuth — Pro/Max)";
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.tracker.checkBeforeCall();
    const resolved = resolveModel(req.tier, "subscription", this.options.overrides);
    try {
      return await this.call(req, resolved.alias, resolved.substituted);
    } catch (err) {
      // Opus may be unavailable on a Pro plan — degrade to Sonnet once.
      if (resolved.alias === "opus") {
        return this.call(req, "sonnet", true);
      }
      throw err;
    }
  }

  private async call(
    req: CompleteRequest,
    alias: ModelAlias,
    substituted: boolean,
  ): Promise<CompleteResult> {
    // Transient CLI failures (overload, rate-limit, timeout, network) retry with
    // backoff; a non-transient failure (e.g. Opus unavailable on Pro) propagates
    // to complete()'s one-shot degradation to Sonnet.
    return withRetry(() => this.invoke(req, alias, substituted), {
      maxAttempts: this.maxAttempts,
      isRetryable: isTransientCliError,
    });
  }

  private async invoke(
    req: CompleteRequest,
    alias: ModelAlias,
    substituted: boolean,
  ): Promise<CompleteResult> {
    const prompt = `${req.system}\n\n=== TASK INPUT ===\n${req.user}`;
    const { stdout, exitCode, timedOut } = await execa(
      this.bin,
      // `--tools ""` disables Claude Code's agent tools so it acts as a pure
      // completion engine (no file edits / bash), matching the api backend.
      ["-p", "--output-format", "json", "--model", alias, "--max-turns", "1", "--tools", ""],
      { input: prompt, reject: false, timeout: this.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
    );
    if (timedOut) {
      throw new CliError(`claude CLI timed out after ${this.timeoutMs}ms`, true);
    }
    if (exitCode !== 0) {
      const tail = stdout.slice(0, 400);
      throw new CliError(`claude CLI exited ${exitCode}: ${tail}`, looksTransient(tail));
    }
    let parsed: ClaudeCliResult;
    try {
      parsed = JSON.parse(stdout) as ClaudeCliResult;
    } catch {
      throw new CliError(`claude CLI returned non-JSON: ${stdout.slice(0, 400)}`, false);
    }
    if (parsed.is_error || typeof parsed.result !== "string") {
      const tail = stdout.slice(0, 400);
      throw new CliError(`claude CLI error: ${tail}`, looksTransient(tail));
    }

    const modelUsed = Object.keys(parsed.modelUsage ?? {})[0] ?? MODEL_IDS[alias];
    const result: CompleteResult = {
      text: parsed.result,
      modelUsed,
      tierRequested: req.tier,
      usage: {
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
      },
      costUsd: parsed.total_cost_usd ?? 0,
      substituted,
    };
    this.tracker.record(result);
    return result;
  }
}
