/**
 * Bundles a headless script for plain node the way the iOS proofs run the server:
 * packages external, @shared and aliax-core from source, electron through
 * scripts/electron-shim.mjs. A `?modulePath` import (electron-vite's own, the
 * sheet worker's) becomes its source path: nothing headless forks a utility process.
 */
import { build, type Plugin } from 'esbuild'
import { resolve } from 'node:path'

const modulePath: Plugin = {
  name: 'module-path',
  setup(b) {
    b.onResolve({ filter: /\?modulePath$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.replace(/\?modulePath$/, '')), namespace: 'module-path' }))
    b.onLoad({ filter: /.*/, namespace: 'module-path' }, (args) => ({ contents: `export default ${JSON.stringify(args.path)}`, loader: 'js' }))
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
            packages: 'external',
            alias: { '@shared': './src/shared', 'aliax-core': './node_modules/aliax-core/src', electron: './scripts/electron-shim.mjs' },
            plugins: [modulePath]
          }
        : {})
    })
    return null
  } catch (err) {
    return `esbuild failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
  }
}