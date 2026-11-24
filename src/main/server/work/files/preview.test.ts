import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync, gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileArchive, FilePreview } from '@shared/contract-work-files'
import type { ConvertJob } from '../formats/jobs'
import { setCloudDir } from '../office/files/library'

/**
 * Previews and thumbnails (preview.ts) and an archive's listing (zipdir.ts), through the module's own wire and
 * each rule alone: the sources in their order, the two caches, the queue's bounds, who gets nothing, the second
 * look at the file before an answer, and that a file kept in the cloud is never read. The tools (LibreOffice,
 * pypdfium2, ffmpeg, the Mac's thumbnailer, Electron's decoder) are stood in for: `ctx.convert` and
 * `previewSeams`. Every file is a dummy.
 */

const opened = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const note =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      if (typeof args[0] === 'string') opened.push(args[0])
      return fn(...args)
    }
  return { ...fs, open: note(fs.open), readFile: note(fs.readFile) }
})

const { NoConverterError } = await import('../formats/jobs')
const { setRoots } = await import('../office/files/library')
const { closeFilesState } = await import('./handle')
const { registerFilePreviewer } = await import('./hooks')
const { files } = await import('./index')
const { forgetLibraries } = await import('./places/libraries')
const { NO_PREVIEW, PREVIEW_CONVERTERS, previewMemory, previewOne, previewSeams, previewsDir, previewScratch, prunePreviews, RenderQueue, sheetCells, sourcesFor, WAITING_MAX } = await import('./preview')
const { encodePng, gridPage, pngSize, textPage } = await import('./sketch')
const { approver, at, HOST, makeRig, peer, phone, reader, thread, window, WS } = await import('./testkit')
const { zipListing } = await import('./zipdir')

type Caller = typeof window

const png = (width: number, height = width): Buffer => encodePng(width, height, Buffer.alloc(width * height * 3, 200))

/** A zip made here: each entry stored or deflated, names in UTF-8; no CRC (no reader of ours checks one). */
function makeZip(entries: { name: string; data?: Buffer | string; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let off = 0
  for (const e of entries) {
    const raw = Buffer.from(e.data ?? '')
    const data = e.deflate ? deflateRawSync(raw) : raw
    const name = Buffer.from(e.name, 'utf8')
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x800, 6)
    head.writeUInt16LE(e.deflate ? 8 : 0, 8)
    head.writeUInt32LE(data.length, 18)
    head.writeUInt32LE(raw.length, 22)
    head.writeUInt16LE(name.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x800, 8)
    dir.writeUInt16LE(e.deflate ? 8 : 0, 10)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt32LE(raw.length, 24)
    dir.writeUInt16LE(name.length, 28)
    dir.writeUInt32LE(off, 42)
    locals.push(head, name, data)
    central.push(dir, name)
    off += 30 + name.length + data.length
  }
  const dirBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(dirBytes.length, 12)
  end.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, dirBytes, end])
}

/** A `.tcsheet` as the sheets pillar writes one: its meta, and the snapshot it names. */
const tcsheet = (cells: Record<number, Record<number, { v: unknown }>>): Buffer =>
  makeZip([
    { name: 'meta.json', data: JSON.stringify({ title: 'Dummy roster', rev: 3, snapRev: 2 }) },
    { name: 'ops.json', data: '[]' },
    { name: 'snapshots/2.json.gz', data: gzipSync(JSON.stringify({ sheetOrder: ['s1'], sheets: { s1: { id: 's1', cellData: cells } } })) }
  ])

/** What the stand-in runner did, and what it lacks. */
let jobs: ConvertJob[]
let missing: Set<string>
let gate: Map<string, Promise<void>>
let running: number
let mostAtOnce: number
let pdfPages: number
let scaled: number
let looked: number

async function convert(job: ConvertJob): Promise<{ output: string; ranOn: string; warnings: string[] }> {
  jobs.push(job)
  const pair = `${job.from}→${job.to}`
  if (missing.has(pair)) throw new NoConverterError(`${pair.split('→')[0] === 'pdf' ? 'pdf-tools' : 'libreoffice'} is not installed on ${HOST}`)
  running++
  mostAtOnce = Math.max(mostAtOnce, running)
  try {
    await gate.get(pair)
    const out = job.output!
    if (job.to === 'extract') writeFileSync(out, JSON.stringify({ pages: pdfPages }))
    else if (job.to === 'pdf') writeFileSync(out, '%PDF-1.7 dummy')
    else {
      const edge = Number(job.options?.width ?? job.options?.edge)
      writeFileSync(out, png(edge, Math.round(edge * 1.3)))
    }
    return { output: out, ranOn: HOST, warnings: [] }
  } finally {
    running--
  }
}

