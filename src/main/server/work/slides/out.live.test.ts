import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { DeckOut } from '@shared/contract-work-slides'
import type { SessionMeta } from '@shared/events'
import type { WorkScope } from '@shared/work'
import { openDb, Store } from '../../db'
import type { SessionRegistry } from '../../sessions'
import { canvasStoreOf } from '../canvas/store'
import { LIBREOFFICE_CONVERTERS } from '../formats'
import { setPrinter } from '../formats/print'
import { Toolchain } from '../formats/tools'
import { WORK_MODULES, type WorkModule } from '../modules'
import { SLIDES_CONVERTERS } from './deck'
import { TWELVE } from './fixtures/twelve'
import { writeNewDeck } from './newDeck'
import { VIDEO_CONVERTERS } from './video'

/**
 * The live proof of SLD7 (docs/agents/work-slides.md "Preview and export"), behind TEMP_CODE_WORK_TOOLS_DATA (a
 * userData whose toolchain has LibreOffice, python-pptx, pdf-tools and ffmpeg; /srv/agents/temp-code-data on the
 * box): a 12-slide deck made here goes out through the real module and the real tools. Its PDF holds 12 pages, its
 * video runs 60 s at 1920 by 1080, its pictures are twelve files, its OpenDocument copy draws 12 pages of its own.
 * With SLIDES_PLAYWRIGHT naming a playwright-core (and SLIDES_CHROME its browser, where its own is not installed),
 * notes pages and handouts are printed by a real Chromium too.
 */

