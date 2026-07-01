import { describe, expect, it } from "vitest";
import { componentId, repoRelPath } from "../../src/domain/brand.js";
import type { FileNode, RepoMap } from "../../src/mapping/repomap.js";
import { renderFileWithLineNumbers, renderProjectFactSheet } from "../../src/passes/prompts.js";

function node(p: string, language: FileNode["language"], role: FileNode["role"]): FileNode {
  return {
    path: repoRelPath(p),
    role,
    language,
    loc: 10,
    symbols: [],
    complexity: 1,
    churn: 0,
    importsResolved: [],
    importsExternal: [],
    importance: 0.5,
    component: componentId("x"),
  };
}

const goMap: RepoMap = {
  files: [
    node("main.go", "go", "source"),
    node("cmd/root.go", "go", "source"),
    node("go.mod", "unknown", "config"),
    node(".github/dependabot.yml", "unknown", "infra"),
  ],
  edges: [],
  components: [],
  ranked: [],
  stats: {
    fileCount: 4,
    totalLoc: 100,
    edgeCount: 0,
    componentCount: 1,
    languageBreakdown: { go: 2, unknown: 2 },
    preciseFiles: 0,
  },
};

describe("renderProjectFactSheet (V-004 prevention)", () => {
  it("states the primary language (incl. untuned Go) and detects manifests", () => {
    const s = renderProjectFactSheet(goMap);
    // This is the exact context whose absence made a Go repo read as "TypeScript".
    expect(s).toContain("go (2 files)");
    expect(s).toContain("go.mod → Go");
    expect(s).toMatch(/4 files/);
    expect(s.toLowerCase()).not.toContain("typescript");
  });

  it("degrades gracefully when no language/manifest is recognised", () => {
    const bare: RepoMap = {
      ...goMap,
      files: [],
      stats: { ...goMap.stats, languageBreakdown: { unknown: 3 }, fileCount: 3 },
    };
    const s = renderProjectFactSheet(bare);
    expect(s).toContain("undetermined");
    expect(s).toContain("none detected");
  });
});

describe("renderFileWithLineNumbers role tagging", () => {
  it("tags the file with its role when provided", () => {
    expect(renderFileWithLineNumbers("docs/guide.md", "x\ny", 10, "docs")).toContain(
      "FILE: docs/guide.md [docs]",
    );
  });

  it("omits the tag when no role is given", () => {
    const r = renderFileWithLineNumbers("src/a.ts", "x", 10);
    expect(r).toContain("FILE: src/a.ts (");
    expect(r).not.toContain("[");
  });
});