let rig: ReturnType<typeof makeRig>
beforeEach(() => {
  rig = makeRig()
  ;(rig.ctx as unknown as { convert: typeof convert }).convert = convert
  jobs = []
  missing = new Set()
  gate = new Map()
  running = 0
  mostAtOnce = 0
  pdfPages = 3
  scaled = 0
  looked = 0
  previewSeams.scale = async (_bytes, edge) => {
    scaled++
    return { png: png(edge), width: edge, height: edge }
  }
  previewSeams.quickLook = async (_path, edge) => {
    looked++
    return png(edge)
  }
  previewSeams.platform = 'linux'
  previewSeams.rendered = undefined
  writeFileSync(join(rig.folder, 'Poster.png'), 'png bytes')
  writeFileSync(join(rig.folder, 'Banner.webp'), 'webp bytes')
  writeFileSync(join(rig.folder, 'Bracket.pdf'), '%PDF dummy')
  writeFileSync(join(rig.folder, 'Highlights.mp4'), 'video bytes')
  writeFileSync(join(rig.folder, 'Plan.docx'), makeZip([{ name: 'word/document.xml', data: '<w:document/>' }, { name: 'docProps/thumbnail.jpeg', data: 'jpeg bytes' }]))
  writeFileSync(join(rig.folder, 'Bare.docx'), makeZip([{ name: 'word/document.xml', data: '<w:document/>' }]))
  writeFileSync(join(rig.folder, 'Notes.tcdoc'), makeZip([{ name: 'state.yjs' }, { name: 'preview.md', data: '# Dummy Esports kickoff\n\nDoors at five.', deflate: true }]))
  writeFileSync(join(rig.folder, 'Roster.tcsheet'), tcsheet({ 0: { 0: { v: 'Player' }, 1: { v: 'Score' } }, 1: { 0: { v: 'Dummy One' }, 1: { v: 42 } } }))
  writeFileSync(join(rig.folder, 'Kit.zip'), makeZip([{ name: 'Kit/' }, { name: 'Kit/rules.txt', data: 'play fair', deflate: true }, { name: 'Kit/logo.png', data: 'png' }]))
  writeFileSync(join(rig.team, 'General', 'Shared photo.png'), 'png bytes')
  writeFileSync(join(rig.team, 'General', 'Shared kit.zip'), makeZip([{ name: 'a.txt', data: 'a' }]))
  opened.length = 0
})
afterEach(() => {
  closeFilesState(rig.db)
  rig.close()
})

const call = async <T>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> => {
  const out = await files.handle!({ id: '1', method, params: { workspaceId: WS, ...params } } as never, rig.ctx, by)
  return (out as { result: T }).result
}
const mine = (name: string) => at(join(rig.folder, name))
const shared = (name: string) => at(join(rig.team, 'General', name))
const one = (ref: ReturnType<typeof at>, want: Parameters<typeof previewOne>[4], by: Caller = window) => previewOne(rig.ctx, by, WS, ref, want, 'work.files.thumbs')
const via = async (ref: ReturnType<typeof at>, want: Parameters<typeof previewOne>[4] = { thumb: 192 }): Promise<string> => {
  const got = await one(ref, want)
  return 'via' in got ? got.via : `none: ${got.none}`
}
const pairs = (): string[] => jobs.map((j) => `${j.from}→${j.to}`)
const kept = (): string[] => (existsSync(previewsDir(rig.dataDir)) ? readdirSync(previewsDir(rig.dataDir)) : [])
const scratch = (): string[] => (existsSync(previewScratch(rig.dataDir)) ? readdirSync(previewScratch(rig.dataDir)) : [])

