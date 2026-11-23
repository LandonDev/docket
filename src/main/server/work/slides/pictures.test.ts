import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deckPicture, ONE_AT_A_TIME, pageName, prunePages, RESIDENT_MOST, splitPdf, stitchPdf, type PictureDeps, type SlideRenderer } from './pictures'

/**
 * A deck's picture kept slide by slide: which slides are drawn again after an edit, how, and what happens when
 * the LibreOffice kept running fails. The "deck" here is a text file of one line a slide and a page is a PDF
 * page as wide as that line's number, so a test reads which slide a page is.
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-slides-pictures-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const key = (n: number): string => n.toString(16).padStart(64, '0')
/** A PDF with one page per width given. */
async function pdfOf(widths: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (const w of widths) doc.addPage([w, 100])
  return doc.save()
}
const widthsOf = async (path: string): Promise<number[]> => (await PDFDocument.load(readFileSync(path))).getPages().map((p) => p.getWidth())
/** A deck file: its slides' widths, one a line. */
function deckFile(widths: number[]): string {
  const path = join(dir, `deck-${Math.random().toString(36).slice(2)}.txt`)
  writeFileSync(path, widths.join('\n'))
  return path
}
const read = (input: string): number[] => readFileSync(input, 'utf8').split('\n').map(Number)

function rig(over: Partial<SlideRenderer> | null = {}) {
  const calls: string[] = []
  const renderer: SlideRenderer | null =
    over === null
      ? null
      : {
          slide: async (input, page, output) => {
            calls.push(`slide ${page}`)
            writeFileSync(output, await pdfOf([read(input)[page - 1]]))
            return read(input).length
          },
          deck: async (input, output) => {
            calls.push('deck')
            writeFileSync(output, await pdfOf(read(input)))
          },
          ...over,
        }
  const deps: PictureDeps = {
    dir: join(dir, 'pages'),
    salt: SALT,
    renderer,
    whole: async (input, output) => {
      calls.push('whole')
      writeFileSync(output, await pdfOf(read(input)))
    },
    log: (line) => void calls.push(`log ${line}`),
  }
  return { deps, calls }
}
const slides = (keys: number[]) => keys.map((k) => ({ draws: key(k) }))
const SALT = 'engine one'
/** The kept page of a slide whose parts hash to `key(n)`, as this rig's engine draws it. */
const page = (n: number, salt = SALT): string => `${pageName(salt, key(n))}.pdf`

