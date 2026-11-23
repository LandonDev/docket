// The headless proofs bundle server code for plain node through one step, scripts/bundle-server.ts, where
// work-kit resolves as its exports map says. A server import of a work-kit path that step cannot resolve
// fails here, naming the import, and not at the release's publish tier (F-proof-bundling, 2026-11-23).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bundleNodeScript } from './lib/bundle-node-script'

const repo = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.out' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (/\.(ts|tsx|mts|mjs)$/.test(name)) out.push(path)
  }
  return out
}

/** Every work-kit path the main process, shared code and the scripts import, with a file that imports it. */
function workKitImports(): Map<string, string> {
  const found = new Map<string, string>()
  for (const dir of ['src/main', 'src/shared', 'scripts']) {
    for (const file of sources(join(repo, dir))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"](work-kit(?:\/[^'"?]+)?)['"]/g)) {
        if (!found.has(m[1])) found.set(m[1], file.slice(repo.length + 1))
      }
    }
  }
  return found
}

async function bundleImports(specs: string[]): Promise<string | null> {
  // Inside the repo, so work-kit is found in its node_modules as a proof's entry finds it.
  mkdirSync(join(repo, 'scripts/.out'), { recursive: true })
  const dir = mkdtempSync(join(repo, 'scripts/.out/proof-bundling-'))
  try {
    writeFileSync(join(dir, 'entry.ts'), specs.map((spec, i) => `import * as m${i} from '${spec}'\nconsole.log(m${i})\n`).join(''))
    return await bundleNodeScript(repo, join(dir, 'entry.ts'), join(dir, 'out.mjs'), { server: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('bundling server code for the proofs', () => {
  it('resolves every work-kit path the server and the scripts import', async () => {
    const imports = workKitImports()
    expect(imports.has('work-kit/sheet/format')).toBe(true)
    const failed = await bundleImports([...imports.keys()])
    const unresolved = [...imports].filter(([spec]) => failed?.includes(`"${spec}"`)).map(([spec, file]) => `${spec} (imported by ${file})`)
    expect(unresolved, failed ?? '').toEqual([])
    expect(failed).toBeNull()
  }, 60_000)

  it('names a work-kit path its exports map does not hold', async () => {
    expect(await bundleImports(['work-kit/sheet/no-such-part'])).toContain('"work-kit/sheet/no-such-part"')
  })

  it('goes through bundle-server.ts, never an alias to work-kit/src', () => {
    const aliased = Object.entries(pkg.scripts).filter(([, line]) => /--alias:work-kit/.test(line)).map(([name]) => name)
    expect(aliased).toEqual([])
    for (const file of sources(join(repo, 'scripts'))) {
      if (file.endsWith('proofBundling.test.ts')) continue
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/--alias:work-kit/)
    }
  })
})
