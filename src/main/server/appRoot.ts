import { existsSync } from 'node:fs'
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
