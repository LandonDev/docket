import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolCtx } from '../modules'
import { NEEDS_APPROVE, setThreadsMayWrite } from '../files/policy'
import { setCloudDir } from '../office/files/library'
import { makeFromTemplate } from './api'
import { makeFromShelf } from './make'
import { SHARED_HELD } from './place'
import { removeTemplate, saveTemplate } from './save'
import { listTemplates, NoTemplateError, sharedDir } from './shelf'
import { templateTools } from './tools'
import { docx, HOST, makeRig, phone, thread, window, WS, type Rig } from './testkit'

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
