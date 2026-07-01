/**
 * Patch generation + verification orchestration.
 *
 * The model returns the COMPLETE corrected file (not a diff) — far more reliable
 * than asking for unified-diff syntax — and we compute the diff ourselves. Each
 * candidate is then syntax-checked and, if a verify command is configured, run
 * in an isolated copy of the repo before being labelled verified.
 */

import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { execa } from "execa";
import { z } from "zod";
import type { ProposedPatch } from "../domain/finding.js";
import { extractJson } from "../findings/ground.js";
import type { IngestedFile } from "../ingest/ingest.js";
import { languageOf } from "../ingest/language.js";
import type { LlmProvider } from "../llm/types.js";
import type { RepoParser } from "../mapping/parse.js";
import type { PatchCandidate } from "./select.js";
import { type CommandOutcome, decideStatus } from "./verify.js";

const PATCH_SYSTEM = `You are a precise senior engineer producing a MINIMAL, conservative, behaviour-preserving fix for exactly ONE issue.

Output ONLY a single JSON object:
{ "action": "patch", "newContent": "<the COMPLETE corrected file contents>" }
or
{ "action": "skip", "reason": "why a safe localized fix is not possible" }

RULES:
- newContent MUST be the entire file, not a diff and not a fragment.
- Change only what is necessary to fix the described issue. Do NOT reformat or refactor unrelated code.
- Preserve all existing behaviour except the specific defect.
- If the fix would require touching other files or is structurally risky, choose "skip".`;

const patchSchema = z.object({
  action: z.enum(["patch", "skip"]),
  newContent: z.string().optional(),
  reason: z.string().optional(),
});

export interface PatchRunOptions {
  readonly maxPatches: number;
  readonly verifyCommand?: string;
  readonly repoRoot: string;
}

function contentMap(files: readonly IngestedFile[]): Map<string, string> {
  return new Map(files.map((f) => [f.path as string, f.content]));
}

async function generateNewContent(
  provider: LlmProvider,
  candidate: PatchCandidate,
  content: string,
): Promise<string | null> {
  const f = candidate.finding;
  const res = await provider.complete({
    system: PATCH_SYSTEM,
    user: [
      `Issue (${f.id}, ${f.severity} ${f.category}): ${f.title}`,
      `Reasoning: ${f.reasoning}`,
      `Recommended fix: ${f.remediation}`,
      ``,
      `FILE: ${candidate.path}`,
      content,
    ].join("\n"),
    tier: "patch",
    maxOutputTokens: 4096,
  });
  const parsed = patchSchema.safeParse(extractJson(res.text));
  if (!parsed.success || parsed.data.action !== "patch") return null;
  const next = parsed.data.newContent;
  if (!next || next.trim() === content.trim()) return null;
  return next;
}

async function runVerifyCommand(
  repoRoot: string,
  relPath: string,
  newContent: string,
  command: string,
): Promise<CommandOutcome> {
  const tmp = await mkdtemp(path.join(tmpdir(), "auditor-verify-"));
  try {
    await cp(repoRoot, tmp, {
      recursive: true,
      filter: (src) => !/[\\/](\.git|node_modules|\.venv|dist|build)([\\/]|$)/.test(src),
    });
    await writeFile(path.join(tmp, relPath), newContent, "utf8");
    const { exitCode, stdout, stderr } = await execa(command, {
      cwd: tmp,
      shell: true,
      reject: false,
      timeout: 180_000,
    });
    return {
      ran: true,
      passed: exitCode === 0,
      ...(exitCode === 0 ? {} : { detail: (stderr || stdout).slice(0, 200) }),
    };
  } catch (err) {
    return { ran: true, passed: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function generatePatches(
  provider: LlmProvider,
  parser: RepoParser,
  files: readonly IngestedFile[],
  candidates: readonly PatchCandidate[],
  opts: PatchRunOptions,
): Promise<ProposedPatch[]> {
  const contents = contentMap(files);
  const patches: ProposedPatch[] = [];

  for (const candidate of candidates.slice(0, opts.maxPatches)) {
    const relPath = candidate.path as string;
    const content = contents.get(relPath);
    if (content === undefined) continue;

    // Per-candidate isolation: one patch's LLM error/timeout, failed syntax check,
    // or verify-command blow-up must never abort the batch (and thereby the whole
    // audit). A failed candidate is simply skipped; the rest still generate.
    try {
      const newContent = await generateNewContent(provider, candidate, content);
      if (newContent === null) continue;

      const diff = createTwoFilesPatch(relPath, relPath, content, newContent, "before", "after");
      const lang = languageOf(relPath);
      const syntax = await parser.checkSyntax(newContent, lang);

      let command: CommandOutcome | undefined;
      if (syntax !== "error" && opts.verifyCommand) {
        command = await runVerifyCommand(opts.repoRoot, relPath, newContent, opts.verifyCommand);
      }

      patches.push({
        findingId: candidate.finding.id,
        filename: `${candidate.finding.id}.patch`,
        diff,
        status: decideStatus(syntax, command),
      });
    } catch {
      // Best-effort: skip this candidate and continue with the others.
    }
  }

  return patches;
}
