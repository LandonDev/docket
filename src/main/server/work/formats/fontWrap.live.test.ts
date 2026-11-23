import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { findChromium } from '../browser/box/chromium'
import { Toolchain } from './tools'

/*
 * The live proof of DOC2's fonts, kept as a test: a document names its fonts
 * as Office does and draws them with free twins of the same metrics. Text set
 * in the twin woff2 that work-kit ships breaks, in Chromium, into as many lines
 * as LibreOffice breaks the same text in a Word file naming the Office font, at
 * the same column (Letter, 1 in margins: 6.5 in, 624 px) and size (11 pt,
 * 1.25 line spacing). 40 paragraphs, eight per family, from the editors lab
 * (font-paragraphs.json's generator; Courier New added).
 *
 * Skipped unless TEMP_CODE_WORK_TOOLS_DATA names a userData the installer
 * filled (the box's): LibreOffice and PyMuPDF come from its toolchain, the
 * box has no `pdfinfo`. Chromium is the box's (findChromium).
 *
 * Measured on the box, 2026-11-23 (LibreOffice 26.8.3, Chromium 1248): 40 of
 * 40 line counts equal, asserted. Every word on the same line in 39 of 40,
 * printed, not asserted: in P18 (Arial) Chromium fits "formats" at the end of
 * line 3 where LibreOffice moves it to line 4; line 4 absorbs it, the count holds.
 */

interface Paragraph {
  id: string
  font: string
  text: string
}
const PARAGRAPHS = JSON.parse(readFileSync(new URL('./fontWrap.fixture.json', import.meta.url), 'utf8')) as Paragraph[]

/** Office's name → the twin's family and the woff2 work-kit ships for its regular face. */
const TWINS: Record<string, { family: string; file: string }> = {
  Calibri: { family: 'Carlito', file: 'Carlito-Regular.woff2' },
  Cambria: { family: 'Caladea', file: 'Caladea-Regular.woff2' },
  Arial: { family: 'Liberation Sans', file: 'LiberationSans-Regular.woff2' },
  'Times New Roman': { family: 'Liberation Serif', file: 'LiberationSerif-Regular.woff2' },
  'Courier New': { family: 'Liberation Mono', file: 'LiberationMono-Regular.woff2' }
}

/** The shipped woff2: work-kit's own folder, else TEMP_CODE_FONT_FILES while the pin lags. */
function fontFiles(): string | null {
  for (const dir of createRequire(import.meta.url).resolve.paths('work-kit') ?? []) {
    const files = join(dir, 'work-kit', 'src', 'fonts', 'files')
    if (existsSync(join(dir, 'work-kit', 'package.json'))) {
      if (existsSync(files)) return files
      break
    }
  }
  const env = process.env.TEMP_CODE_FONT_FILES
  return env && existsSync(env) ? env : null
}

const REAL = process.env.TEMP_CODE_WORK_TOOLS_DATA
const tools = REAL ? new Toolchain(REAL) : null
const soffice = tools?.bin('libreoffice') ?? null
const python = tools?.bin('pymupdf4llm') ?? null
const chrome = REAL ? findChromium() : null
const fonts = REAL ? fontFiles() : null
const missing = !REAL
  ? null
  : !soffice
    ? 'LibreOffice is not in the toolchain'
    : !python
      ? 'PyMuPDF is not in the toolchain'
      : !chrome
        ? 'no Chromium on this host'
        : !fonts
          ? 'no shipped woff2: work-kit has no src/fonts/files and TEMP_CODE_FONT_FILES names no folder'
          : null
if (missing) console.warn(`[doc2 proof] skipped: ${missing}`)

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** One spelling of a line for comparing: NFKC (ligatures out), single spaces. */
const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim()