describe('where a picture comes from, cheapest first', () => {
  it('scales a PNG or JPEG in this process, and every other picture through ffmpeg on this host', async () => {
    expect(await via(mine('Poster.png'))).toBe('picture')
    expect(scaled).toBe(1)
    expect(jobs).toEqual([])
    expect(await via(mine('Banner.webp'))).toBe('picture')
    expect(pairs()).toEqual(['image→scaled.png'])
    expect(jobs[0]!.options).toEqual({ edge: 192 })
  })

  it("takes an Office file's own thumbnail from its zip before the Mac's thumbnailer or LibreOffice", async () => {
    previewSeams.platform = 'darwin'
    expect(await via(mine('Plan.docx'))).toBe('zip-thumbnail')
    expect(looked).toBe(0)
    expect(jobs).toEqual([])
    // With no thumbnail of its own, a Mac's thumbnailer is next, still before any conversion.
    expect(await via(mine('Bare.docx'))).toBe('quicklook')
    expect(jobs).toEqual([])
  })

  it('draws an Office file through LibreOffice to PDF, then its page, where nothing cheaper has one', async () => {
    expect(await via(mine('Bare.docx'))).toBe('libreoffice')
    expect(pairs()).toEqual(['docx→pdf', 'pdf→png'])
    expect(looked).toBe(0)
  })

  it("draws a PDF's page through pypdfium2, counting its pages for a preview", async () => {
    expect(await via(mine('Bracket.pdf'))).toBe('pdf')
    expect(pairs()).toEqual(['pdf→png'])
    const page2 = await one(mine('Bracket.pdf'), { page: 2, width: 800 })
    expect(page2).toMatchObject({ via: 'pdf', pages: 3, width: 800 })
    expect(pairs().slice(1)).toEqual(['pdf→extract', 'pdf→png'])
    expect(jobs[2]!.options).toEqual({ page: 2, width: 800 })
    // The count is kept by file and version: a page past the end asks nothing of the runner.
    expect(await one(mine('Bracket.pdf'), { page: 7, width: 800 })).toMatchObject({ none: NO_PREVIEW.page(7) })
    expect(jobs).toHaveLength(3)
  })

  it('answers at most 20 pages of a longer PDF', async () => {
    pdfPages = 300
    expect(await one(mine('Bracket.pdf'), { page: 1, width: 400 })).toMatchObject({ pages: 20 })
  })

  it("takes a video's frame a second in, through ffmpeg", async () => {
    expect(await via(mine('Highlights.mp4'))).toBe('video')
    expect(pairs()).toEqual(['video→frame.png'])
    expect(jobs[0]!.options).toEqual({ at: 1, edge: 192 })
  })

  it("draws a text file's head, a document's first lines and a sheet's first cells itself", async () => {
    expect(await via(mine('notes.txt'))).toBe('text')
    expect(await via(mine('Notes.tcdoc'))).toBe('tcdoc')
    expect(await via(mine('Roster.tcsheet'))).toBe('tcsheet')
    expect(jobs).toEqual([])
    expect((await sheetCells(join(rig.folder, 'Roster.tcsheet'), 2, 2))).toEqual([
      ['Player', 'Score'],
      ['Dummy One', 42]
    ])
  })

  it('asks a kind’s registered previewer first, and takes its page count', async () => {
    const off = registerFilePreviewer('pdf', async (_source, o) => ({ png: png(o.width), pages: 9 }))
    try {
      expect(await one(mine('Bracket.pdf'), { page: 1, width: 300 })).toMatchObject({ via: 'registered', pages: 9, width: 300 })
      expect(jobs).toEqual([])
    } finally {
      off()
    }
    // Turned off, the kind's picture is ours again, drawn again rather than the previewer's from the cache.
    expect(await via(mine('Bracket.pdf'), { page: 1, width: 300 })).toBe('pdf')
    // A previewer that answers null passes to the sources.
    const none = registerFilePreviewer('pdf', async () => null)
    try {
      expect(await via(mine('Bracket.pdf'), { page: 1, width: 301 })).toBe('pdf')
    } finally {
      none()
    }
  })

  it("draws a preview's page from the sources that draw pages, and a file's own small picture only when none can", async () => {
    expect(sourcesFor({ name: 'Plan.docx' }, { page: 1, width: 900 }).map((s) => s.name)).toEqual(['libreoffice', 'zip-thumbnail'])
    expect(sourcesFor({ name: 'Plan.docx' }, { page: 2, width: 900 }).map((s) => s.name)).toEqual(['libreoffice'])
    expect(sourcesFor({ name: 'Plan.docx' }, { thumb: 192 }).map((s) => s.name)).toEqual(['zip-thumbnail', 'libreoffice'])
    expect(await via(mine('Plan.docx'), { page: 1, width: 900 })).toBe('libreoffice')
    writeFileSync(join(rig.folder, 'Plan again.docx'), readFileSync(join(rig.folder, 'Plan.docx')))
    missing.add('docx→pdf')
    expect(await one(mine('Plan again.docx'), { page: 1, width: 900 })).toMatchObject({ via: 'zip-thumbnail', pages: 1 })
  })

  it('answers no picture for an archive or a sound, and a folder says it is one', async () => {
    expect(await one(mine('Kit.zip'), { thumb: 192 })).toMatchObject({ none: NO_PREVIEW.none })
    expect(await one(at(join(rig.folder, 'Events')), { thumb: 192 })).toMatchObject({ none: NO_PREVIEW.folder })
  })
})

