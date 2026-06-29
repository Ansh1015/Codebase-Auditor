import { describe, expect, it } from "vitest";
import { buildResolverContext, resolveImports } from "../../src/mapping/resolve.js";
import type { ImportRef } from "../../src/mapping/symbols.js";

const imp = (spec: string): ImportRef => ({ spec, line: 1 });

describe("resolveImports — JS/TS", () => {
  const paths = [
    "source/index.ts",
    "source/queue.ts",
    "source/priority-queue.ts",
    "lib/util/index.ts",
  ];
  const ctx = buildResolverContext(paths);

  it("resolves NodeNext-style '.js' specifiers to their '.ts' sibling", () => {
    const res = resolveImports(
      "source/index.ts",
      "typescript",
      [imp("./queue.js"), imp("./priority-queue.js")],
      ctx,
    );
    expect([...res.resolved].sort()).toEqual(["source/priority-queue.ts", "source/queue.ts"]);
    expect(res.external).toEqual([]);
  });

  it("resolves an extensionless specifier", () => {
    const res = resolveImports("source/index.ts", "typescript", [imp("./queue")], ctx);
    expect(res.resolved).toEqual(["source/queue.ts"]);
  });

  it("resolves a directory specifier to its index file", () => {
    const res = resolveImports("source/index.ts", "typescript", [imp("../lib/util")], ctx);
    expect(res.resolved).toEqual(["lib/util/index.ts"]);
  });

  it("treats a bare package specifier as external", () => {
    const res = resolveImports("source/index.ts", "typescript", [imp("eventemitter3")], ctx);
    expect(res.resolved).toEqual([]);
    expect(res.external).toEqual(["eventemitter3"]);
  });
});
