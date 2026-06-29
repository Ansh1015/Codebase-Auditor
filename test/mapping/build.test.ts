import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ingestRepo } from "../../src/ingest/ingest.js";
import { buildRepoMap } from "../../src/mapping/build.js";
import { createParser } from "../../src/mapping/parse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PY_FIXTURE = path.resolve(here, "../fixtures/py-sample");

describe("buildRepoMap (python fixture)", () => {
  it("resolves intra-repo import edges", async () => {
    const ingest = await ingestRepo(PY_FIXTURE);
    const map = await buildRepoMap(ingest, createParser());

    const hasEdge = (from: string, to: string) =>
      map.edges.some((e) => e.from === from && e.to === to);

    expect(hasEdge("src/app/main.py", "src/app/utils.py")).toBe(true);
    expect(hasEdge("src/app/main.py", "src/app/services.py")).toBe(true);

    const main = map.files.find((f) => f.path === "src/app/main.py");
    expect(main?.importsResolved).toContain("src/app/utils.py");

    const services = map.files.find((f) => f.path === "src/app/services.py");
    expect(services?.importsExternal).toContain("urllib.request");
  });

  it("clusters files into components and ranks by importance", async () => {
    const ingest = await ingestRepo(PY_FIXTURE);
    const map = await buildRepoMap(ingest, createParser());

    const appComponent = map.components.find((c) => c.id === "src/app");
    expect(appComponent).toBeDefined();
    expect(appComponent?.files).toContain("src/app/services.py");

    // utils.py is imported by main → non-zero importance, should outrank an
    // unimported leaf like untested.py.
    const importanceOf = (p: string) => map.files.find((f) => f.path === p)?.importance ?? 0;
    expect(importanceOf("src/app/utils.py")).toBeGreaterThan(0);

    expect(map.ranked.length).toBe(map.files.length);
    expect(map.stats.preciseFiles).toBe(7); // all 7 .py files parsed precisely
  });
});
