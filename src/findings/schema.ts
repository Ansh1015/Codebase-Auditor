/**
 * Zod schemas for what the model emits (RawFinding). Validation at this boundary
 * means a malformed/partial model response degrades to "skip that finding"
 * rather than crashing the audit or producing a half-typed Finding.
 */

import { z } from "zod";
import type { Category, Effort, Severity } from "../domain/taxonomy.js";
import { CATEGORIES, EFFORTS, SEVERITIES } from "../domain/taxonomy.js";

const categoryEnum = z.enum(CATEGORIES as unknown as [Category, ...Category[]]);
const severityEnum = z.enum(SEVERITIES as unknown as [Severity, ...Severity[]]);
const effortEnum = z.enum(EFFORTS as unknown as [Effort, ...Effort[]]);

export const rawEvidenceSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
});

export const rawFindingSchema = z.object({
  title: z.string().min(1).max(200),
  category: categoryEnum,
  severity: severityEnum,
  /** 0–1 self-assessed confidence. */
  confidenceScore: z.number().min(0).max(1),
  impactRationale: z.string().min(1),
  effort: effortEnum,
  affectedFiles: z.array(rawEvidenceSchema).default([]),
  affectedComponents: z.array(z.string()).default([]),
  reasoning: z.string().min(1),
  remediation: z.string().min(1),
});

export type RawFinding = z.infer<typeof rawFindingSchema>;

export const findingsEnvelopeSchema = z.object({
  findings: z.array(z.unknown()).default([]),
});
