import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type IngestedFile, ingestRepo } from "../../src/ingest/ingest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PY_FIXTURE = path.resolve(here, "../fixtures/py-sample");

function byPath(files: readonly IngestedFile[], rel: string): IngestedFile | undefined {
  return files.find((f) => f.path === rel);
}

describe("ingestRepo (python fixture)", () => {
  it("ingests source/test files and excludes junk", async () => {
    const { files, stats } = await ingestRepo(PY_FIXTURE);
    const paths = files.map((f) => f.path);

    // Source + test are present.
    expect(paths).toContain("src/app/services.py");
    expect(paths).toContain("src/app/main.py");
    expect(paths).toContain("tests/test_main.py");

    // Junk is excluded.
    expect(paths).not.toContain("node_modules/junk/index.js");
    expect(paths).not.toContain("package-lock.json");
    expect(paths).not.toContain("data/blob.bin");
    expect(paths).not.toContain("secret_ignored.py");

    expect(stats.skippedBinary).toBe(1); // blob.bin
    expect(stats.ingested).toBe(files.length);
  });

  it("classifies file roles correctly", async () => {
    const { files } = await ingestRepo(PY_FIXTURE);
    expect(byPath(files, "src/app/services.py")?.role).toBe("source");
    expect(byPath(files, "tests/test_main.py")?.role).toBe("test");
    expect(byPath(files, "pyproject.toml")?.role).toBe("config");
    expect(byPath(files, "README.md")?.role).toBe("docs");
    expect(byPath(files, "Dockerfile")?.role).toBe("infra");
    expect(byPath(files, ".github/workflows/ci.yml")?.role).toBe("infra");
  });

  it("detects language and reads content + line counts", async () => {
    const { files } = await ingestRepo(PY_FIXTURE);
    const services = byPath(files, "src/app/services.py");
    expect(services?.language).toBe("python");
    expect(services?.content).toContain("STRIPE_API_KEY");
    expect(services?.lineCount ?? 0).toBeGreaterThan(10);
  });
});