describe('the wire', () => {
  it('answers a page as base64 PNG with its size and pages, and thumbs as base64 or null in order', async () => {
    const page = await call<FilePreview>('work.files.preview', { ref: mine('Bracket.pdf'), page: 2, width: 640 })
    expect(page).toMatchObject({ pages: 3, width: 640, height: 832 })
    expect(pngSize(Buffer.from((page as { png: string }).png, 'base64'))).toEqual({ width: 640, height: 832 })
    const thumbs = await call<{ thumbs: (string | null)[] }>('work.files.thumbs', { refs: [mine('Poster.png'), mine('Kit.zip'), mine('notes.txt')], size: 288 })
    expect(thumbs.thumbs.map((t) => (t ? pngSize(Buffer.from(t, 'base64'))?.width : null))).toEqual([288, null, 288])
  })

  it('answers no picture past 2 MB', async () => {
    previewSeams.scale = async () => ({ png: Buffer.concat([png(64), Buffer.alloc(2 * 1024 * 1024)]), width: 64, height: 64 })
    expect(await call<FilePreview>('work.files.preview', { ref: mine('Poster.png'), width: 640 })).toMatchObject({ none: NO_PREVIEW.big })
  })
})

describe('his own places: kept on disk', () => {
  it('answers the same picture again from the disk with no second render, and renders a changed file again', async () => {
    expect(await via(mine('Bracket.pdf'))).toBe('pdf')
    expect(kept().filter((n) => n.endsWith('.png'))).toHaveLength(1)
    expect(await via(mine('Bracket.pdf'))).toBe('cache')
    expect(jobs).toHaveLength(1)
    // Another size is another picture.
    expect(await via(mine('Bracket.pdf'), { thumb: 288 })).toBe('pdf')
    // The version is in the key: a file that changed renders again.
    writeFileSync(join(rig.folder, 'Bracket.pdf'), '%PDF dummy, longer now')
    expect(await via(mine('Bracket.pdf'))).toBe('pdf')
    expect(jobs).toHaveLength(3)
  })

  it('names the version each page is of, and a saved file another', async () => {
    const first = await call<FilePreview>('work.files.preview', { ref: mine('Bracket.pdf'), width: 600 })
    const again = await call<FilePreview>('work.files.preview', { ref: mine('Bracket.pdf'), width: 600 })
    expect('version' in first && first.version).toMatch(/^[0-9a-f]{16}$/)
    expect('version' in again && again.version).toBe('version' in first && first.version)
    writeFileSync(join(rig.folder, 'Bracket.pdf'), '%PDF dummy, saved since')
    const saved = await call<FilePreview>('work.files.preview', { ref: mine('Bracket.pdf'), width: 600 })
    expect('version' in saved && saved.version).not.toBe('version' in first && first.version)
    // A page the saved file no longer has names its version too, so a pager of the old one starts over.
    const gone = await call<FilePreview>('work.files.preview', { ref: mine('Bracket.pdf'), page: 7, width: 600 })
    expect(gone).toMatchObject({ none: NO_PREVIEW.page(7) })
    expect('version' in gone && gone.version).toBe('version' in saved && saved.version)
  })

  it("keeps an Office file's PDF, so its next page is one draw", async () => {
    await one(mine('Bare.docx'), { page: 1, width: 600 })
    await one(mine('Bare.docx'), { page: 2, width: 600 })
    expect(pairs()).toEqual(['docx→pdf', 'pdf→extract', 'pdf→png', 'pdf→png'])
    expect(kept().filter((n) => n.endsWith('.pdf'))).toHaveLength(1)
  })

  it('prunes what was not used in 30 days, then the least used until it holds the cap', async () => {
    const dir = previewsDir(rig.dataDir)
    mkdirSync(dir, { recursive: true })
    const now = Date.parse('2026-11-23T12:00:00Z')
    const day = 24 * 60 * 60 * 1000
    const put = (name: string, size: number, usedDaysAgo: number): void => {
      writeFileSync(join(dir, name), Buffer.alloc(size))
      const t = new Date(now - usedDaysAgo * day)
      utimesSync(join(dir, name), t, t)
    }
    put('old.png', 10, 31)
    put('least.png', 100, 10)
    put('middle.png', 100, 5)
    put('fresh.png', 100, 1)
    const done = await prunePreviews(rig.dataDir, { now, max: 250 })
    expect(done).toEqual({ removed: 2, bytes: 200 })
    expect(readdirSync(dir).sort()).toEqual(['fresh.png', 'middle.png'])
  })

  it('takes a hit as a use, so a picture used again outlives one that was not', async () => {
    await via(mine('Poster.png'))
    await via(mine('notes.txt'))
    const dir = previewsDir(rig.dataDir)
    const past = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
    for (const name of readdirSync(dir)) utimesSync(join(dir, name), past, past)
    expect(await via(mine('Poster.png'))).toBe('cache')
    await prunePreviews(rig.dataDir, { days: 10 })
    expect(readdirSync(dir)).toHaveLength(1)
    expect(await via(mine('Poster.png'))).toBe('cache')
  })
})

