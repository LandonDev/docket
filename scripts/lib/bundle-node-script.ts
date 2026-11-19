/**
 * Bundles a headless script for plain node the way the iOS proofs run the server:
 * packages external, @shared and aliax-core from source, electron through
 * scripts/electron-shim.mjs, and the TypeScript-source packages bundled in as
 * electron.vite.config.ts does (node cannot strip types under node_modules). A `?modulePath` import (electron-vite's own, the
 * sheet worker's) becomes its source path: nothing headless forks a utility process. A `?raw` import (vite's, the
 * Office add-in's assets the Work service serves) becomes the file's text.
 */
import { build, type Plugin } from 'esbuild'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const modulePath: Plugin = {
  name: 'module-path',
  setup(b) {
    b.onResolve({ filter: /\?modulePath$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\?modulePath$/, '')), namespace: 'module-path' }))
    b.onLoad({ filter: /.*/, namespace: 'module-path' }, (args) => ({ contents: `export default ${JSON.stringify(args.path)}`, loader: 'js' }))
  }
}

const rawText: Plugin = {
  name: 'raw-text',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw-text' }))
    b.onLoad({ filter: /.*/, namespace: 'raw-text' }, (args) => ({ contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))}`, loader: 'js' }))
  }
}

// Every other package stays external, as `packages: 'external'` would leave it.
const bundled = /^(@shared|aliax-core|electron|work-kit|@muse-code\/sdk)(\/|$)/
const externalPackages: Plugin = {
  name: 'external-packages',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => (bundled.test(args.path) ? undefined : { path: args.path, external: true }))
  }
}

/** Returns an error line, or null when the bundle was written. */
export async function bundleNodeScript(repo: string, entry: string, outfile: string, opts: { server?: boolean } = {}): Promise<string | null> {
  try {
    await build({
      absWorkingDir: repo,
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
      logLevel: 'warning',
      ...(opts.server
        ? {
            alias: { '@shared': './src/shared', 'aliax-core': './node_modules/aliax-core/src', electron: './scripts/electron-shim.mjs' },
            plugins: [modulePath, rawText, externalPackages]
          }
        : {})
    })
    return null
  } catch (err) {
    return `esbuild failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
  }
}