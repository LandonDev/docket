import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handled } from '@shared/work'
import type { ToolCtx, WorkModule } from '../modules'
import { NEEDS_APPROVE, setThreadsMayWrite } from '../files/policy'
import { setCloudDir } from '../office/files/library'
import { makeFromTemplate } from './api'
import { makeFromShelf } from './make'
import { SHARED_HELD } from './place'
import { moveTemplate, removeTemplate, renameTemplate, saveTemplate, SHELF_UNREAD } from './save'
import { listTemplates, NoTemplateError, OUT_OF_REACH, sharedDir } from './shelf'
import { templateTools } from './tools'
import { docx, HOST, makeRig, phone, pptx, thread, window, WS, type Rig } from './testkit'
import { makeZip } from './zip'

/*
 * The hold and the fence (docs/agents/work-templates.md "Who may write where"): a file made or saved by a thread,
 * or by another pillar, never lands in a folder others can open, which Files' door names (`sharedOf`), and the shelf
 * reads no file a link leads out of the job to.
 */

let rig: Rig
let cloud: string
const CLOUD_WS = 'w-cloud'
beforeEach(() => {
  rig = makeRig()
  cloud = join(rig.base, 'CloudStorage')
  mkdirSync(join(cloud, 'OneDrive-Dummy', 'Shared Templates'), { recursive: true })
  setCloudDir(() => cloud)
  // Files has started on a real host: a thread's change in his own places runs, in shared ones it would be held.
  setThreadsMayWrite(true)
  // A job kept inside OneDrive.
  const kept = join(cloud, 'OneDrive-Dummy', 'Work', 'Cloud Job')
  mkdirSync(kept, { recursive: true })
  rig.db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)').run(CLOUD_WS, 'Cloud Job', kept, 'work', 'ref', 4)
  rig.roots.push(kept)
})
afterEach(() => {
  setThreadsMayWrite(false)
  rig.close()
})

const file = (path: string) => ({ at: 'file' as const, host: HOST, path })
const cloudJob = () => join(cloud, 'OneDrive-Dummy', 'Work', 'Cloud Job')
const filesIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])
/** The job's Templates folder as a link into a OneDrive folder: the root is his own, the shelf is not. */
const linkTemplates = (): string => {
  const into = join(cloud, 'OneDrive-Dummy', 'Shared Templates')
  symlinkSync(into, join(rig.folder, 'Templates'))
  return into
}
const toolCtx = (workspaceId: string): ToolCtx => ({ ...rig.ctx, sessionId: 't1', scope: { workspaceId }, signal: new AbortController().signal }) as unknown as ToolCtx
const tool = (name: string) => templateTools.find((t) => t.name === name)!

describe('a make in a folder others can open', () => {
  it("is refused for a thread and for another pillar's call, and nothing is written", async () => {
    await expect(makeFromShelf(rig.ctx, thread(), { workspaceId: CLOUD_WS, template: 'Game report', today: '2026-11-23' }, { pillars: () => [] })).rejects.toThrow(SHARED_HELD)
    await expect(makeFromTemplate(rig.ctx, { workspaceId: CLOUD_WS, template: 'Game report', today: '2026-11-23' })).rejects.toThrow(SHARED_HELD)
    const said = await tool('template_make').run({ template: 'Game report' }, toolCtx(CLOUD_WS))
    expect(said).toMatchObject({ isError: true })
    expect(filesIn(cloudJob())).toEqual([])
  })

  it('is his own press from a window, and is made', async () => {
    const made = await makeFromShelf(rig.ctx, window, { workspaceId: CLOUD_WS, template: 'Game report', today: '2026-11-23' }, { pillars: () => [] })
    expect(made.source).toEqual(file(join(cloudJob(), 'Game report.docx')))
  })

  it('is refused for a key without approve, as Files refuses it', async () => {
    await expect(makeFromShelf(rig.ctx, phone, { workspaceId: CLOUD_WS, template: 'Game report', today: '2026-11-23' }, { pillars: () => [] })).rejects.toThrow(NEEDS_APPROVE)
    expect(filesIn(cloudJob())).toEqual([])
  })

  it("is the same for a thread's make in his own folder: there it runs", async () => {
    const made = await makeFromShelf(rig.ctx, thread(), { workspaceId: WS, template: 'Game report', today: '2026-11-23' }, { pillars: () => [] })
    expect(made.source).toEqual(file(join(rig.folder, 'Game report.docx')))
  })
})

