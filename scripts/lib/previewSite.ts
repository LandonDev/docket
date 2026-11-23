import { compile } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'
import { build } from 'esbuild'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * One renderer page bundled and served for a headless Chromium, with no app
 * build: the page's script as the app resolves its imports, the renderer's
 * own stylesheet compiled over the worktree's classes, and the app's own page
 * policy. scripts/mail-preview.ts does the same for Mail by hand; a new
 * preview starts here (scripts/messages-preview.ts).
 */

/** The Content-Security-Policy an app's index.html carries in its meta tag. */
export function policyOf(indexHtml: string): string {
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(indexHtml)
  if (!meta) throw new Error('no Content-Security-Policy meta in that index.html')
  return meta[1]!.replace(/\s+/g, ' ').trim()
}

export interface PreviewSite {
  root: string
  /** the page's entry, from the root */
  entry: string
  /** stylesheets a view imports beside the app's own, from the root */
  extraCss?: string[]
  title: string
  policy: string
}

async function bundle(root: string, entry: string): Promise<string> {
  const out = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'chrome130',
    jsx: 'automatic',
    tsconfig: join(root, 'tsconfig.web.json'),
    alias: { 'work-kit': join(root, 'node_modules/work-kit/src') },
    plugins: [
      {
        name: 'as-the-app-resolves',
        setup(b) {
          // A work-kit path its package names another file for goes where the package says.
          const named = JSON.parse(readFileSync(join(root, 'node_modules/work-kit/package.json'), 'utf8')).exports as Record<string, unknown>
          b.onResolve({ filter: /^work-kit\// }, (args) => {
            const to = named[`./${args.path.slice('work-kit/'.length)}`]
            return typeof to === 'string' ? { path: join(root, 'node_modules/work-kit', to) } : undefined
          })
          // Vite's `?raw`: the file's text.
          b.onResolve({ filter: /\?raw$/ }, (args) => ({ path: join(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw' }))
          b.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }))
          // Vite's `?worker` and `?url`: a view that seats a canvas names the editors' workers; a preview never starts one.
          b.onResolve({ filter: /\?(worker|url)(&.*)?$/ }, (args) => ({ path: args.path, namespace: 'never' }))
          b.onLoad({ filter: /.*/, namespace: 'never' }, () => ({ contents: 'export default class { postMessage() {} terminate() {} addEventListener() {} }', loader: 'js' }))
        }
      }
    ],
    loader: { '.css': 'empty', '.wav': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
    define: { 'import.meta.env.DEV': 'true', 'import.meta.env.PROD': 'false', 'import.meta.env.MODE': '"preview"', 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning'
  })
  return out.outputFiles[0]!.text
}

async function stylesheet(root: string, extra: string[]): Promise<string> {
  const path = join(root, 'src/renderer/src/index.css')
  const compiler = await compile(readFileSync(path, 'utf8'), { base: resolve(path, '..'), onDependency: () => {} })
  const css = compiler.build(new Scanner({ sources: [{ base: join(root, 'src/renderer'), pattern: '**/*', negated: false }, ...compiler.sources] }).scan())
  return [css, ...extra.map((file) => readFileSync(join(root, file), 'utf8'))].join('\n')
}

export async function serveBundle(site: PreviewSite): Promise<{ url: string; stop: () => void }> {
  const [js, css] = await Promise.all([bundle(site.root, site.entry), stylesheet(site.root, site.extraCss ?? [])])
  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${site.policy}"><title>${site.title}</title><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script type="module" src="/page.js"></script></body></html>`
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname === '/') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      if (pathname === '/page.js') return new Response(js, { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
      if (pathname === '/preview.css') return new Response(css, { headers: { 'content-type': 'text/css; charset=utf-8' } })
      const font = /^\/assets\/fonts\/([\w.-]+)$/.exec(pathname)
      const file = font && join(site.root, 'src/renderer/src/assets/fonts', font[1]!)
      if (file && existsSync(file)) return new Response(Bun.file(file))
      return new Response('not here', { status: 404 })
    }
  })
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => void server.stop(true) }
}
