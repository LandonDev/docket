/**
 * The renderer's first paint, read from source: every module the entry
 * (src/renderer/src/main.tsx) reaches through static imports that survive
 * the build. No build needed, so a test can hold the first paint to its
 * rules (scripts/entryGraph.test.ts) in a thread that never runs
 * `electron-vite build`; `scripts/check-bundle-size.ts` judges the same
 * rules on the built chunks.
 *
 * What survives: an import whose bindings are used as values. The build
 * drops an `import type`, an `export type … from`, and an import whose every
 * binding is read only in type positions (Babel's and esbuild's TypeScript
 * transforms both do). A dynamic `import()` starts another chunk and is not
 * followed. Shadowing is not modelled: a local that reuses an imported name
 * as a value keeps the import, which errs toward reporting.
 *
 *   bun scripts/entry-graph.ts [needle …]   # the chain to each module whose id contains a needle
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

export const RENDERER_ENTRY = 'src/renderer/src/main.tsx'

/** The renderer's aliases (electron.vite.config.ts `renderer.resolve.alias`). */
const ALIASES: [prefix: string, dir: string][] = [
  ['@renderer/', 'src/renderer/src/'],
  ['@aliax/', 'src/renderer/src/aliax/'],
  ['@server/shared/', 'src/shared/'],
  ['@shared/', 'src/shared/']
]
const CODE = /\.(ts|tsx|mts|js|jsx|mjs)$/

function resolveFile(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (CODE.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** The module a specifier names: a repo-relative source path, `node_modules/<spec>` for a package, or null for what is no code (a stylesheet, an image, a `?worker` url). */
export function resolveSpecifier(root: string, fromFile: string, specifier: string): string | null {
  const spec = specifier.split('?')[0]
  if (spec.startsWith('.')) {
    const file = resolveFile(resolve(root, dirname(fromFile), spec))
    return file ? relative(root, file) : null
  }
  for (const [prefix, dir] of ALIASES) {
    if (!spec.startsWith(prefix)) continue
    const file = resolveFile(resolve(root, dir, spec.slice(prefix.length)))
    return file ? relative(root, file) : null
  }
  return `node_modules/${spec}`
}

/** Whether an identifier sits where only a type can: such a use does not keep its import. */
function inTypePosition(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    // `class B extends A`: the one heritage clause that reads a value. `implements` and an interface's `extends` read types.
    if (ts.isExpressionWithTypeArguments(n)) return !(ts.isHeritageClause(n.parent) && n.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(n.parent.parent))
    if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return true
    if (ts.isStatement(n) || ts.isExpression(n) || ts.isJsxOpeningLikeElement(n)) return false
  }
  return false
}

/** The specifiers a file imports statically and keeps after the build. */
export function keptImports(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  /** local binding → the specifier it came from, for imports that name bindings */
  const bindings = new Map<string, string>()
  const kept = new Set<string>()
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const spec = statement.moduleSpecifier.text
      const clause = statement.importClause
      if (!clause) kept.add(spec) // a side-effect import
      else if (!clause.isTypeOnly) {
        if (clause.name) bindings.set(clause.name.text, spec)
        const named = clause.namedBindings
        if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, spec)
        if (named && ts.isNamedImports(named)) for (const el of named.elements) if (!el.isTypeOnly) bindings.set(el.name.text, spec)
      }
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const named = statement.exportClause
      const typeOnly = statement.isTypeOnly || (named !== undefined && ts.isNamedExports(named) && named.elements.length > 0 && named.elements.every((el) => el.isTypeOnly))
      if (!typeOnly) kept.add(statement.moduleSpecifier.text)
    }
  }
  if (bindings.size > 0) {
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) return
      if (ts.isIdentifier(node)) {
        const spec = bindings.get(node.text)
        if (spec && !kept.has(spec) && isReference(node) && !inTypePosition(node)) kept.add(spec)
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return [...kept]
}

/** An identifier that reads a binding, not one that names a property or a declaration. */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node
  if (ts.isQualifiedName(parent)) return parent.left === node
  if (ts.isPropertyAssignment(parent)) return parent.initializer === node
  if (ts.isJsxAttribute(parent)) return false
  if (ts.isExportSpecifier(parent)) return !parent.isTypeOnly && !parent.parent.parent.isTypeOnly && (parent.propertyName ?? parent.name) === node
  if (ts.isBindingElement(parent)) return parent.initializer === node
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isEnumMember(parent)) && parent.name === node)
    return false
  return true
}

/** Every module the entry reaches, each with the module that first imported it (the entry's is null). */
export function entryGraph(root = resolve('.'), entry = RENDERER_ENTRY): Map<string, string | null> {
  const from = new Map<string, string | null>([[entry, null]])
  const queue = [entry]
  for (let file = queue.shift(); file; file = queue.shift()) {
    if (file.startsWith('node_modules/')) continue
    for (const spec of keptImports(file, readFileSync(resolve(root, file), 'utf8'))) {
      const next = resolveSpecifier(root, file, spec)
      if (!next || from.has(next)) continue
      from.set(next, file)
      queue.push(next)
    }
  }
  return from
}

/** How the entry reaches `id`: the entry first, `id` last. */
export function chainTo(graph: Map<string, string | null>, id: string): string[] {
  const chain: string[] = []
  for (let at: string | null | undefined = id; at; at = graph.get(at)) chain.unshift(at)
  return chain
}

if (import.meta.main) {
  const graph = entryGraph()
  const needles = process.argv.slice(2)
  console.log(`${graph.size} modules reached from ${RENDERER_ENTRY}`)
  for (const id of graph.keys()) if (needles.some((needle) => id.includes(needle))) console.log(chainTo(graph, id).join('\n  → ') + '\n')
}
