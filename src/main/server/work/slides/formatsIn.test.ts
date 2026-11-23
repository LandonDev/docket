import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { LIBREOFFICE_CONVERTERS } from '../formats'
import { convertersOf, JobRunner, NoConverterError, NotReadyError } from '../formats/jobs'
import { slides } from './index'
import type { DeckInfo } from './deck'
import { KEYNOTE_EXPORT } from '@shared/work/slideFormats'
import { convertedDeck, NOT_KEYNOTE } from './formatsIn'
import { writeNewDeck } from './newDeck'

const DATA = process.env.TEMP_CODE_WORK_TOOLS_DATA
const KEYNOTE = process.env.TEMP_CODE_SLIDES_KEYNOTE_FIXTURES
const PRESENTATION = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
const SLIDESHOW = 'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml'

it('registers the three missing imports on the slides module', () => {
  expect(slides.convert?.filter((pair) => pair.to === 'pptx').map(({ from, needs }) => [from, needs])).toEqual([
    ['pps', 'libreoffice'], ['ppsx', 'libreoffice'], ['key', 'libreoffice']
  ])
})

describe('a snapshot of an imported deck, on a stand-in converter', () => {
  const ZIP = Buffer.from('PK\u0003\u0004')
  let dir: string
  let input: string
  let folder: string
  let made: number
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-slide-snapshot-'))
    input = join(dir, 'Deck.key')
    folder = join(dir, 'converted')
    mkdirSync(folder)
    writeFileSync(input, Buffer.concat([ZIP, Buffer.from('a Keynote deck')]))
    made = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const failing = (err: Error) => ({ convert: async () => Promise.reject(err) })
  const writes = { convert: async (job: { output?: string }) => (made++, writeFileSync(job.output!, Buffer.concat([ZIP, Buffer.from('deck')])), { output: job.output!, ranOn: 'env_test', warnings: [] }) }

  it('a conversion stopped half way keeps no deck and no file of its own', async () => {
    const stop = new AbortController()
    const halfway = {
      convert: async (job: { output?: string }) => {
        writeFileSync(job.output!, Buffer.concat([ZIP, Buffer.from('half')]))
        stop.abort()
        return { output: job.output!, ranOn: 'env_test', warnings: [] }
      }
    }
    await expect(convertedDeck(halfway, input, folder, 'key', {}, stop.signal)).rejects.toThrow()
    expect(readdirSync(folder)).toEqual([])
  })

  it.each([
    ['no converter in reach', new NoConverterError('No host in reach converts key to pptx.')],
    ['a machine asleep', new NotReadyError('asleep', 'The Windows VM sleeps.')],
    ['a timeout', new Error('libreoffice failed (timed out after 300 s)')],
    ['a tool still installing', new Error('libreoffice is not installed here')]
  ])('keeps its own words for %s, so Retry stays', async (_what, err) => {
    await expect(convertedDeck(failing(err), input, folder, 'key', {})).rejects.toBe(err)
  })

  it('says to export from Keynote only for a Keynote the converter could not read', async () => {
    await expect(convertedDeck(failing(new Error('source file could not be loaded')), input, folder, 'key', {})).rejects.toThrow(KEYNOTE_EXPORT)
    // Any other format keeps the converter's words.
    writeFileSync(join(dir, 'Deck.odp'), 'odp')
    await expect(convertedDeck(failing(new Error('source file could not be loaded')), join(dir, 'Deck.odp'), folder, 'odp', {})).rejects.toThrow('source file could not be loaded')
  })

  it('refuses a .key that is no Keynote deck, sending nothing to a converter', async () => {
    writeFileSync(input, '-----BEGIN RSA PRIVATE KEY-----\n')
    await expect(convertedDeck(writes, input, folder, 'key', {})).rejects.toThrow(NOT_KEYNOTE)
    expect(made).toBe(0)
  })

  it('a Keynote package folder asks for Keynote’s own export without converting', async () => {
    const pack = join(dir, 'Package.key')
    mkdirSync(join(pack, 'Index'), { recursive: true })
    await expect(convertedDeck(writes, pack, folder, 'key', {})).rejects.toThrow(KEYNOTE_EXPORT)
    mkdirSync(join(dir, 'Folder.key'))
    await expect(convertedDeck(writes, join(dir, 'Folder.key'), folder, 'key', {})).rejects.toThrow(NOT_KEYNOTE)
    expect(made).toBe(0)
  })

  it('reads the snapshot while the original is as it was, and makes it again once it changed', async () => {
    const path = await convertedDeck(writes, input, folder, 'key', {})
    expect([made, JSON.parse(readFileSync(join(folder, 'source.json'), 'utf8')).size]).toEqual([1, statSync(input).size])
    await convertedDeck(writes, input, folder, 'key', {})
    expect(made).toBe(1)
    writeFileSync(input, Buffer.concat([ZIP, Buffer.from('a Keynote deck, saved again')]))
    expect(await convertedDeck(writes, input, folder, 'key', {})).toBe(path)
    expect(made).toBe(2)
  })
})

