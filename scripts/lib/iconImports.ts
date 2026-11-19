import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'

/**
 * Icon imports straight to each icon's own module, in a build.
 *
 * `import { IconX } from '@tabler/icons-react'` (work-kit's mail, editor and
 * ui) goes through a barrel that re-exports every icon, so Rollup loads and
 * parses all of them and keeps every module's tree until the bundle is
 * written, used or not: @tabler/icons-react is 6,550 modules and lucide-react
 * 1,617, half of the renderer's graph and nothing of either in the bundle.
 * With the hosted pages that ran node's heap out (the gate, 2026-11-19).
 * Each named import becomes a default import of the icon's file; a name the
 * barrel does not map to one file stays on the barrel.
 */

export const ICON_BARRELS = ['@tabler/icons-react', 'lucide-react'] as const

/** Name → the icon's file, read from the barrel's own `export { default as A, default as B } from './icons/x.js'` lines. */
export function barrelMap(source: string, dir: string): Map<string, string> {
  const names = new Map<string, string>()
  for (const m of source.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const file = join(dir, m[2]!)
    for (const part of m[1]!.split(',')) {
      const name = /^\s*default\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(part)?.[1]
      if (name) names.set(name, file)
    }
  }
  return names
}

/** The import statements of `code` that name a barrel, rewritten; null when none needed it. */
export function rewriteIconImports(code: string, maps: ReadonlyMap<string, ReadonlyMap<string, string>>): string | null {
  let changed = false
  const out = code.replace(/import\s*(type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\3;?/g, (whole, typeOnly: string | undefined, list: string, _q: string, from: string) => {
    const map = maps.get(from)
    if (!map || typeOnly) return whole
    const direct: string[] = []
    const kept: string[] = []
    for (const raw of list.split(',')) {
      const part = raw.trim()
      if (!part) continue
      // `type X` inside the braces is the compiler's alone: dropped here, as esbuild drops it.
      if (/^type\s/.test(part)) continue
      const [name, local] = part.split(/\s+as\s+/).map((s) => s.trim()) as [string, string | undefined]
      const file = map.get(name)
      if (file) direct.push(`import ${local ?? name} from ${JSON.stringify(file)};`)
      else kept.push(part)
    }
    if (!direct.length) return whole
    changed = true
    return [...direct, ...(kept.length ? [`import { ${kept.join(', ')} } from ${JSON.stringify(from)};`] : [])].join(' ')
  })
  return changed ? out : null
}

function loadMaps(root: string): Map<string, Map<string, string>> {
  const maps = new Map<string, Map<string, string>>()
  for (const pkg of ICON_BARRELS) {
    try {
      const dir = join(root, 'node_modules', pkg)
      const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { module?: string }
      if (!json.module) continue
      const entry = join(dir, json.module)
      maps.set(pkg, barrelMap(readFileSync(entry, 'utf8'), dirname(entry)))
    } catch {
      // Not installed here: its imports stay as they are.
    }
  }
  return maps
}

export function directIconImports(root: string = process.cwd()): Plugin {
  let maps: Map<string, Map<string, string>> = new Map()
  return {
    name: 'temp-code-direct-icon-imports',
    apply: 'build',
    enforce: 'pre',
    buildStart() {
      maps = loadMaps(root)
    },
    transform(code, id) {
      if (!/\.[cm]?[jt]sx?$/.test(id.split('?')[0]!) || !ICON_BARRELS.some((b) => code.includes(b))) return null
      const next = rewriteIconImports(code, maps)
      return next === null ? null : { code: next, map: null }
    }
  }
}
