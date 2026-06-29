import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createParser } from "../../src/mapping/parse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PY = path.resolve(here, "../fixtures/py-sample/src/app");

describe("tree-sitter parser (python)", () => {
  it("extracts classes, functions, and imports precisely", async () => {
    const parser = createParser();
    const services = await parser.parse(
      await readFile(path.join(PY, "services.py"), "utf8"),
      "python",
    );

    expect(services.precise).toBe(true);
    const names = services.symbols.map((s) => s.name);
    expect(services.symbols.some((s) => s.kind === "class" && s.name === "OrderService")).toBe(
      true,
    );
    expect(names).toContain("create_order");
    expect(services.imports.map((i) => i.spec)).toContain("urllib.request");

    // line ranges are 1-based and span the definition
    const cls = services.symbols.find((s) => s.name === "OrderService");
    expect(cls?.startLine).toBeGreaterThan(0);
    expect(cls?.endLine ?? 0).toBeGreaterThan(cls?.startLine ?? 0);
  });

  it("resolves intra-repo import specifiers in main.py", async () => {
    const parser = createParser();
    const main = await parser.parse(await readFile(path.join(PY, "main.py"), "utf8"), "python");
    const specs = main.imports.map((i) => i.spec);
    expect(specs).toContain("app.utils");
    expect(specs).toContain("app.services");
    expect(main.symbols.map((s) => s.name)).toContain("run");
  });
});

describe("heuristic fallback (untuned language)", () => {
  it("still extracts functions and imports without a grammar", async () => {
    const parser = createParser();
    const go = `package main

import "fmt"

func Greet(name string) string {
	return fmt.Sprintf("hi %s", name)
}
`;
    const parsed = await parser.parse(go, "go");
    expect(parsed.precise).toBe(false);
    expect(parsed.symbols.map((s) => s.name)).toContain("Greet");
    expect(parsed.imports.map((i) => i.spec)).toContain("fmt");
  });
});
