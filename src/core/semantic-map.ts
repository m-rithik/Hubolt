import { createRequire } from "node:module";
import Parser from "web-tree-sitter";
import type { ChangedRange } from "./diff.js";

const require = createRequire(import.meta.url);

const GRAMMAR_BY_KEY: Record<string, string> = {
  ts: "tree-sitter-typescript",
  tsx: "tree-sitter-tsx",
  js: "tree-sitter-javascript"
};

const REGION_KIND: Record<string, string> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  method_definition: "method",
  class_declaration: "class",
  abstract_class_declaration: "class"
};

export interface SemanticRegion {
  kind: string;
  name: string;
  startLine: number;
  endLine: number;
}

let parserReady: Promise<void> | undefined;
const languages = new Map<string, Parser.Language | null>();
const parsers = new Map<string, Parser>();

export function grammarKeyForPath(path: string): string | null {
  if (/\.tsx$/i.test(path)) {
    return "tsx";
  }
  if (/\.(mts|cts|ts)$/i.test(path)) {
    return "ts";
  }
  if (/\.(jsx|mjs|cjs|js)$/i.test(path)) {
    return "js";
  }
  return null;
}

/**
 * Return the named code regions (functions, classes, methods, and arrow-function
 * consts) that overlap the changed line ranges. Returns an empty array for files
 * with no supported grammar or that fail to parse, so callers fall back to
 * full-file context.
 */
export async function mapChangedRegions(
  source: string,
  path: string,
  changedRanges: ChangedRange[]
): Promise<SemanticRegion[]> {
  const key = grammarKeyForPath(path);
  if (!key) {
    return [];
  }

  const language = await loadLanguage(key);
  if (!language) {
    return [];
  }

  // One parser per grammar key — reusing across calls avoids repeated allocation
  // while keeping language state isolated so parsers can't bleed into each other.
  // Tree is still freed in the finally block since it holds WASM heap memory.
  let parser = parsers.get(key);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parsers.set(key, parser);
  }

  let tree: Parser.Tree | undefined;
  try {
    tree = parser.parse(source);
    const regions: SemanticRegion[] = [];
    collectRegions(tree.rootNode, regions);

    const overlapping = regions.filter((region) =>
      changedRanges.some((range) => region.startLine <= range.endLine && region.endLine >= range.startLine)
    );

    return dedupe(changedRanges.length > 0 ? overlapping : regions);
  } catch {
    return [];
  } finally {
    tree?.delete();
  }
}

async function loadLanguage(key: string): Promise<Parser.Language | null> {
  if (languages.has(key)) {
    return languages.get(key) ?? null;
  }

  try {
    if (!parserReady) {
      parserReady = Parser.init();
    }
    await parserReady;

    const wasmPath = require.resolve(`tree-sitter-wasms/out/${GRAMMAR_BY_KEY[key]}.wasm`);
    const language = await Parser.Language.load(wasmPath);
    languages.set(key, language);
    return language;
  } catch {
    // Reset so a transient failure doesn't permanently poison the promise.
    parserReady = undefined;
    languages.set(key, null);
    return null;
  }
}

function collectRegions(node: Parser.SyntaxNode, out: SemanticRegion[]): void {
  const kind = REGION_KIND[node.type];
  if (kind) {
    out.push({
      kind,
      name: node.childForFieldName("name")?.text ?? "(anonymous)",
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1
    });
  } else if (node.type === "variable_declarator" && hasFunctionValue(node)) {
    out.push({
      kind: "function",
      name: node.childForFieldName("name")?.text ?? "(anonymous)",
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1
    });
  }

  // node.children batches all children in a single WASM boundary crossing
  // (and caches), unlike repeated node.child(i) calls.
  for (const child of node.children) {
    collectRegions(child, out);
  }
}

function hasFunctionValue(node: Parser.SyntaxNode): boolean {
  const value = node.childForFieldName("value");
  return value?.type === "arrow_function" || value?.type === "function";
}

function dedupe(regions: SemanticRegion[]): SemanticRegion[] {
  const seen = new Set<string>();
  const result: SemanticRegion[] = [];
  for (const region of regions) {
    const key = `${region.kind}:${region.name}:${region.startLine}:${region.endLine}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(region);
    }
  }
  return result;
}