describe('a shared library: memory only, his window only', () => {
  it('never touches the disk cache, leaves no scratch, and answers again from memory', async () => {
    expect(await via(shared('Shared photo.png'))).toBe('picture')
    expect(kept()).toEqual([])
    expect(scratch()).toEqual([])
    expect(previewMemory(rig.db).count).toBe(1)
    expect(await via(shared('Shared photo.png'))).toBe('memory')
    expect(scaled).toBe(1)
  })

  it("never asks the Mac's thumbnailer for a shared file, which may keep its own picture of it on disk", async () => {
    previewSeams.platform = 'darwin'
    writeFileSync(join(rig.team, 'General', 'Bare plan.docx'), makeZip([{ name: 'word/document.xml', data: '<w:document/>' }]))
    expect(await via(shared('Bare plan.docx'))).toBe('libreoffice')
    expect(looked).toBe(0)
    // His own file still takes it, before any conversion.
    expect(await via(mine('Bare.docx'))).toBe('quicklook')
  })

  it("leaves nothing of a conversion: its job is marked shared, and its PDF goes with the render's scratch", async () => {
    writeFileSync(join(rig.team, 'General', 'Bare plan.docx'), makeZip([{ name: 'word/document.xml', data: '<w:document/>' }]))
    expect(await via(shared('Bare plan.docx'))).toBe('libreoffice')
    expect(jobs.every((j) => j.here === true && j.shared === true)).toBe(true)
    expect(kept()).toEqual([])
    expect(scratch()).toEqual([])
  })

  it('drops its pictures when the library is turned off', async () => {
    await via(shared('Shared photo.png'))
    expect(previewMemory(rig.db).count).toBe(1)
    setRoots(rig.db, [{ folder: rig.team, off: true }])
    forgetLibraries(rig.db)
    await via(mine('Poster.png'))
    expect(previewMemory(rig.db).count).toBe(0)
    expect(await one(shared('Shared photo.png'), { thumb: 192 })).toMatchObject({ none: NO_PREVIEW.reach })
  })

  it('answers nothing to a remote key, the phone or another host, even one whose fence names the library', async () => {
    rig.roots.push(rig.team)
    for (const by of [phone, approver, reader, peer]) {
      expect(await one(shared('Shared photo.png'), { thumb: 192 }, by)).toMatchObject({ none: NO_PREVIEW.sharedHere })
      expect((await call<{ thumbs: unknown[] }>('work.files.thumbs', { refs: [shared('Shared photo.png')], size: 192 }, by)).thumbs).toEqual([null])
    }
    expect(scaled).toBe(0)
    expect(opened).toEqual([])
    // His own folder's files reach the phone.
    expect(await via(mine('Poster.png'))).toBe('picture')
    expect(await one(mine('notes.txt'), { thumb: 192 }, phone)).toMatchObject({ via: 'text' })
  })
})

