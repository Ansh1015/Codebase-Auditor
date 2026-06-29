/** Cheap, language-agnostic code metrics. Deliberately approximate. */

import { execa } from "execa";

const DECISION_RE = /\b(if|elif|else\s+if|for|while|case|catch|except|when)\b|&&|\|\||\?\s*[^.:]/g;

/** Cyclomatic-ish: 1 + number of decision points. Good enough for ranking. */
export function estimateComplexity(content: string): number {
  const matches = content.match(DECISION_RE);
  return 1 + (matches ? matches.length : 0);
}

/**
 * One git call for the whole repo; tally commits per path. Returns an empty map
 * when the target isn't a git repo (churn then contributes 0 to ranking).
 */
export async function gitChurn(root: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const { stdout, exitCode } = await execa(
      "git",
      ["-C", root, "log", "--all", "--pretty=format:", "--name-only"],
      { reject: false },
    );
    if (exitCode !== 0) return counts;
    for (const line of stdout.split("\n")) {
      const path = line.trim();
      if (path.length === 0) continue;
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  } catch {
    // git missing → no churn signal
  }
  return counts;
}
