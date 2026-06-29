/**
 * Heuristic file-role classification. Role drives later weighting: the
 * testing-quality category needs test↔source mapping, and config/docs/infra
 * files are reasoned about differently from source.
 */

import type { FileRole } from "../domain/taxonomy.js";
import { type Language, extensionOf, languageOf } from "./language.js";

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec|specs|e2e)(\/|$)/i;
const TEST_FILE_RE = /(\.|_|-)(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$/i;

const DOC_EXTS = new Set(["md", "mdx", "rst", "txt", "adoc"]);
const CONFIG_EXTS = new Set([
  "json",
  "toml",
  "yaml",
  "yml",
  "ini",
  "cfg",
  "conf",
  "env",
  "properties",
  "lock",
]);
const CONFIG_BASENAMES = new Set([
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  ".gitignore",
  ".editorconfig",
  ".npmrc",
  "requirements.txt",
  "go.mod",
  "cargo.toml",
  "gemfile",
]);
const INFRA_PATH_RE =
  /(^|\/)(\.github|\.gitlab|\.circleci|ci|deploy|deployment|k8s|kubernetes|helm|terraform|ansible|infra)(\/|$)/i;
const INFRA_BASENAMES = new Set([
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "makefile",
  "jenkinsfile",
  ".dockerignore",
]);

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
}

export function classifyRole(path: string): FileRole {
  const base = basename(path);
  const ext = extensionOf(path);
  const lang: Language = languageOf(path);

  // Tests win over source even though they share an extension.
  if (TEST_PATH_RE.test(path) || TEST_FILE_RE.test(path)) return "test";

  if (INFRA_BASENAMES.has(base) || INFRA_PATH_RE.test(path)) return "infra";

  if (DOC_EXTS.has(ext)) return "docs";

  if (CONFIG_BASENAMES.has(base) || CONFIG_EXTS.has(ext)) return "config";

  // Anything with a recognised programming language is source.
  if (lang !== "unknown") return "source";

  // Unknown extension in a conventional source dir → treat as source, else docs.
  if (/(^|\/)(src|lib|app|pkg|internal)(\/|$)/i.test(path)) return "source";
  return "docs";
}
