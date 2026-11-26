import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Vite's `import.meta.glob` for the static preview (scripts/ui-preview.ts):
 * Bun has none, so a page that reached a module calling it died as it loaded.
 * Pure, so its test runs under vitest.
 */

/** The renderer modules that call Vite's `import.meta.glob` (scripts/ui-preview.test.ts holds the list to the tree). */
export const GLOB_MODULES = ['src/renderer/src/work/formats/fonts.ts', 'src/renderer/src/work/pdf/pdfjsData.ts']

/** A module's source with each eager `import.meta.glob(pattern, options)` replaced by the map Vite would
 *  build for it: every file the pattern names, keyed as written, valued by its file URL. */
export function expandGlobs(source: string, path: string): string {
  return source.replace(/import\.meta\.glob(?:<[^>]*>)?\(\s*("[^"]*"|\[[^\]]*\])[^)]*\)/g, (_call, patterns: string) => {
    const map: Record<string, string> = {}
    for (const pattern of (patterns.startsWith('[') ? JSON.parse(patterns) : [JSON.parse(patterns)]) as string[]) {
      const file = resolve(dirname(path), pattern)
      if (!file.includes('*')) {
        map[pattern] = pathToFileURL(file).href
        continue
      }
      const dir = dirname(file)
      const [before, after] = basename(file).split('*')
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir).sort()) {
        if (name.startsWith(before) && name.endsWith(after)) map[`${dirname(pattern)}/${name}`] = pathToFileURL(join(dir, name)).href
      }
    }
    return `(${JSON.stringify(map)} as Record<string, string>)`
  })
}
