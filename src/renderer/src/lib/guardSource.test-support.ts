import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const REPO = resolve(import.meta.dirname, "../../../..");
const SKIP = /^(?:__)?(?:fixtures?|previews|proofs?)(?:__)?$/i;

export function sourcePaths(dir: string): string[] {
  return readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return SKIP.test(entry.name) ? [] : sourcePaths(path);
    return /\.[cm]?tsx?$/.test(path) && !/\.(?:d|test|preview|fixtures?|proofs?)\.[cm]?tsx?$/.test(path) ? [path] : [];
  }).sort();
}

export function sourceFile(file: string): ts.SourceFile {
  const path = join(REPO, file);
  return ts.createSourceFile(file, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

export function visitSource(root: ts.Node, visit: (node: ts.Node) => void): void {
  visit(root);
  ts.forEachChild(root, (node) => visitSource(node, visit));
}

export function location(node: ts.Node): string {
  const source = node.getSourceFile();
  return `${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
}