describe('who gets nothing', () => {
  it('gives a thread nothing from preview or thumbs, its own workspace included, and reads nothing', async () => {
    for (const ref of [mine('Poster.png'), shared('Shared photo.png')]) {
      expect(await call<FilePreview>('work.files.preview', { ref, width: 400 }, thread())).toMatchObject({ none: NO_PREVIEW.thread })
      expect((await call<{ thumbs: unknown[] }>('work.files.thumbs', { refs: [ref], size: 192 }, thread())).thumbs).toEqual([null])
    }
    expect(opened).toEqual([])
    expect(scaled + jobs.length).toBe(0)
  })

  it('answers a plain tile for a file on another computer, in the Windows VM, or out of reach', async () => {
    expect(await one(at('/Users/dummy/Poster.png', 'env_mac'), { thumb: 192 })).toMatchObject({ none: NO_PREVIEW.elsewhere })
    expect(await one(at('C:\\Users\\dummy\\OneDrive\\Poster.png'), { thumb: 192 })).toMatchObject({ none: NO_PREVIEW.vm })
    expect(await one(at(join(rig.outside, 'secret.txt')), { thumb: 192 })).toMatchObject({ none: NO_PREVIEW.reach })
    expect(await one(at(join(rig.otherFolder, 'Payroll.xlsx')), { thumb: 192 }, thread())).toMatchObject({ none: NO_PREVIEW.thread })
    expect(await one(mine('Gone.png'), { thumb: 192 })).toMatchObject({ none: NO_PREVIEW.gone })
    expect(opened).toEqual([])
  })

  it('reads no byte of a file kept in the cloud', async () => {
    const sparse = [join(rig.folder, 'Cloud photo.png'), join(rig.folder, 'Cloud plan.docx'), join(rig.team, 'General', 'Cloud notes.txt')]
    for (const path of sparse) {
      writeFileSync(path, '')
      truncateSync(path, 400_000)
    }
    // A disk that gives a sparse file blocks anyway cannot stand in for the cloud.
    if (statSync(sparse[0]!).blocks !== 0) return
    const got = await call<{ thumbs: unknown[] }>('work.files.thumbs', { refs: sparse.map((path) => at(path)), size: 192 })
    expect(got.thumbs).toEqual([null, null, null])
    for (const path of sparse) expect(await call<FilePreview>('work.files.preview', { ref: at(path), width: 800 })).toMatchObject({ none: NO_PREVIEW.cloud })
    expect(opened.filter((path) => /Cloud /.test(path))).toEqual([])
    expect(jobs).toEqual([])
    expect(scaled).toBe(0)
  })
})

describe('no conversion leaves this host', () => {
  it('runs every job here, and a host without LibreOffice answers a plain tile', async () => {
    await via(mine('Bare.docx'))
    await via(mine('Highlights.mp4'))
    await via(mine('Banner.webp'))
    expect(jobs.length).toBeGreaterThan(0)
    expect(jobs.every((j) => j.here === true)).toBe(true)
    missing.add('docx→pdf')
    writeFileSync(join(rig.folder, 'Bare again.docx'), readFileSync(join(rig.folder, 'Bare.docx')))
    expect(await one(mine('Bare again.docx'), { page: 1, width: 900 })).toMatchObject({ none: NO_PREVIEW.tool })
    expect((await call<{ thumbs: unknown[] }>('work.files.thumbs', { refs: [mine('Bare again.docx')], size: 416 })).thumbs).toEqual([null])
  })
})

