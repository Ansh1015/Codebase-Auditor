# Adding a precision language

Today the auditor extracts **precise** symbols and a real dependency graph for
Python and JS/TS (`python`, `javascript`, `typescript`, `tsx`, `jsx`). Every
other language is still ingested, metric'd, and clustered by directory — it just
gets an empty dependency graph and weaker importance ranking. Promoting a
language to "precision" is a self-contained task. Here's the whole map.

The grammars themselves ship with [`tree-sitter-wasms`](https://www.npmjs.com/package/tree-sitter-wasms)
(Go, Java, Ruby, Rust, C/C++, C#, PHP, and more are already in the package), so
you usually don't need to add a dependency — just wire it up.

## 1. Mark the language as tuned — `src/ingest/language.ts`

The extension → `Language` mapping already covers most languages. Add your
language to `TUNED_LANGUAGES`:

```ts
export const TUNED_LANGUAGES: ReadonlySet<Language> = new Set([
  "python", "javascript", "typescript", "tsx", "jsx",
  "go", // ← new
]);
```

## 2. Wire the grammar + queries — `src/mapping/treesitter.ts`

Three small additions:

- **`GRAMMAR_WASM`** — map the language to its wasm filename (e.g.
  `go: "tree-sitter-go.wasm"`). Filenames match the `out/` dir of
  `tree-sitter-wasms`.
- **`SYMBOL_QUERIES`** — a tree-sitter query whose `@def` capture is the
  definition node and `@name` is its name node. Mirror `PY_SYMBOLS` / `TS_SYMBOLS`.
- **`IMPORT_QUERIES`** — a query capturing import specifiers as `@mod`. Mirror
  `PY_IMPORTS` / `JS_IMPORTS`.

If your grammar introduces new definition node types, add them to `DEF_KIND` so
they map to a `SymbolKind` (`function | class | method | interface | type`).

Tip: prototype queries against a real file with the tree-sitter playground, or
log `root.toString()` for a sample to see node type names.

## 3. Resolve imports to edges — `src/mapping/resolve.ts`

`resolveImports` dispatches by language. Add a `resolve<Lang>(spec, fromPath, ctx)`
function that turns a raw specifier into a repo-relative path, following that
language's module-resolution rules, and wire it into the dispatch in
`resolveImports`. Use `resolvePython` (package/relative dots) and `resolveJsLike`
(relative paths + extension rewriting) as references. Return `null` for external
packages so they're recorded as `external`, not edges.

## 4. Prove it — `test/fixtures/<lang>-sample` + a test

Add a tiny fixture repo with a couple of files that import each other (and,
ideally, a planted issue or two). Then add a test under `test/mapping/` asserting
that:

- symbols are extracted (`map` nodes have the expected definitions), and
- intra-repo import **edges resolve** (this is the part most likely to be subtly
  wrong — see the NodeNext resolver bug fixed in the changelog).

Follow `test/mapping/build.test.ts` and `test/mapping/resolve.test.ts` as
templates. The deterministic core is tested first here — no LLM required.

## 5. Run the gate

```bash
npm run typecheck && npm run lint && npm test
```

That's it — open a PR describing the language and linking the fixture.
