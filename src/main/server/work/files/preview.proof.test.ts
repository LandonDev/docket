import { copyFileSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { libreOffice } from '../formats'
import { JobRunner, type Converter } from '../formats/jobs'
import { runTool, Toolchain } from '../formats/tools'
import { PDF_CONVERTERS } from '../pdf/extract'
import { closeFilesState } from './handle'
import { previewOne, previewSeams, PREVIEW_CONVERTERS } from './preview'
import { pngSize } from './sketch'
import { at, makeRig, window, WS } from './testkit'

/**
 * Previews drawn by the real tools: LibreOffice, the pdf pillar's pypdfium2 and ffmpeg, through the real job
 * runner. Runs only where `TC_PREVIEW_TOOLS` names an installed toolchain's folder (the box's is
 * `/srv/agents/temp-code-data/work-tools`); the tools are linked into a scratch data folder, so LibreOffice's
 * profile and every job's scratch stay out of the app's own. Run it through `.temp-code/bin/heavy`.
 * `TC_PREVIEW_OUT` keeps the PNGs for a look.
 */

const TOOLS = process.env.TC_PREVIEW_TOOLS
const OUT = process.env.TC_PREVIEW_OUT
const want = ['libreoffice', 'python', 'venv', 'pdf-tools', 'ffmpeg']

describe.skipIf(!TOOLS)('previews by the real tools', () => {
  let rig: ReturnType<typeof makeRig>
  beforeAll(async () => {
    rig = makeRig()
    const root = join(rig.dataDir, 'work-tools')
    mkdirSync(root, { recursive: true })
    const state = JSON.parse(readFileSync(join(TOOLS!, 'state.json'), 'utf8')) as { tools: Record<string, { dir?: string }> }
    state.tools = Object.fromEntries(Object.entries(state.tools).filter(([name]) => want.includes(name)))
    const top = new Set(Object.values(state.tools).map((t) => t.dir!.split('/')[0]!))
    for (const dir of top) symlinkSync(join(TOOLS!, dir), join(root, dir))
    writeFileSync(join(root, 'state.json'), JSON.stringify(state))
    const converters = new Map<string, Converter>()
    for (const c of [libreOffice('docx', 'pdf'), libreOffice('csv', 'pdf'), libreOffice('pptx', 'pdf'), ...PDF_CONVERTERS, ...PREVIEW_CONVERTERS]) converters.set(`${c.from}→${c.to}`, c)
    const runner = new JobRunner({ host: rig.ctx.host, dataDir: rig.dataDir, converters, tools: new Toolchain(rig.dataDir), caps: { jobs: 2, threads: 4 }, log: () => {} })
    ;(rig.ctx as unknown as { convert: JobRunner['convert'] }).convert = (job) => runner.convert(job)
    previewSeams.scale = undefined
    previewSeams.platform = 'linux'
    // Dummy files: a three-page PDF, a sheet as CSV, a blank Word file, a two-second video and a WebP.
    const pdf = await PDFDocument.create()
    for (let i = 0; i < 3; i++) pdf.addPage([612, 792]).drawText(`Dummy Esports bracket, page ${i + 1}`, { x: 72, y: 700, size: 24 })
    writeFileSync(join(rig.folder, 'Bracket.pdf'), await pdf.save())
    writeFileSync(join(rig.folder, 'Roster.csv'), 'Player,Score\nDummy One,42\nDummy Two,37\n')
    copyFileSync(join(__dirname, '../../../../../resources/work-files/blank/blank.docx'), join(rig.folder, 'Blank.docx'))
    const ffmpeg = new Toolchain(rig.dataDir).bin('ffmpeg')!
    await runTool(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10', '-pix_fmt', 'yuv420p', join(rig.folder, 'Clip.mp4')], { timeoutMs: 60_000 })
    await runTool(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x480', '-frames:v', '1', join(rig.folder, 'Banner.webp')], { timeoutMs: 60_000 })
  }, 120_000)
  afterAll(() => {
    closeFilesState(rig.db)
    rig.close()
  })

  const shot = async (name: string, ask: Parameters<typeof previewOne>[4]) => {
    const got = await previewOne(rig.ctx, window, WS, at(join(rig.folder, name)), ask, 'work.files.preview')
    if ('png' in got && OUT) {
      mkdirSync(OUT, { recursive: true })
      writeFileSync(join(OUT, `${name}.png`), got.png)
    }
    return got
  }

  it("draws a PDF's second page at the width asked, and counts its pages", async () => {
    const got = await shot('Bracket.pdf', { page: 2, width: 600 })
    expect(got).toMatchObject({ via: 'pdf', pages: 3, width: 600 })
    // Letter at 600 wide is 776.5 tall: pdfium rounds up.
    expect(pngSize((got as { png: Buffer }).png)).toEqual({ width: 600, height: 777 })
  }, 120_000)

  it('draws a CSV and a Word file through LibreOffice on this host', async () => {
    expect(await shot('Roster.csv', { page: 1, width: 800 })).toMatchObject({ via: 'libreoffice', pages: 1, width: 800 })
    expect(await shot('Blank.docx', { thumb: 288 })).toMatchObject({ via: 'libreoffice', width: 288 })
  }, 300_000)

  it("takes a video's frame and scales a WebP through ffmpeg", async () => {
    const clip = await shot('Clip.mp4', { thumb: 192 })
    expect(clip).toMatchObject({ via: 'video', width: 192, height: 144 })
    expect(await shot('Banner.webp', { thumb: 416 })).toMatchObject({ via: 'picture', width: 416, height: 312 })
  }, 120_000)
})
