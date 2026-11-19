import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The Work service opens neither the app's database nor the vault, and
 * needs no Electron (architecture §8.1): main feeds it. Walks every module
 * the service's entry reaches in this repo and holds each to that.
 */

const ENTRY = resolve('src/main/workServiceProcess.ts')
const FORBIDDEN = [/^node:sqlite$/, /^electron$/, /^aliax-core/, /(^|\/)db(\.ts)?$/, /(^|\/)store(\.ts)?$/, /vault/i, /deviceToken/, /(^|\/)sessions(\.ts)?$/, /^@shared\/work$/]

function walk(file: string, seen = new Map<string, string[]>()): Map<string, string[]> {
  if (seen.has(file)) return seen
  const source = readFileSync(file, 'utf8')
  const specs = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2] ?? m[3]!)
  seen.set(file, specs)
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue
    const base = resolve(dirname(file), spec)
    const next = [`${base}.ts`, `${base}/index.ts`].find((p) => existsSync(p))
    if (next) walk(next, seen)
  }
  return seen
}

describe("the Work service's boundary", () => {
  it('reaches no database, vault, session registry or Electron module from its entry', () => {
    const graph = walk(ENTRY)
    expect(graph.size).toBeGreaterThan(5)
    const bad: string[] = []
    for (const [file, specs] of graph) for (const spec of specs) if (FORBIDDEN.some((re) => re.test(spec))) bad.push(`${file.replace(resolve('.') + '/', '')} imports ${spec}`)
    expect(bad).toEqual([])
  })
  it('is not reached by main except through the supervisor: main never imports serve.ts', () => {
    const graph = walk(resolve('src/main/server/work/service/ctx.ts'))
    expect([...graph.keys()].some((f) => f.endsWith('service/serve.ts'))).toBe(false)
  })
})