/** The Word file: Letter, 1 in margins, each paragraph one run in its Office font at 11 pt, 1.25 lines, Word 2013+ layout. */
function docxParts(paras: Paragraph[]): Record<string, string> {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  const body = paras
    .map(
      (p) =>
        `<w:p><w:pPr><w:widowControl/><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr>` +
        `<w:r><w:rPr><w:rFonts w:ascii="${p.font}" w:hAnsi="${p.font}" w:cs="${p.font}" w:eastAsia="${p.font}"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>` +
        `<w:t xml:space="preserve">${xml(p.text)}</w:t></w:r></w:p>`
    )
    .join('')
  return {
    '[Content_Types].xml':
      `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>',
    '_rels/.rels':
      `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels':
      `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>',
    'word/settings.xml': `${head}<w:settings ${W}><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`,
    'word/document.xml':
      `${head}<w:document ${W}><w:body>${body}` +
      '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>'
  }
}

const ZIP = 'import sys, json, zipfile\nparts = json.load(open(sys.argv[1]))\nwith zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_DEFLATED) as z:\n    for name, data in parts.items(): z.writestr(name, data)'

/** Every text line of the PDF in reading order, a line being the spans on one baseline, with the font of its first span. */
const LINES = `import sys, json, pymupdf
out = []
for page in pymupdf.open(sys.argv[1]):
    rows = []
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines', []):
            text = ''.join(s['text'] for s in line['spans'])
            if text.strip(): rows.append([line['bbox'][3], line['bbox'][0], text, line['spans'][0]['font']])
    rows.sort(key=lambda r: (round(r[0], 1), r[1]))
    merged = []
    for y, x, text, font in rows:
        if merged and abs(merged[-1][0] - y) < 2: merged[-1][1] += ' ' + text
        else: merged.append([y, text, font])
    out += [[text, font] for y, text, font in merged]
print(json.dumps(out))`

/** LibreOffice's lines per paragraph: a paragraph starts at the line that opens with its id. */
function officeLines(pdf: string): Map<string, { font: string; lines: string[] }> {
  const run = spawnSync(python!, ['-c', LINES, pdf], { encoding: 'utf8', maxBuffer: 16 << 20 })
  if (run.status !== 0) throw new Error(run.stderr)
  const out = new Map<string, { font: string; lines: string[] }>()
  let at: { font: string; lines: string[] } | null = null
  for (const [text, font] of JSON.parse(run.stdout) as [string, string][]) {
    const id = /^P\d{2}\b/.exec(norm(text))?.[0]
    if (id) out.set(id, (at = { font, lines: [] }))
    at?.lines.push(norm(text))
  }
  return out
}

/** The page Chromium lays out: one @font-face per twin from the shipped woff2, each paragraph in its twin. */
function page(paras: Paragraph[], dir: string): string {
  const faces = Object.values(TWINS)
    .map((t) => `@font-face{font-family:"${t.family}";src:url(data:font/woff2;base64,${readFileSync(join(dir, t.file)).toString('base64')}) format("woff2")}`)
    .join('\n')
  const body = paras.map((p) => `<p id="${p.id}" style='font-family:"${TWINS[p.font]!.family}"'>${xml(p.text)}</p>`).join('\n')
  return `<!doctype html><meta charset="utf-8"><style>${faces}
body{margin:0}#column{width:624px}p{font-size:11pt;line-height:1.25;margin:0 0 8px;font-kerning:normal}</style><div id="column">${body}</div>`
}

/** In the page: load every face, then each paragraph's lines from its words' line boxes (the lab's method). */
const MEASURE = `(async () => {
  await Promise.all([...document.fonts].map((f) => f.load().catch(() => {})))
  await document.fonts.ready
  const faces = [...document.fonts].map((f) => ({ family: f.family.replace(/"/g, ''), status: f.status }))
  const range = document.createRange()
  const paras = [...document.querySelectorAll('p')].map((p) => {
    const text = p.firstChild, lines = []
    for (const word of text.data.matchAll(/\\S+/g)) {
      range.setStart(text, word.index)
      range.setEnd(text, word.index + word[0].length)
      const top = range.getClientRects()[0].top
      if (!lines.length || Math.abs(lines.at(-1).top - top) > 0.5) lines.push({ top, words: [] })
      lines.at(-1).words.push(word[0])
    }
    const family = getComputedStyle(p).fontFamily
    return { id: p.id, checked: document.fonts.check('11pt ' + family), lines: lines.map((l) => l.words.join(' ')) }
  })
  return { faces, paras }
})()`

interface Measured {
  faces: { family: string; status: string }[]
  paras: { id: string; checked: boolean; lines: string[]; drawn?: { familyName: string; isCustomFont: boolean }[] }[]
}

/** Chromium headless on a profile of its own, driven over DevTools; handed to `started` at once, so the caller ends it whatever happens. */
async function chromium(html: string, dir: string, started: (proc: ChildProcess) => void): Promise<Measured> {
  const profile = join(dir, 'chrome')
  mkdirSync(profile)
  const file = join(dir, 'page.html')
  writeFileSync(file, html)
  const url = pathToFileURL(file).href
  const args = ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0']
  const proc = spawn(chrome!, [...args, '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-background-networking', url], { stdio: 'ignore' })
  started(proc)
  const portFile = join(profile, 'DevToolsActivePort')
  for (let i = 0; !existsSync(portFile) || !readFileSync(portFile, 'utf8').includes('\n'); i++) {
    if (i > 300 || proc.exitCode !== null) throw new Error('Chromium did not open DevTools')
    await new Promise((r) => setTimeout(r, 100))
  }
  const port = readFileSync(portFile, 'utf8').split('\n')[0]
  type Target = { type: string; url: string; webSocketDebuggerUrl: string }
  let target: Target | undefined
  for (let i = 0; !target; i++) {
    if (i > 100) throw new Error('Chromium never opened the page')
    target = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[]).find((t) => t.type === 'page' && t.url === url)
    if (!target) await new Promise((r) => setTimeout(r, 100))
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let next = 0
  const waiting = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>()
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string } }
    if (m.id !== undefined) waiting.get(m.id)?.(m)
  }
  const send = <T>(method: string, params: object = {}): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = ++next
      waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result as T)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  try {
    // the page is a file of our own; the document may still be loading when DevTools answers
    for (let i = 0; (await send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })).result.value !== 'complete'; i++) {
      if (i > 100) throw new Error('the page never finished loading')
      await new Promise((r) => setTimeout(r, 100))
    }
    const answer = await send<{ result: { value: Measured }; exceptionDetails?: { text: string } }>('Runtime.evaluate', { expression: MEASURE, awaitPromise: true, returnByValue: true })
    if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.text)
    const measured = answer.result.value
    // which font Chromium really drew each paragraph in, as DevTools tells it
    await send('DOM.enable')
    await send('CSS.enable')
    const root = (await send<{ root: { nodeId: number } }>('DOM.getDocument')).root.nodeId
    for (const p of measured.paras) {
      const { nodeId } = await send<{ nodeId: number }>('DOM.querySelector', { nodeId: root, selector: `#${p.id}` })
      p.drawn = (await send<{ fonts: { familyName: string; isCustomFont: boolean }[] }>('CSS.getPlatformFontsForNode', { nodeId })).fonts
    }
    return measured
  } finally {
    ws.close()
  }
}