vi.mock('../scope', async (original) => ({
  ...(await original<typeof import('../scope')>()),
  scopePart: () => ({
    scopeOf: (id: string): WorkScope => ({ sessionId: id, workspaceId: 'w1', sector: null, host: 'env_test', away: false, routineRunId: null, shared: () => false }),
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))

const DATA = process.env.TEMP_CODE_WORK_TOOLS_DATA
const PLAYWRIGHT = process.env.SLIDES_PLAYWRIGHT

describe.skipIf(!DATA)('a deck out through the real tools', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let work: ReturnType<typeof import('../ctx').startWork>
  let itemId: string
  let closeBrowser: (() => Promise<void>) | null = null
  const timings: string[] = []
  const call = async <T = DeckOut>(method: string, params: unknown): Promise<T> => {
    const out = await work.handle(ClientRequestSchema.parse({ id: '1', method, params } as ClientRequest), LOCAL_PRINCIPAL)
    return (out.handled ? out.result : undefined) as T
  }
  const timed = async <T,>(what: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now()
    try {
      return await fn()
    } finally {
      timings.push(`${what}: ${((performance.now() - t0) / 1000).toFixed(1)} s`)
    }
  }
  const bytes = async (out: { rev: string; size: number }): Promise<Buffer> => {
    const parts: Buffer[] = []
    for (let at = 0; at < out.size; at += 4 << 20) parts.push(Buffer.from((await call<{ data: string }>('work.slides.previewRead', { itemId, rev: out.rev, offset: at, length: 4 << 20 })).data, 'base64'))
    return Buffer.concat(parts)
  }
  const pages = async (b: Buffer): Promise<number> => (await PDFDocument.load(b)).getPageCount()

  beforeAll(async () => {
    const { startWork } = await import('../ctx')
    const { canvas } = await import('../canvas')
    const { slides } = await import('.')
    dir = mkdtempSync(join(tmpdir(), 'tc-slides-out-live-'))
    symlinkSync(join(DATA!, 'work-tools'), join(dir, 'work-tools'))
    db = openDb(join(dir, 'test.db'))
    WORK_MODULES.splice(0, WORK_MODULES.length, { id: 'formats', ensure() {}, convert: [...LIBREOFFICE_CONVERTERS, ...SLIDES_CONVERTERS, ...VIDEO_CONVERTERS] } as WorkModule)
    if (PLAYWRIGHT) {
      const pw = (await import(/* @vite-ignore */ PLAYWRIGHT)) as { chromium: { launch(o?: { executablePath?: string }): Promise<{ newPage(): Promise<{ setContent(html: string): Promise<void>; pdf(o: object): Promise<Buffer> }>; close(): Promise<void> }> } }
      const browser = await pw.chromium.launch(process.env.SLIDES_CHROME ? { executablePath: process.env.SLIDES_CHROME } : {})
      closeBrowser = () => browser.close()
      setPrinter(async (html) => {
        const page = await browser.newPage()
        await page.setContent(html)
        return { pdf: new Uint8Array(await page.pdf({ preferCSSPageSize: true, printBackground: true })), warnings: [] }
      })
    }
    const registry = { get: (id: string) => ({ id, provider: 'claude', workspaceId: 'w1', scope: 'work' }) as SessionMeta, eventsAfter: () => [], onRemoved: () => () => {}, onWorkspaceDeleted: () => () => {} } as unknown as SessionRegistry
    work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {}, remoteFence: { roots: () => [], denied: () => [] } }, [canvas, slides])
    await call('work.set', { enabled: true })
    const path = join(dir, 'Twelve.pptx')
    writeFileSync(path, await writeNewDeck({ title: 'Twelve', slides: TWELVE }))
    itemId = canvasStoreOf(db).open('t1', { kind: 'slides', source: { at: 'file', host: 'env_test', path }, title: 'Twelve' }).id
  }, 120_000)

  afterAll(async () => {
    console.log(timings.join('\n'))
    setPrinter(null)
    await closeBrowser?.()
    await call('work.set', { enabled: false }).catch(() => {})
    work?.close()
    db?.close()
    WORK_MODULES.splice(0, WORK_MODULES.length)
    rmSync(dir, { recursive: true, force: true })
  })

  it("the PDF of the slides has 12 pages, and the file's own copy is the deck", async () => {
    const pdf = await timed('pdf', () => call('work.slides.preview', { itemId, format: 'pdf' }))
    expect(pdf.pdf!.pages).toBe(12)
    expect(await pages(await bytes(pdf.file))).toBe(12)
    expect(pdf.facts).toMatchObject({ slides: 12, notes: 7 })
    const pptx = await timed('pptx', () => call('work.slides.preview', { itemId, format: 'pptx' }))
    expect([pptx.file.name, pptx.pdf!.pages]).toEqual(['Twelve.pptx', 12])
  }, 300_000)

  it('the video of the slides runs 60 s at 1920 by 1080, silent', async () => {
    const video = await timed('video, 1080p, 5 s a slide', () => call('work.slides.preview', { itemId, format: 'video', video: { seconds: 5, height: 1080 } }))
    expect(video.video!.seconds).toBeCloseTo(60, 1)
    const mp4 = join(dir, 'out.mp4')
    writeFileSync(mp4, await bytes(video.file))
    const ffprobe = new Toolchain(DATA!).bin('ffmpeg', 'ffprobe')!
    const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', mp4], { encoding: 'utf8' })
    const got = JSON.parse(probe.stdout) as { format: { duration: string }; streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }> }
    console.log(`video: ${got.format.duration} s, ${JSON.stringify(got.streams)}, ${video.file.size} bytes`)
    expect(Number(got.format.duration)).toBeCloseTo(60, 0)
    expect(got.streams).toEqual([expect.objectContaining({ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 })])
  }, 600_000)

  it('the pictures are twelve files at the width picked, and the OpenDocument copy draws its own 12 pages', async () => {
    const pics = await timed('pictures, PNG 1920', () => call('work.slides.preview', { itemId, format: 'pics', picture: { type: 'png', width: 1920 } }))
    expect(pics.thumbs).toHaveLength(12)
    const zip = await bytes(pics.file)
    expect(zip.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004')
    expect((zip.toString('latin1').match(/Slide \d\d\.png/g) ?? []).length).toBeGreaterThanOrEqual(12)
    const odp = await timed('odp', () => call('work.slides.preview', { itemId, format: 'odp' }))
    expect(odp.pdf!.pages).toBe(12)
    expect((await bytes(odp.file)).toString('latin1')).toContain('application/vnd.oasis.opendocument.presentation')
  }, 300_000)

  it.skipIf(!PLAYWRIGHT)('notes pages and handouts are printed by Chromium: 12 notes pages, 2 sheets of six', async () => {
    const notes = await timed('notes pages', () => call('work.slides.preview', { itemId, format: 'pdf', layout: 'notes' }))
    expect(await pages(await bytes(notes.file))).toBe(12)
    const six = await timed('handouts of 6', () => call('work.slides.preview', { itemId, format: 'pdf', layout: { handouts: 6 } }))
    expect(await pages(await bytes(six.file))).toBe(2)
    writeFileSync('/tmp/sld7-handouts.pdf', await bytes(six.file))
    writeFileSync('/tmp/sld7-notes.pdf', await bytes(notes.file))
    expect(readFileSync('/tmp/sld7-notes.pdf').length).toBeGreaterThan(0)
  }, 300_000)
})
