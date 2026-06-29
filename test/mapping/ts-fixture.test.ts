import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ingestRepo } from "../../src/ingest/ingest.js";
import { buildRepoMap } from "../../src/mapping/build.js";
import { createParser } from "../../src/mapping/parse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TS_FIXTURE = path.resolve(here, "../fixtures/ts-sample");

describe("buildRepoMap (TypeScript fixture)", () => {
  it("resolves relative TS imports and extracts classes/functions precisely", async () => {
    const ingest = await ingestRepo(TS_FIXTURE);
    const map = await buildRepoMap(ingest, createParser());

    const hasEdge = (from: string, to: string) =>
      map.edges.some((e) => e.from === from && e.to === to);

    // `./utils` and `./services` resolve to .ts files
    expect(hasEdge("src/index.ts", "src/utils.ts")).toBe(true);
    expect(hasEdge("src/index.ts", "src/services.ts")).toBe(true);

    const services = map.files.find((f) => f.path === "src/services.ts");
    expect(services?.language).toBe("typescript");
    expect(services?.symbols.some((s) => s.kind === "class" && s.name === "OrderService")).toBe(
      true,
    );

    // node:https is external, not an intra-repo edge
    expect(services?.importsExternal).toContain("node:https");

    // every TS file parsed precisely
    expect(map.stats.preciseFiles).toBe(4);
  });
});