describe('a save into a Templates folder others can open', () => {
  it('is refused for a thread, in a shared job and through a linked Templates folder alike', async () => {
    const one = rig.put(join(cloudJob(), 'Notes.docx'), docx('{{Client}}'))
    await expect(saveTemplate(rig.ctx, thread(), { workspaceId: CLOUD_WS, source: file(one) }, { pillars: () => [] })).rejects.toThrow(SHARED_HELD)
    expect(filesIn(join(cloudJob(), 'Templates'))).toEqual([])
    const into = linkTemplates()
    const two = rig.put(join(rig.folder, 'Letter.docx'), docx('{{To}}'))
    await expect(saveTemplate(rig.ctx, thread(), { workspaceId: WS, source: file(two) }, { pillars: () => [] })).rejects.toThrow(SHARED_HELD)
    rig.items.push({ id: 'item_9', sessionId: 't1', kind: 'document', source: file(two), title: 'Letter.docx' } as never)
    expect(await tool('template_save').run({ item: 'item_9' }, toolCtx(WS))).toMatchObject({ isError: true })
    expect(filesIn(into)).toEqual([])
  })

  it('is his own press from a window, and is saved', async () => {
    const into = linkTemplates()
    const two = rig.put(join(rig.folder, 'Letter.docx'), docx('{{To}}'))
    expect(await saveTemplate(rig.ctx, window, { workspaceId: WS, source: file(two) }, { pillars: () => [] })).toMatchObject({ id: 'job:Letter.docx' })
    expect(filesIn(into)).toEqual(['Letter.docx'])
  })

  it('takes a delete there only with approve', async () => {
    const into = linkTemplates()
    rig.put(join(into, 'Letter.docx'), docx('{{To}}'))
    rig.roots.push(into)
    const asked = await removeTemplate(rig.ctx, window, WS, 'job:Letter.docx', null, { pillars: () => [] })
    await expect(removeTemplate(rig.ctx, phone, WS, 'job:Letter.docx', asked.version!, { pillars: () => [] })).rejects.toThrow(NEEDS_APPROVE)
    expect(filesIn(into)).toEqual(['Letter.docx'])
  })
})

describe('the shelf reads only inside the job', () => {
  it('lists no file a link leads out of the job to, and makes none from it', async () => {
    const secret = rig.put(join(rig.outside, 'Secret.docx'), docx('{{Account number}}'))
    mkdirSync(join(rig.folder, 'Templates'), { recursive: true })
    symlinkSync(secret, join(rig.folder, 'Templates', 'Secret.docx'))
    expect(listTemplates(rig.ctx, WS).templates.map((t) => t.name)).not.toContain('Secret')
    await expect(makeFromShelf(rig.ctx, thread(), { workspaceId: WS, template: 'Secret', today: '2026-11-23' }, { pillars: () => [] })).rejects.toThrow(NoTemplateError)
    expect(filesIn(rig.folder)).toEqual(['Templates'])
  })

  it('lists nothing through a Templates folder that is itself a link out of the job', () => {
    rig.put(join(rig.outside, 'Secret.docx'), docx('{{Account number}}'))
    symlinkSync(rig.outside, join(rig.folder, 'Templates'))
    expect(listTemplates(rig.ctx, WS).templates.filter((t) => t.where === 'job')).toEqual([])
  })

  it('still lists a link to a file elsewhere in the job, and one into a OneDrive folder', () => {
    const inJob = rig.put(join(rig.folder, 'Forms', 'Waiver.docx'), docx('{{Player}}'))
    mkdirSync(join(rig.folder, 'Templates'), { recursive: true })
    symlinkSync(inJob, join(rig.folder, 'Templates', 'Waiver.docx'))
    expect(listTemplates(rig.ctx, WS).templates.find((t) => t.name === 'Waiver')).toMatchObject({ where: 'job', fields: ['Player'] })
  })

  it("lists no file a link leads out of the host's own folder for all jobs", () => {
    const secret = rig.put(join(rig.outside, 'Secret.docx'), docx('{{Account number}}'))
    mkdirSync(sharedDir(rig.ctx), { recursive: true })
    symlinkSync(secret, join(sharedDir(rig.ctx), 'Secret.docx'))
    expect(listTemplates(rig.ctx, WS).templates.map((t) => t.name)).not.toContain('Secret')
  })
})

