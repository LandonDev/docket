#!/usr/bin/env bun
/**
 * The Messages view in a real Chromium, with no app, no host and no sign-in
 * (docs/agents/work-messages.md "Proving it"). It bundles
 * src/renderer/src/work/messages/preview/page.tsx, compiles the renderer's
 * own stylesheet, serves both on 127.0.0.1 under the page policy the app
 * itself ships, and drives the page over the DevTools protocol.
 *
 *   bun scripts/messages-preview.ts --serve                 # print the address and keep serving
 *   bun scripts/messages-preview.ts --shots <dir>           # every scene, dark and light, 1280 and 640 (--only a,b narrows)
 *   taskset -c 0-3 bun scripts/messages-preview.ts --speed  # 2,000 conversations and 5,000 messages: first paint and a hard scroll
 *   bun scripts/messages-preview.ts --live <token file> --sector cosmic   # the one live read: the screens on LifeOS itself, counts only
 */
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Chromium, type Page } from '../node_modules/work-kit/src/mail/proof/index'
import { MESSAGES_SCENES } from '../src/renderer/src/work/messages/MessagesView.preview'
import { runSpeed } from '../src/renderer/src/work/messages/preview/speed'
import { policyOf, serveBundle } from './lib/previewSite'

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: {
    serve: { type: 'boolean' },
    shots: { type: 'string' },
    only: { type: 'string' },
    speed: { type: 'boolean' },
    live: { type: 'string' },
    sector: { type: 'string' },
    convex: { type: 'string' }
  }
})

const ROW = '[role=listbox][aria-label=Conversations] [role=option]'

/** The scene has drawn: bones for a loading one, rows or its one line otherwise, and the open conversation's messages. */
async function settled(page: Page, scene: string): Promise<void> {
  await page.until('document.querySelector("[data-messages]")', 'the view')
  if (scene.startsWith('open') || scene === 'narrow-open' || scene === 'heavy-open') await page.until('document.querySelector("[data-block]")', `${scene}'s messages`)
  // Faces and pictures land a frame or two after their rows.
  await page.wait(250)
}

async function shots(browser: Chromium, url: string, dir: string, only: string[] | null): Promise<void> {
  mkdirSync(dir, { recursive: true })
  for (const scene of MESSAGES_SCENES) {
    if (scene.startsWith('heavy') || (only && !only.includes(scene))) continue
    for (const width of [1280, 640]) {
      for (const theme of ['dark', 'light']) {
        const page = await browser.page(width, 800)
        await page.goto(`${url}?theme=${theme}&scene=${scene}`)
        await settled(page, scene)
        await page.shot(join(dir, `${scene}.${width}.${theme}.png`))
        await page.send('Page.close').catch(() => {})
      }
    }
    console.log(scene)
  }
}

/**
 * The one live read: the view's own screens on LifeOS itself, as a sign-in
 * narrowed to one sector. It lists, opens the first conversation and reads
 * it. Only counts are printed and no picture is kept: what is on the page is
 * his chat.
 */
async function live(browser: Chromium, url: string, tokenFile: string, sector: string, convex: string): Promise<boolean> {
  const token = readFileSync(tokenFile, 'utf8').trim()
  const { jwt } = (await new ConvexHttpClient(convex).action(makeFunctionReference<'action'>('auth:token'), { token, sectors: [sector] })) as { jwt: string }
  const page = await browser.page(1280, 800)
  await page.goto(`${url}?theme=dark&live=${sector}#${encodeURIComponent(`${convex}|${jwt}`)}`)
  // The list's rows, or its own one line when it has none (ours to print: it is no word of his chat).
  await page.until(`document.querySelector(${JSON.stringify(ROW)})`, 'the list', 30_000).catch(() => {})
  const rows = await page.eval<number>(`document.querySelectorAll(${JSON.stringify(ROW)}).length`)
  if (rows === 0) console.log(`live ${sector}: no row; the page says: ${await page.eval<string>('[...document.querySelectorAll("[data-messages] [data-slot=empty-title], [data-messages] [role=alert]")].map((e) => e.textContent).join(" / ")')}`)
  const unread = await page.eval<number>(`document.querySelectorAll(${JSON.stringify(`${ROW}[data-unread]`)}).length`)
  console.log(`live ${sector}: the list drew ${rows} rows at once, ${unread} of them unread`)
  if (rows === 0) return false
  const at = await page.centre(ROW)
  if (at) await page.click(at.x, at.y)
  await page.until('document.querySelector("[data-block]")', 'the conversation', 30_000)
  await page.wait(500)
  const blocks = await page.eval<number>('document.querySelectorAll("[data-block]").length')
  const failed = await page.eval<number>('document.querySelectorAll("[data-messages] [role=alert]").length')
  console.log(`live ${sector}: the first conversation opened and drew ${blocks} messages; ${failed} errors on the page`)
  await page.send('Page.close').catch(() => {})
  return blocks > 0 && failed === 0
}

if (import.meta.main) {
  const site = await serveBundle({
    root,
    entry: 'src/renderer/src/work/messages/preview/page.tsx',
    extraCss: ['src/renderer/src/work/messages/messages.css'],
    title: 'Messages preview',
    policy: policyOf(readFileSync(join(root, 'src/renderer/index.html'), 'utf8'))
  })
  if (values.serve) {
    console.log(site.url)
  } else {
    // The box's sans is DejaVu; Selawik, when the box has it, reads as a desktop's own UI face does.
    const browser = await Chromium.launch({ font: process.env.MAIL_PROOF_FONT ?? 'Selawik' })
    let failed = false
    try {
      if (values.shots) await shots(browser, site.url, values.shots, values.only ? values.only.split(',') : null)
      if (values.speed) {
        const speed = await runSpeed(browser, site.url)
        const over = (s: { small: number; large: number }): number => Math.round((s.large - s.small) * 10) / 10
        console.log(`first paint, ${speed.runs} runs each, turn about, ms from the page's script starting (load ${speed.load.join(' ')})`)
        console.log(`  the list: 12 conversations median ${speed.list.small}, 2,000 median ${speed.list.large} (${over(speed.list)} later)  [${speed.list.all.small.join(', ')}] [${speed.list.all.large.join(', ')}]`)
        console.log(`  a conversation: the everyday one median ${speed.open.small}, 5,000 messages median ${speed.open.large} (${over(speed.open)} later)  [${speed.open.all.small.join(', ')}] [${speed.open.all.large.join(', ')}]`)
        for (const [name, s] of [['the list of 2,000', speed.list.scroll], ['the conversation of 5,000', speed.open.scroll]] as const) {
          console.log(`hard scroll through ${name}: ${s.wheels} turns of the wheel over ${s.frames} frames, ${s.travelled}px travelled, ${s.drawn} rows drawn at the end`)
          console.log(`  tasks over 50 ms: ${s.longTasks.length ? s.longTasks.join(', ') : 'none'}; worst frame ${s.worstFrame} ms`)
        }
        failed = failed || speed.list.scroll.longTasks.length > 0 || speed.open.scroll.longTasks.length > 0 || speed.list.scroll.travelled < 10_000 || speed.open.scroll.travelled < 10_000
      }
      if (values.live) failed = !(await live(browser, site.url, values.live, values.sector ?? 'cosmic', values.convex ?? 'http://127.0.0.1:3220')) || failed
    } finally {
      await browser.close()
      site.stop()
    }
    process.exit(failed ? 1 : 0)
  }
}
