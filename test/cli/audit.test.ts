import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAuditCli } from "../../src/cli/audit.js";
import { DEFAULT_CONFIG } from "../../src/config/config.js";

const created: string[] = [];

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "auditor-test-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("runAuditCli on degenerate repos", () => {
  it("short-circuits an empty repo without creating a provider", async () => {
    const repo = await tmp();
    const out = await tmp();

    // No ANTHROPIC_API_KEY and no provider call should be required here: an empty
    // repo must resolve cleanly to "nothing to audit".
    const result = await runAuditCli(repo, { ...DEFAULT_CONFIG, out }, () => {});

    expect(result.analyzed).toBe(false);
    expect(result.findingCount).toBe(0);

    const json = JSON.parse(await readFile(path.join(out, "findings.json"), "utf8"));
    expect(json.findings).toEqual([]);
    const manifest = JSON.parse(await readFile(path.join(out, "run-manifest.json"), "utf8"));
    expect(manifest.findingCount).toBe(0);
  });

  it("treats a binary-only repo as no analyzable source", async () => {
    const repo = await tmp();
    const out = await tmp();
    await writeFile(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 0, 3, 0]));

    const result = await runAuditCli(repo, { ...DEFAULT_CONFIG, out }, () => {});
    expect(result.analyzed).toBe(false);
  });
});