describe('the queue', () => {
  it('runs two renders at a time', async () => {
    let open!: () => void
    gate.set('image→scaled.png', new Promise<void>((resolve) => (open = resolve)))
    const names = ['A', 'B', 'C', 'D', 'E'].map((n) => `Dummy ${n}.webp`)
    for (const name of names) writeFileSync(join(rig.folder, name), name)
    const asks = names.map((name) => via(mine(name)))
    await new Promise((r) => setTimeout(r, 30))
    expect(running).toBe(2)
    open()
    expect(await Promise.all(asks)).toEqual(names.map(() => 'picture'))
    expect(mostAtOnce).toBe(2)
  })

  it("holds 40 asks waiting per caller and drops the caller's oldest, never another caller's", async () => {
    const q = new RenderQueue(2, WAITING_MAX)
    const release: (() => void)[] = []
    const work = (): Promise<string> => new Promise((resolve) => release.push(() => resolve('drawn')))
    const first = [q.run('local', work), q.run('local', work)]
    const theirs = q.run('key:phone', work)
    const waiting = Array.from({ length: WAITING_MAX }, () => q.run('local', work))
    expect(q.load).toEqual({ running: 2, waiting: WAITING_MAX + 1 })
    // The 41st of his: the oldest of his waiting answers at once, dropped; the phone's ask still waits.
    const newest = q.run('local', work)
    const dropped = await Promise.race([waiting[0]!.then((v) => (typeof v === 'symbol' ? 'dropped' : v)), new Promise((r) => setTimeout(() => r('still waiting'), 20))])
    expect(dropped).toBe('dropped')
    expect(q.load.waiting).toBe(WAITING_MAX + 1)
    // Every other ask runs in its turn.
    for (let i = 0; i < 2 + 1 + WAITING_MAX; i++) {
      await new Promise((r) => setTimeout(r, 0))
      release.shift()?.()
    }
    while (release.length) {
      release.shift()!()
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(await Promise.all([...first, theirs, ...waiting.slice(1), newest])).toEqual(Array(2 + 1 + WAITING_MAX).fill('drawn'))
  })

  it('drops an ask whose caller went away while it waited', async () => {
    const q = new RenderQueue(1, 40)
    let release!: () => void
    const busy = q.run('local', () => new Promise<string>((r) => (release = () => r('drawn'))))
    const cancel = new AbortController()
    const later = q.run('local', async () => 'drawn', cancel.signal)
    cancel.abort()
    expect(typeof (await later)).toBe('symbol')
    release()
    expect(await busy).toBe('drawn')
    expect(q.load).toEqual({ running: 0, waiting: 0 })
  })

  it('answers a dropped ask as a plain tile on the wire', async () => {
    const cancel = new AbortController()
    cancel.abort()
    expect(await previewOne(rig.ctx, window, WS, mine('Banner.webp'), { thumb: 192 }, 'work.files.thumbs', cancel.signal)).toMatchObject({ none: NO_PREVIEW.busy })
  })
})

describe('access is checked again before the answer', () => {
  it('answers nothing, and keeps nothing, for a file moved out of reach during its render', async () => {
    previewSeams.rendered = (path) => renameSync(path, join(rig.outside, 'Bracket.pdf'))
    expect(await call<FilePreview>('work.files.preview', { ref: mine('Bracket.pdf'), width: 600 })).toMatchObject({ none: NO_PREVIEW.reach })
    expect(kept().filter((n) => n.endsWith('.png'))).toEqual([])
  })

  it('answers nothing, and keeps nothing, for a file that changed during its render', async () => {
    previewSeams.rendered = (path) => writeFileSync(path, '%PDF dummy, and a page more')
    expect(await call<FilePreview>('work.files.preview', { ref: mine('Bracket.pdf'), width: 600 })).toMatchObject({ none: NO_PREVIEW.changed })
    expect(kept().filter((n) => n.endsWith('.png'))).toEqual([])
    expect(previewMemory(rig.db).count).toBe(0)
  })

  it('answers nothing, and leaves nothing on disk, for a file that others came to be able to open during its render', async () => {
    // The workspace's folder is found to lie in a cloud folder of this computer: from then on it is shared.
    previewSeams.rendered = () => setCloudDir(() => rig.base)
    expect(await one(mine('Poster.png'), { thumb: 192 })).toMatchObject({ none: NO_PREVIEW.changed })
    expect(kept()).toEqual([])
    expect(previewMemory(rig.db).count).toBe(0)
  })

  it('answers nothing from the cache for a file now out of reach', async () => {
    await via(mine('Poster.png'))
    previewSeams.rendered = (path) => renameSync(path, join(rig.outside, 'Poster.png'))
    expect(await one(mine('Poster.png'), { thumb: 192 })).toMatchObject({ none: NO_PREVIEW.reach })
  })
})

describe('the converters Files registers', () => {
  it("takes a video's frame, and its first frame when the video is shorter than a second", async () => {
    const calls: string[][] = []
    const out = join(rig.base, 'frame.png')
    const run = {
      tools: { bin: () => '/opt/ffmpeg' },
      threads: 2,
      run: async (_cmd: string, args: string[]) => {
        calls.push(args)
        // The seek finds no frame a second in; the first frame is taken instead.
        if (calls.length === 2) writeFileSync(out, png(64))
        return { code: 0, out: '' }
      }
    }
    await PREVIEW_CONVERTERS[0]!.run({ from: 'video', to: 'frame.png', input: join(rig.folder, 'Highlights.mp4'), output: out, options: { at: 1, edge: 9999 } }, run as never)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.join(' ')).toContain('select=')
    expect(calls[1]!.join(' ')).toContain("min(2048,iw)")
  })
})

