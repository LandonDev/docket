import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * The app's root: the folder that holds its package.json, found by walking up
 * from where this code runs. The build splits the main bundle into chunks
 * (out/main/index.js, out/main/chunks/*.js), so a path counted up from
 * `__dirname` depends on which file the code landed in; the walk does not. It
 * is the checkout in a dev tree, the build's folder on the box, app.asar in
 * the packaged app. An ES module bundle has no `__dirname` (the iOS client
 * tests' server): the walk starts at the working directory there.
 */
export function appRoot(start: string = typeof __dirname === 'string' ? __dirname : process.cwd(), exists: (path: string) => boolean = existsSync): string {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (exists(join(dir, 'package.json'))) return dir
    // nothing above holds one: as before, two up from out/main
    if (dirname(dir) === dir) return resolve(start, '..', '..')
  }
}

/**
 * A file the bundle ships beside `out/`, by its real path. Under a code-only
 * update (docs/agents/code-only-updates.md) `appRoot()` is the staged tree's
 * folder and `resources/` there is a link to the bundle's: a program started
 * from here (tc-computer, the appshot helper) is named by the bundle's own
 * path, the one its signature and its privacy grants were given under. A
 * file that is not there yet keeps the plain path.
 */
export function bundleFile(...parts: string[]): string {
  const path = join(appRoot(), ...parts)
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