describe.skipIf(!REAL || missing)('font twins wrap as LibreOffice wraps the Office fonts (TEMP_CODE_WORK_TOOLS_DATA)', () => {
  let dir = ''
  let browser: ChildProcess | null = null
  afterAll(() => {
    browser?.kill('SIGKILL')
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('40 paragraphs in five families take as many lines in Chromium as in LibreOffice', async () => {
    expect(PARAGRAPHS).toHaveLength(40)
    dir = mkdtempSync(join(tmpdir(), 'tc-font-wrap-'))

    // LibreOffice: the Word file to PDF, with a profile and a home of its own
    const parts = join(dir, 'parts.json')
    const docx = join(dir, 'fonts.docx')
    writeFileSync(parts, JSON.stringify(docxParts(PARAGRAPHS)))
    const zip = spawnSync(python!, ['-c', ZIP, parts, docx], { encoding: 'utf8' })
    if (zip.status !== 0) throw new Error(zip.stderr)
    const home = join(dir, 'home')
    mkdirSync(home)
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), TMPDIR: dir }
    const convert = spawnSync(
      soffice!,
      [`-env:UserInstallation=${pathToFileURL(join(dir, 'lo')).href}`, '--headless', '--norestore', '--nologo', '--nodefault', '--convert-to', 'pdf', '--outdir', join(dir, 'out'), docx],
      { encoding: 'utf8', env, timeout: 150_000, killSignal: 'SIGKILL' }
    )
    const pdf = join(dir, 'out', 'fonts.pdf')
    if (!existsSync(pdf)) throw new Error(`LibreOffice made no PDF: ${convert.error ?? ''} ${convert.stderr}`)
    const office = officeLines(pdf)

    // Chromium: the same paragraphs in the shipped twins
    const { faces, paras } = await chromium(page(PARAGRAPHS, fonts!), dir, (proc) => (browser = proc))
    browser!.kill('SIGTERM')

    // every face loaded from the shipped file, and every paragraph was drawn in its twin alone
    expect(faces.map((f) => `${f.family} ${f.status}`).sort()).toEqual(Object.values(TWINS).map((t) => `${t.family} loaded`).sort())
    for (const p of paras) {
      const want = TWINS[PARAGRAPHS.find((x) => x.id === p.id)!.font]!.family
      expect(p.checked, p.id).toBe(true)
      expect(p.drawn, p.id).toEqual([expect.objectContaining({ familyName: want, isCustomFont: true })])
    }

    const rows = PARAGRAPHS.map((p) => {
      const lo = office.get(p.id)
      const chromium = paras.find((x) => x.id === p.id)!.lines.map(norm)
      // LibreOffice drew it in the twin too (the PDF names the font e.g. "BAAAAA+Caladea-Regular")
      expect(lo?.font.replace(/^[A-Z]{6}\+/, '').replace(/-Regular$/, ''), p.id).toBe(TWINS[p.font]!.family.replace(/ /g, ''))
      return { ...p, loLines: lo!.lines, chromiumLines: chromium, lo: lo!.lines.length, chromium: chromium.length, sameWords: lo!.lines.join('\n') === chromium.join('\n') }
    })
    const families = [...new Set(PARAGRAPHS.map((p) => p.font))]
    const line = families.map((f) => {
      const of = rows.filter((r) => r.font === f)
      return `${f}/${TWINS[f]!.family} ${of.filter((r) => r.lo === r.chromium).length} of ${of.length}`
    })
    const same = rows.filter((r) => r.lo === r.chromium).length
    const words = rows.filter((r) => r.sameWords).length
    console.log(`[doc2 proof] ${line.join(', ')}; total ${same} of ${rows.length}; every word on the same line: ${words} of ${rows.length}`)
    for (const r of rows.filter((r) => !r.sameWords)) {
      const at = r.loLines.findIndex((l, i) => l !== r.chromiumLines[i])
      const end = (l: string | undefined) => (l ?? '').split(' ').slice(-3).join(' ')
      console.log(`[doc2 proof] ${r.id} ${r.font}: LibreOffice ${r.lo} lines, Chromium ${r.chromium}; line ${at + 1} ends "…${end(r.loLines[at])}" in LibreOffice, "…${end(r.chromiumLines[at])}" in Chromium`)
    }
    expect(rows.filter((r) => r.lo !== r.chromium).map((r) => `${r.id} LibreOffice ${r.lo}, Chromium ${r.chromium}`)).toEqual([])
  }, 240_000)
})