describe('a deck drawn slide by slide', () => {
  it('draws a deck it has never seen as one whole export, and keeps each page by its slide', async () => {
    const { deps, calls } = rig()
    const out = join(dir, 'a.pdf')
    expect(await deckPicture(deps, deckFile([10, 20, 30, 40, 50, 60]), slides([1, 2, 3, 4, 5, 6]), out)).toEqual({ way: 'whole', drawn: 6 })
    expect(calls).toEqual(['deck'])
    expect(await widthsOf(out)).toEqual([10, 20, 30, 40, 50, 60])
    expect(readdirSync(deps.dir).sort()).toEqual([1, 2, 3, 4, 5, 6].map((k) => page(k)).sort())
    expect(await widthsOf(join(deps.dir, page(3)))).toEqual([30])
  })

  it('after an edit draws only the slide whose picture changed, alone, and puts the deck together from kept pages', async () => {
    const { deps, calls } = rig()
    await deckPicture(deps, deckFile([10, 20, 30, 40, 50, 60]), slides([1, 2, 3, 4, 5, 6]), join(dir, 'a.pdf'))
    calls.length = 0
    // Slide 3 was edited (a new hash, a new width); the rest are as they were.
    const out = join(dir, 'b.pdf')
    expect(await deckPicture(deps, deckFile([10, 20, 31, 40, 50, 60]), slides([1, 2, 33, 4, 5, 6]), out)).toEqual({ way: 'slides', drawn: 1 })
    expect(calls).toEqual(['slide 3'])
    expect(await widthsOf(out)).toEqual([10, 20, 31, 40, 50, 60])
    // The same deck again draws nothing.
    calls.length = 0
    expect(await deckPicture(deps, deckFile([10, 20, 31, 40, 50, 60]), slides([1, 2, 33, 4, 5, 6]), join(dir, 'c.pdf'))).toEqual({ way: 'kept', drawn: 0 })
    expect(calls).toEqual([])
    expect(await widthsOf(join(dir, 'c.pdf'))).toEqual([10, 20, 31, 40, 50, 60])
  })

  it('a move, a removed slide and a slide added from kept pictures draw nothing: the pages are put in the new order', async () => {
    const { deps, calls } = rig()
    await deckPicture(deps, deckFile([10, 20, 30, 40, 50, 60]), slides([1, 2, 3, 4, 5, 6]), join(dir, 'a.pdf'))
    calls.length = 0
    const out = join(dir, 'b.pdf')
    expect((await deckPicture(deps, deckFile([60, 10, 30, 30]), slides([6, 1, 3, 3]), out)).way).toBe('kept')
    expect(calls).toEqual([])
    expect(await widthsOf(out)).toEqual([60, 10, 30, 30])
  })

  it(`draws up to ${ONE_AT_A_TIME} changed slides one at a time, the same picture twice once, and more than that as one whole export`, async () => {
    const { deps, calls } = rig()
    await deckPicture(deps, deckFile([10, 20, 30, 40, 50, 60]), slides([1, 2, 3, 4, 5, 6]), join(dir, 'a.pdf'))
    calls.length = 0
    expect(await deckPicture(deps, deckFile([11, 21, 31, 41, 41, 60]), slides([11, 21, 31, 41, 41, 6]), join(dir, 'b.pdf'))).toEqual({ way: 'whole', drawn: 6 })
    expect(calls).toEqual(['deck'])
    calls.length = 0
    expect(await deckPicture(deps, deckFile([12, 22, 31, 42, 42, 60]), slides([12, 22, 31, 42, 42, 6]), join(dir, 'c.pdf'))).toEqual({ way: 'slides', drawn: 3 })
    expect(calls).toEqual(['slide 1', 'slide 2', 'slide 4'])
    expect(await widthsOf(join(dir, 'c.pdf'))).toEqual([12, 22, 31, 42, 42, 60])
  })

  it('when a slide drawn alone fails, draws the whole deck; when the LibreOffice kept running fails at that too, starts one for the job', async () => {
    const slow = rig({ slide: async () => Promise.reject(new Error('the resident did not answer in 10 s')) })
    await deckPicture(slow.deps, deckFile([10, 20, 30]), slides([1, 2, 3]), join(dir, 'a.pdf'))
    slow.calls.length = 0
    const out = join(dir, 'b.pdf')
    expect((await deckPicture(slow.deps, deckFile([10, 21, 30]), slides([1, 22, 3]), out)).way).toBe('whole')
    expect(slow.calls).toEqual(['log slides: a slide drawn alone failed, drawing the whole deck: the resident did not answer in 10 s', 'deck'])
    expect(await widthsOf(out)).toEqual([10, 21, 30])
    // The page it could not draw alone is kept from the whole export, so the next open draws nothing.
    expect(existsSync(join(slow.deps.dir, page(22)))).toBe(true)

    const dead = rig({ slide: async () => Promise.reject(new Error('gone')), deck: async () => Promise.reject(new Error('gone')) })
    expect((await deckPicture(dead.deps, deckFile([10, 20]), slides([7, 8]), join(dir, 'c.pdf'))).way).toBe('whole')
    expect(dead.calls.filter((c) => !c.startsWith('log'))).toEqual(['whole'])
    expect(await widthsOf(join(dir, 'c.pdf'))).toEqual([10, 20])
  })

  it('one that cannot run here, and a deck too long for it, go straight to the toolchain’s export and say nothing', async () => {
    const away = rig({ here: () => false })
    await deckPicture(away.deps, deckFile([10, 20, 30]), slides([1, 2, 3]), join(dir, 'a.pdf'))
    expect((await deckPicture(away.deps, deckFile([10, 21, 30]), slides([1, 22, 3]), join(dir, 'b.pdf'))).way).toBe('whole')
    expect(away.calls).toEqual(['whole', 'whole'])

    const long = rig()
    const widths = Array.from({ length: RESIDENT_MOST + 1 }, (_, i) => 10 + i)
    expect((await deckPicture(long.deps, deckFile(widths), slides(widths.map((w) => 1000 + w)), join(dir, 'c.pdf'))).way).toBe('whole')
    expect(long.calls).toEqual(['whole'])
  })

  it('a new engine draws every slide again: a kept page is one engine\'s picture of a slide', async () => {
    const { deps, calls } = rig()
    await deckPicture(deps, deckFile([10, 20]), slides([1, 2]), join(dir, 'a.pdf'))
    calls.length = 0
    // A new LibreOffice, deck script or filter: the same slides, none of their pages kept under the new word.
    expect((await deckPicture({ ...deps, salt: 'engine two' }, deckFile([10, 20]), slides([1, 2]), join(dir, 'b.pdf'))).way).toBe('slides')
    expect(calls).toEqual(['slide 1', 'slide 2'])
    expect(readdirSync(deps.dir).sort()).toEqual([page(1), page(2), page(1, 'engine two'), page(2, 'engine two')].sort())
  })

  it('a slide drawn alone is refused when LibreOffice counts other slides than the outline: page n would be another slide', async () => {
    const { deps, calls } = rig({
      slide: async (_input, _page, output) => {
        calls.push('slide')
        writeFileSync(output, await pdfOf([99]))
        return 7
      }
    })
    await deckPicture(deps, deckFile([10, 20, 30]), slides([1, 2, 3]), join(dir, 'a.pdf'))
    calls.length = 0
    const out = join(dir, 'b.pdf')
    expect((await deckPicture(deps, deckFile([10, 21, 30]), slides([1, 22, 3]), out)).way).toBe('whole')
    expect(calls.filter((c) => !c.startsWith('log'))).toEqual(['slide', 'deck'])
    expect(calls.find((c) => c.startsWith('log'))).toContain('LibreOffice found 7 slides where the outline has 3')
    // The wrong picture was never kept under the slide's name: its page is the whole export's.
    expect(await widthsOf(join(deps.dir, page(22)))).toEqual([21])
    expect(await widthsOf(out)).toEqual([10, 21, 30])
  })

  it('a kept page that will not read is dropped and drawn again, and never fails the deck for good', async () => {
    const { deps, calls } = rig()
    await deckPicture(deps, deckFile([10, 20, 30]), slides([1, 2, 3]), join(dir, 'a.pdf'))
    writeFileSync(join(deps.dir, page(2)), 'cut short')
    calls.length = 0
    const out = join(dir, 'b.pdf')
    expect(await deckPicture(deps, deckFile([10, 20, 30]), slides([1, 2, 3]), out)).toEqual({ way: 'slides', drawn: 1 })
    expect(calls.filter((c) => !c.startsWith('log'))).toEqual(['slide 2'])
    expect(await widthsOf(out)).toEqual([10, 20, 30])
    expect(await widthsOf(join(deps.dir, page(2)))).toEqual([20])
  })

  it('with no LibreOffice kept running every render is the toolchain’s whole export, and its pages are still kept', async () => {
    const { deps, calls } = rig(null)
    await deckPicture(deps, deckFile([10, 20, 30]), slides([1, 2, 3]), join(dir, 'a.pdf'))
    expect((await deckPicture(deps, deckFile([10, 21, 30]), slides([1, 22, 3]), join(dir, 'b.pdf'))).way).toBe('whole')
    expect(calls).toEqual(['whole', 'whole'])
    calls.length = 0
    expect((await deckPicture(deps, deckFile([30, 10]), slides([3, 1]), join(dir, 'c.pdf'))).way).toBe('kept')
    expect(calls).toEqual([])
  })

  it('an outline with no hashes (kept by an older script) is drawn whole and keeps no pages', async () => {
    const { deps, calls } = rig()
    const out = join(dir, 'a.pdf')
    expect((await deckPicture(deps, deckFile([10, 20]), [{}, {}], out)).way).toBe('whole')
    expect(calls).toEqual(['deck'])
    expect(readdirSync(deps.dir)).toEqual([])
    expect(await widthsOf(out)).toEqual([10, 20])
  })

  it('a job that was called off rejects and leaves nothing half written', async () => {
    const stop = new AbortController()
    const stopped = async (): Promise<never> => {
      stop.abort()
      throw new Error('stopped')
    }
    const { deps } = rig({ slide: stopped, deck: stopped })
    const out = join(dir, 'a.pdf')
    await expect(deckPicture(deps, deckFile([10, 20]), slides([1, 2]), out, stop.signal)).rejects.toThrow('stopped')
    expect(existsSync(out)).toBe(false)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('pages', () => {
  it('split and put together again are the same pages in the order asked', async () => {
    const src = join(dir, 'src.pdf')
    writeFileSync(src, await pdfOf([10, 20, 30]))
    const outs = [join(dir, 'p1.pdf'), null, join(dir, 'p3.pdf')]
    await splitPdf(src, outs)
    expect(existsSync(join(dir, 'p1.pdf')) && existsSync(join(dir, 'p3.pdf'))).toBe(true)
    await stitchPdf([join(dir, 'p3.pdf'), join(dir, 'p1.pdf'), join(dir, 'p3.pdf')], join(dir, 'out.pdf'))
    expect(await widthsOf(join(dir, 'out.pdf'))).toEqual([30, 10, 30])
    await expect(splitPdf(src, [join(dir, 'x.pdf')])).rejects.toThrow('the picture has 3 pages for 1 slides')
    // The same page split twice is the same bytes: a picture's name never stands for two files.
    await splitPdf(src, [join(dir, 'again.pdf'), null, null])
    expect(readFileSync(join(dir, 'again.pdf')).equals(readFileSync(join(dir, 'p1.pdf')))).toBe(true)
  })

  it('keeps the newest pictures of a folder and drops the rest', async () => {
    for (const n of [1, 2, 3, 4]) {
      const f = join(dir, `${key(n)}.pdf`)
      writeFileSync(f, 'x')
      utimesSync(f, new Date(2026, 0, n), new Date(2026, 0, n))
    }
    // What a job cut short left: swept once it is old, left alone while a job may still be writing it.
    writeFileSync(join(dir, 'fresh.tmp'), 'x')
    writeFileSync(join(dir, 'stale.part-3.pdf'), 'x')
    utimesSync(join(dir, 'stale.part-3.pdf'), new Date(2026, 0, 1), new Date(2026, 0, 1))
    prunePages(dir, 2)
    expect(readdirSync(dir).sort()).toEqual([`${key(3)}.pdf`, `${key(4)}.pdf`, 'fresh.tmp'])
    prunePages(join(dir, 'nowhere'), 2)
  })
})