describe('a deck whose file others can open', () => {
  it('is said shared on every job the fill hands the runner, so it never leaves this host', async () => {
    rig.put(join(cloudJob(), 'Templates', 'Pitch.pptx'), pptx('Pitch for {{Client}}'))
    await makeFromShelf(rig.ctx, window, { workspaceId: CLOUD_WS, template: 'Pitch', fields: { Client: 'Acme' }, today: '2026-11-23' }, { pillars: () => [] })
    expect(rig.jobs.map((j) => [j.to, j.shared])).toEqual([['deckinfo', true]])
  })

  it('leaves the runner to judge a deck of his own', async () => {
    rig.put(join(rig.folder, 'Templates', 'Pitch.pptx'), pptx('Pitch for {{Client}}'))
    await makeFromShelf(rig.ctx, window, { workspaceId: WS, template: 'Pitch', fields: { Client: 'Acme' }, today: '2026-11-23' }, { pillars: () => [] })
    expect(rig.jobs.map((j) => [j.to, j.shared])).toEqual([['deckinfo', undefined]])
  })
})

describe('a key, against the paths the shelf itself supplies', () => {
  /** The job's Templates folder as a link to a private folder outside the key's roots and outside the job. */
  const linkOut = (): string => {
    const into = join(rig.outside, 'Private')
    mkdirSync(into, { recursive: true })
    symlinkSync(into, join(rig.folder, 'Templates'))
    return into
  }

  it('saves nothing through a Templates folder that leads out of its reach', async () => {
    const into = linkOut()
    const source = rig.put(join(rig.folder, 'Letter.docx'), docx('{{To}}'))
    await expect(saveTemplate(rig.ctx, phone, { workspaceId: WS, source: file(source) }, { pillars: () => [] })).rejects.toThrow(OUT_OF_REACH)
    expect(filesIn(into)).toEqual([])
  })

  it('and his window saves nothing there either: the shelf would not show it', async () => {
    const into = linkOut()
    const source = rig.put(join(rig.folder, 'Letter.docx'), docx('{{To}}'))
    await expect(saveTemplate(rig.ctx, window, { workspaceId: WS, source: file(source) }, { pillars: () => [] })).rejects.toThrow(SHELF_UNREAD)
    expect(filesIn(into)).toEqual([])
  })

  it('moves nothing into such a Templates folder', async () => {
    const into = linkOut()
    rig.put(join(sharedDir(rig.ctx), 'Letter.docx'), docx('{{To}}'))
    await expect(moveTemplate(rig.ctx, phone, WS, 'all:Letter.docx', false)).rejects.toThrow(OUT_OF_REACH)
    expect(filesIn(into)).toEqual([])
    expect(filesIn(sharedDir(rig.ctx))).toEqual(['Letter.docx'])
  })

  it('learns nothing of a shelf outside its fence, not even that a name is missing', async () => {
    rig.roots = []
    await expect(makeFromShelf(rig.ctx, phone, { workspaceId: WS, template: 'No such', today: '2026-11-23' }, { pillars: () => [] })).rejects.toThrow(OUT_OF_REACH)
    await expect(renameTemplate(rig.ctx, phone, WS, 'No such', 'X')).rejects.toThrow(OUT_OF_REACH)
    await expect(moveTemplate(rig.ctx, phone, WS, 'No such', true)).rejects.toThrow(OUT_OF_REACH)
  })
})

describe('a key that makes from a document for all jobs', () => {
  it('gets it filled: the Word export is the host\'s own read of the entry the make admitted', async () => {
    rig.put(join(sharedDir(rig.ctx), 'Letter.tcdoc'), makeZip({ 'preview.md': 'Dear {{Client}}' }))
    const callers: string[] = []
    // The export's own fence, standing in: a key may not name a file in the host's own data.
    const formats: WorkModule = {
      id: 'formats',
      ensure() {},
      handle: async (_req, _ctx, by) => {
        callers.push(by.kind)
        if (by.kind === 'remote') throw new Error('That is outside what this key may reach.')
        return handled({ name: 'Letter.docx', data: Buffer.from(docx('Dear {{Client}}')).toString('base64'), warnings: [] })
      }
    }
    const made = await makeFromShelf(rig.ctx, phone, { workspaceId: WS, template: 'all:Letter.tcdoc', fields: { Client: 'Acme' }, today: '2026-11-23' }, { pillars: () => [formats] })
    expect(callers).toEqual(['local'])
    expect(made).toMatchObject({ unfilled: [] })
    expect(made.source).toEqual(file(join(rig.folder, 'Letter - Acme.docx')))
  })
})
