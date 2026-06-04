import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { FindingCategorySchema, SeveritySchema } from "../types/finding.js";

const RangeSchema = z.object({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive()
});

export const ExpectedFindingSchema = z.object({
  file: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  category: FindingCategorySchema.optional(),
  severity: SeveritySchema.optional(),
  ruleIdIncludes: z.string().optional()
});
export type ExpectedFinding = z.infer<typeof ExpectedFindingSchema>;

export const FixtureSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  category: z.string().default("general"),
  config: z.record(z.unknown()).optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string(),
        changedRanges: z.array(RangeSchema).default([])
      })
    )
    .min(1),
  expected: z.array(ExpectedFindingSchema).default([]),
  expectedNonFindings: z.array(RangeSchema.extend({ file: z.string().min(1) })).default([])
});
export type Fixture = z.infer<typeof FixtureSchema>;

export const DEFAULT_FIXTURE_DIR = join("test", "fixtures", "eval");

/** Parse one fixture JSON document, throwing a clear error on schema failure. */
export function parseFixture(json: string, source: string): Fixture {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`Invalid fixture JSON in ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = FixtureSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid fixture ${source}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

/** Load all `*.json` fixtures from a directory, sorted by name. */
export function loadFixtures(dir: string): Fixture[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    throw new Error(`No eval fixtures found at ${dir}. Pass --dir to point at a fixture directory.`);
  }

  return entries
    .sort()
    .map((name) => parseFixture(readFileSync(join(dir, name), "utf8"), join(dir, name)));
}