describe('the drawn pages', () => {
  it('are PNGs of a page, a sheet landscape, never wider than 1024', () => {
    expect(pngSize(textPage('# Dummy\nkickoff at five', 192).png)).toEqual({ width: 192, height: 248 })
    expect(pngSize(gridPage([['a', 1]], 416).png)).toEqual({ width: 416, height: 312 })
    expect(textPage('x', 2048).width).toBe(1024)
  })
})

describe("an archive's listing", () => {
  it('reads only the directory: a zip whose entry data is garbage still lists', async () => {
    const zip = makeZip([{ name: 'Kit/' }, { name: 'Kit/Rules.txt', data: 'play fair, Dummy Esports', deflate: true }, { name: 'Kit/Logo.png', data: 'png bytes here' }])
    // Every byte before the directory, local headers included, is spoiled.
    const dirAt = zip.readUInt32LE(zip.length - 6)
    for (let i = 0; i < dirAt; i++) zip[i] = (i * 31 + 7) & 0xff
    writeFileSync(join(rig.folder, 'Spoiled.zip'), zip)
    expect(await call<FileArchive>('work.files.archive', { ref: mine('Spoiled.zip') })).toEqual({
      entries: [
        { name: 'Kit/', size: 0, dir: true },
        { name: 'Kit/Rules.txt', size: 24, dir: false },
        { name: 'Kit/Logo.png', size: 14, dir: false }
      ],
      more: false
    })
  })

  it('lists 2,000 entries at most and says there are more', async () => {
    writeFileSync(join(rig.folder, 'Big.zip'), makeZip(Array.from({ length: 2005 }, (_, i) => ({ name: `f${i}.txt` }))))
    const got = await call<FileArchive>('work.files.archive', { ref: mine('Big.zip') })
    expect(got.entries).toHaveLength(2000)
    expect(got.entries[1999]!.name).toBe('f1999.txt')
    expect(got.more).toBe(true)
    expect(await zipListing(join(rig.folder, 'Big.zip'), 5000)).toMatchObject({ more: false })
  })

  it('answers nothing for another archive type, and opens nothing of it', async () => {
    writeFileSync(join(rig.folder, 'Old.tar'), 'not read')
    expect(await call<FileArchive>('work.files.archive', { ref: mine('Old.tar') })).toEqual({ entries: [], more: false })
    expect(opened).toEqual([])
  })

  it('holds to the reach rules of read', async () => {
    const ok = { entries: [{ name: 'a.txt', size: 1, dir: false }], more: false }
    // The workspace's folder: every caller that may read, his threads among them.
    for (const by of [window, phone, reader, thread()]) expect((await call<FileArchive>('work.files.archive', { ref: mine('Kit.zip') }, by)).entries).toHaveLength(3)
    // Another workspace's thread, and anything outside, are refused.
    await expect(call('work.files.archive', { ref: mine('Kit.zip') }, thread('t2'))).rejects.toThrow()
    await expect(call('work.files.archive', { ref: at(join(rig.outside, 'secret.txt')) })).rejects.toThrow()
    // A shared library: his own window alone.
    expect(await call<FileArchive>('work.files.archive', { ref: shared('Shared kit.zip') })).toEqual(ok)
    rig.roots.push(rig.team)
    for (const by of [phone, approver, peer, thread()]) await expect(call('work.files.archive', { ref: shared('Shared kit.zip') }, by)).rejects.toThrow()
  })

  it('refuses a zip kept in the cloud without reading it', async () => {
    const path = join(rig.folder, 'Cloud kit.zip')
    writeFileSync(path, '')
    truncateSync(path, 400_000)
    if (statSync(path).blocks !== 0) return
    await expect(call('work.files.archive', { ref: at(path) })).rejects.toThrow('kept in the cloud')
    expect(opened.filter((p) => p.includes('Cloud kit'))).toEqual([])
  })

  it('reads one entry, deflated or stored, and nothing past its bound', async () => {
    const { zipEntry } = await import('./zipdir')
    const path = join(rig.folder, 'Kit.zip')
    expect((await zipEntry(path, 'Kit/rules.txt', 1024))?.toString()).toBe('play fair')
    expect((await zipEntry(path, 'Kit/logo.png', 1024))?.toString()).toBe('png')
    expect(await zipEntry(path, 'Kit/rules.txt', 4)).toBeNull()
    expect(await zipEntry(path, 'Kit/missing.txt', 1024)).toBeNull()
    expect(readFileSync(path).length).toBeGreaterThan(0)
  })
})
