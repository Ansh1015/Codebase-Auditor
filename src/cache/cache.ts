/**
 * Content-addressed LLM response cache. Wraps any provider; a cache hit returns
 * the stored result without touching the inner provider or the budget — so a
 * crash, a formatting tweak, or a rate-limited run resumes for free. Keyed on a
 * hash of (provider kind, tier, system, user, output cap) so it's always correct:
 * change the inputs → cache miss → re-analyze.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CompleteRequest, CompleteResult, LlmProvider } from "../llm/types.js";

function keyFor(kind: string, req: CompleteRequest): string {
  const material = JSON.stringify({
    kind,
    tier: req.tier,
    system: req.system,
    user: req.user,
    max: req.maxOutputTokens ?? null,
    temp: req.temperature ?? null,
  });
  return createHash("sha256").update(material).digest("hex");
}

export class CachingProvider implements LlmProvider {
  readonly kind: LlmProvider["kind"];

  constructor(
    private readonly inner: LlmProvider,
    private readonly dir: string,
  ) {
    this.kind = inner.kind;
  }

  describe(): string {
    return `${this.inner.describe()} (cached)`;
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const file = path.join(this.dir, `${keyFor(this.inner.kind, req)}.json`);

    const hit = await readFile(file, "utf8").catch(() => null);
    if (hit) {
      try {
        return JSON.parse(hit) as CompleteResult;
      } catch {
        // corrupt cache entry → fall through and recompute
      }
    }

    const result = await this.inner.complete(req);
    await mkdir(this.dir, { recursive: true });
    await writeFile(file, JSON.stringify(result), "utf8").catch(() => {});
    return result;
  }
}