describe.skipIf(!DATA)('slide imports through LibreOffice and python-pptx', () => {
  let dir: string
  let runner: JobRunner
  let dummy: string
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-slide-import-'))
    const installed = join(DATA!, 'work-tools')
    const tools = join(dir, 'work-tools')
    mkdirSync(tools)
    // Reuse the installed programs. Jobs and LibreOffice profiles belong to the test.
    for (const entry of readdirSync(installed)) {
      if (entry !== 'jobs' && entry !== 'run') symlinkSync(join(installed, entry), join(tools, entry))
    }
    runner = new JobRunner({ host: 'env_test', dataDir: dir, converters: convertersOf([slides, { id: 'formats', ensure() {}, convert: LIBREOFFICE_CONVERTERS }]), log: () => {} })
    dummy = join(dir, 'demo.pptx')
    writeFileSync(dummy, await writeNewDeck({ title: 'Dummy deck', slides: [{ layout: 'title', title: 'Dry run' }] }))
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  const convert = (job: Parameters<JobRunner['convert']>[0]) => runner.convert({ ...job, here: true })
  const importTo = (input: string, ext: 'ppt' | 'odp' | 'pps' | 'ppsx' | 'key'): Promise<string> => {
    const folder = mkdtempSync(join(dir, 'copy-'))
    return convertedDeck({ convert }, input, folder, ext, { shared: true })
  }
  const inspect = async (input: string): Promise<string[]> => {
    const output = join(dir, 'deck.json')
    await convert({ from: 'pptx', to: 'deckinfo', input, output })
    return (JSON.parse(readFileSync(output, 'utf8')) as DeckInfo).slides.map((slide) => slide.title)
  }

  it.each(['ppt', 'odp', 'pps'] as const)('makes a dummy %s from PPTX and reads its converted deck and PDF', async (ext) => {
    const input = join(dir, `demo.${ext}`)
    const to = ext === 'pps' ? 'ppt' : ext
    await convert({ from: 'pptx', to, input: dummy, output: input })
    const before = readFileSync(input)
    const copy = await importTo(input, ext)
    expect(await inspect(copy)).toEqual(['Dry run'])
    const picture = join(dir, `${ext}.pdf`)
    await convert({ from: 'pptx', to: 'pdf', input: copy, output: picture })
    expect(readFileSync(picture).subarray(0, 4).toString()).toBe('%PDF')
    expect(readFileSync(input)).toEqual(before)
  }, 30_000)

  it('converts a PPSX content type to an editable PPTX package and leaves the PPSX untouched', async () => {
    const input = join(dir, 'demo.ppsx')
    const zip = await JSZip.loadAsync(readFileSync(dummy))
    const types = await zip.file('[Content_Types].xml')!.async('string')
    expect(types).toContain(PRESENTATION)
    zip.file('[Content_Types].xml', types.replace(PRESENTATION, SLIDESHOW))
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    writeFileSync(input, bytes)
    await expect(inspect(input)).rejects.toThrow()
    const copy = await importTo(input, 'ppsx')
    const result = await JSZip.loadAsync(readFileSync(copy))
    const converted = await result.file('[Content_Types].xml')!.async('string')
    expect(converted).toContain(PRESENTATION)
    expect(converted).not.toContain(SLIDESHOW)
    expect(await inspect(copy)).toEqual(['Dry run'])
    expect(readFileSync(input)).toEqual(bytes)
  }, 30_000)

  it('rejects an unreadable Keynote instead of keeping a false copy', async () => {
    const input = join(dir, 'invalid.key')
    const folder = join(dir, 'invalid')
    mkdirSync(folder)
    // A zip LibreOffice's Keynote filter cannot read: a real import failure.
    writeFileSync(input, Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.from('not a Keynote package')]))
    await expect(convertedDeck({ convert }, input, folder, 'key', {})).rejects.toThrow(KEYNOTE_EXPORT)
    expect(existsSync(join(folder, 'deck.pptx'))).toBe(false)
  }, 30_000)

  it.skipIf(!KEYNOTE).each([[5, 2], [6, 1]])('reads the Keynote %i research fixture as %i slides', async (generation, count) => {
    const copy = await importTo(join(KEYNOTE!, `keynote${generation}-file.key`), 'key')
    expect(await inspect(copy)).toHaveLength(count)
  }, 30_000)
})
