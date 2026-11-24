#!/usr/bin/env bun
/**
 * Mail on dummy mail in a real Chromium, with no app, no host and no sign-in
 * (docs/agents/work-mail.md "Proving it"). It bundles
 * src/renderer/src/work/mail/preview/page.tsx, compiles the renderer's own
 * stylesheet, serves both on 127.0.0.1 under the page policy the app itself
 * ships (src/renderer/index.html, through `pagePolicy`), and drives the page
 * over the DevTools protocol with real keys and clicks.
 *
 *   bun scripts/mail-preview.ts --serve            # print the address and keep serving
 *   bun scripts/mail-preview.ts --shots <dir>      # the review shots: every scene, dark and light, 1280 and 640
 *   bun scripts/mail-preview.ts --proof            # the reader's proof; exits 1 when a claim fails
 *   bun scripts/mail-preview.ts --chat <dir>       # the chat beside the mail by real clicks, dark and light; pictures into <dir>
 *   taskset -c 0-3 bun scripts/mail-preview.ts --speed   # the list on 5,000 threads: first paint beside 50's, and a scroll through them all
 *   … --policy <index.html>                        # serve under another app's page policy (LifeOS desktop's)
 */
import { compile } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'
import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Chromium, type Page } from '../node_modules/work-kit/src/mail/proof/index'
import { runProof } from '../src/renderer/src/work/mail/preview/proof'
import { runChatProof } from '../src/renderer/src/work/mail/preview/chatProof'
import { SCENES, shoot } from '../src/renderer/src/work/mail/preview/scenes'
import { runSpeed } from '../src/renderer/src/work/mail/preview/speed'

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: {
    serve: { type: 'boolean' },
    shots: { type: 'string' },
    proof: { type: 'boolean' },
    speed: { type: 'boolean' },
    policy: { type: 'string' },
    only: { type: 'string' },
    chat: { type: 'string' }
  }
})

/** The Content-Security-Policy an app's index.html carries in its meta tag. */
export function policyOf(indexHtml: string): string {
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(indexHtml)
  if (!meta) throw new Error('no Content-Security-Policy meta in that index.html')
  return meta[1]!.replace(/\s+/g, ' ').trim()
}

async function bundle(): Promise<string> {
  const out = await build({
    entryPoints: [join(root, 'src/renderer/src/work/mail/preview/page.tsx')],
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
          // A work-kit path its package names another file for (`work-kit/projects/order`) goes where the package says.
          const named = JSON.parse(readFileSync(join(root, 'node_modules/work-kit/package.json'), 'utf8')).exports as Record<string, unknown>
          b.onResolve({ filter: /^work-kit\// }, (args) => {
            const to = named[`./${args.path.slice('work-kit/'.length)}`]
            return typeof to === 'string' ? { path: join(root, 'node_modules/work-kit', to) } : undefined
          })
          // Vite's `?raw`: the file's text (the release notes the app's shell reads).
          b.onResolve({ filter: /\?raw$/ }, (args) => ({ path: join(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'raw' }))
          b.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' }))
          // Vite's `?worker` and `?url`: the Mail view opens a file's canvas beside the mail, so its bundle names the
          // editors' workers; the preview never starts one.
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

async function stylesheet(): Promise<string> {
  const path = join(root, 'src/renderer/src/index.css')
  const compiler = await compile(readFileSync(path, 'utf8'), { base: resolve(path, '..'), onDependency: () => {} })
  const css = compiler.build(new Scanner({ sources: [{ base: join(root, 'src/renderer'), pattern: '**/*', negated: false }, ...compiler.sources] }).scan())
  // What the Mail view imports beside the app's sheet (MailView.tsx).
  const extra = ['node_modules/work-kit/src/mail/styles.css', 'src/renderer/src/work/mail/mail.css'].map((file) => readFileSync(join(root, file), 'utf8'))
  return [css, ...extra].join('\n')
}

export async function serve(policy: string): Promise<{ url: string; stop: () => void }> {
  const [js, css] = await Promise.all([bundle(), stylesheet()])
  const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><title>Mail preview</title><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script type="module" src="/page.js"></script></body></html>`
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname === '/') return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      if (pathname === '/page.js') return new Response(js, { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
      if (pathname === '/preview.css') return new Response(css, { headers: { 'content-type': 'text/css; charset=utf-8' } })
      const font = /^\/assets\/fonts\/([\w.-]+)$/.exec(pathname)
      const file = font && join(root, 'src/renderer/src/assets/fonts', font[1]!)
      if (file && existsSync(file)) return new Response(Bun.file(file))
      return new Response('not here', { status: 404 })
    }
  })
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => void server.stop(true) }
}

if (import.meta.main) {
  const policy = policyOf(readFileSync(values.policy ?? join(root, 'src/renderer/index.html'), 'utf8'))
  const site = await serve(policy)
  if (values.serve) {
    console.log(site.url)
  } else {
    // The box's sans is DejaVu; Selawik, when the box has it, reads as a desktop's own UI face does.
    const browser = await Chromium.launch({ font: process.env.MAIL_PROOF_FONT ?? 'Selawik' })
    let failed = false
    try {
      if (values.proof) {
        const page: Page = await browser.page(1280, 800)
        const claims = await runProof(page, site.url)
        for (const claim of claims) console.log(`${claim.ok ? 'ok  ' : 'FAIL'} ${claim.name}${claim.ok ? '' : `: ${claim.detail}`}`)
        failed = claims.some((claim) => !claim.ok)
      }
      if (values.chat) {
        mkdirSync(values.chat, { recursive: true })
        for (const theme of ['dark', 'light'] as const) {
          const page: Page = await browser.page(1280, 800)
          const claims = await runChatProof(page, site.url, values.chat, theme)
          for (const claim of claims) console.log(`${claim.ok ? 'ok  ' : 'FAIL'} ${theme} ${claim.name}${claim.ok ? '' : `: ${claim.detail}`}`)
          failed = failed || claims.some((claim) => !claim.ok) || claims.length < 6
        }
      }
      if (values.speed) {
        const speed = await runSpeed(browser, site.url)
        console.log(`first paint of the list, ${speed.runs} runs each, turn about, ms from the mail being ready (load ${speed.load.join(' ')})`)
        console.log(`  ${speed.small.threads} threads: median ${speed.small.median}  (${speed.small.all.join(', ')})`)
        console.log(`  ${speed.large.threads} threads: median ${speed.large.median}  (${speed.large.all.join(', ')})`)
        console.log(`  5,000 is ${speed.over} ms ${speed.over >= 0 ? 'later' : 'sooner'}; the budget is 16`)
        console.log(`scroll through ${speed.scroll.rows} loaded rows (${speed.scroll.drawn} drawn at a time), ${speed.scroll.wheels} turns of the wheel over ${speed.scroll.frames} frames`)
        console.log(`  tasks over 50 ms: ${speed.scroll.longTasks.length ? speed.scroll.longTasks.join(', ') : 'none'}; worst frame ${speed.scroll.worstFrame} ms`)
        failed = failed || speed.over > 16 || speed.scroll.longTasks.length > 0 || speed.scroll.rows < 5000
      }
      if (values.shots) {
        mkdirSync(values.shots, { recursive: true })
        const scenes = values.only ? SCENES.filter((scene) => values.only!.split(',').includes(scene.name)) : SCENES
        for (const scene of scenes) await shoot(browser, site.url, scene, values.shots)
      }
    } finally {
      await browser.close()
      site.stop()
    }
    process.exit(failed ? 1 : 0)
  }
}
