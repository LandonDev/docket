/**
 * `bun scripts/bundle-server.ts scripts/<name>.ts`: bundles a headless proof that runs server code into
 * scripts/.out/<name>.mjs for plain node, through bundleNodeScript's server mode (scripts/lib/bundle-node-script.ts).
 * work-kit resolves there as its package.json exports map says, as vite and vitest resolve it; an alias to
 * node_modules/work-kit/src turned `work-kit/sheet/format` into a path that does not exist.
 */
import { basename, resolve } from 'node:path'
import { bundleNodeScript } from './lib/bundle-node-script'

const entry = process.argv[2]
if (!entry) {
  console.error('usage: bun scripts/bundle-server.ts scripts/<name>.ts')
  process.exit(2)
}
const repo = resolve(import.meta.dirname, '..')
const failed = await bundleNodeScript(repo, entry, `scripts/.out/${basename(entry).replace(/\.ts$/, '')}.mjs`, { server: true })
if (failed) {
  console.error(`${entry}: ${failed}`)
  process.exit(1)
}
