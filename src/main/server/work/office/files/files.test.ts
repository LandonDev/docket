import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import { teamsCanvasOf, teamsKindOf, teamsWebOf, type TeamsEntry, type TeamsLibrary } from '@shared/contract-work-office'
import type { Caller, ToolCtx, WorkCtx, WorkTool } from '../../modules'
import { FakeOffice } from '../fake'
import { office as module, setCarrier } from '../index'
import { copyDirOf, setFilesOpener } from './handle'
import { isLocal, setCloudDir, splitLibraryName } from './library'
import { teamsTools } from './tools'
import { zipEntries } from './zip'

/**
 * Teams files against a dummy CloudStorage shaped like OneDrive's on a Mac: his own OneDrive, a
 * team's Documents with two channels, a site's other library, a file OneDrive keeps in the cloud
 * (a sparse file: its full size and no blocks, as macOS's dataless file has), and a link out.
 */

/** A zip of the given entries, `deflate` ones packed: an Office file as far as the reader cares. */
function zip(entries: Record<string, string>, deflate = true): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let at = 0
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text)
    const data = deflate ? deflateRawSync(raw) : raw
    const n = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(n.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(deflate ? 8 : 0, 10)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt32LE(raw.length, 24)
    dir.writeUInt16LE(n.length, 28)
    dir.writeUInt32LE(at, 42)
    locals.push(local, n, data)
    central.push(dir, n)
    at += 30 + n.length + data.length
  }
  const dirBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(dirBytes.length, 12)
  end.writeUInt32LE(at, 16)
  return Buffer.concat([...locals, dirBytes, end])
}
const core = (who: string) => `<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y"><dc:creator>Someone</dc:creator><cp:lastModifiedBy>${who}</cp:lastModifiedBy></cp:coreProperties>`

let base: string
let cloud: string
let team: string
let mac: WorkCtx
let office: FakeOffice
let opened: string[]
const window: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }
const call = (method: string, params: unknown, by: Caller = window, ctx: WorkCtx = mac) => module.handle!({ id: '1', method, params } as unknown as ClientRequest, ctx, by).then((a) => (a as { result: unknown }).result as never)
const file = (path: string, host = 'env_mac') => ({ source: { at: 'file', host, path } })

const ctxOn = (host: string, extra: Partial<WorkCtx> = {}): WorkCtx => {
  const db = new DatabaseSync(':memory:')
  module.ensure(db)
  return { db, host, dataDir: join(base, `data-${host}`), log: () => {}, reaches: () => false, ...extra } as unknown as WorkCtx
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'teams-files-'))
  cloud = join(base, 'CloudStorage')
  team = join(cloud, 'OneDrive-SharedLibraries-Purdue University', 'Purdue Esports - Documents')
  mkdirSync(join(team, 'General', 'Budgets'), { recursive: true })
  mkdirSync(join(team, 'Events'), { recursive: true })
  mkdirSync(join(cloud, 'OneDrive-SharedLibraries-Purdue University', 'RecWell - Site Policies'), { recursive: true })
  mkdirSync(join(cloud, 'OneDrive-Purdue University'), { recursive: true })
  mkdirSync(join(cloud, 'Dropbox'), { recursive: true })
  mkdirSync(join(base, 'outside'), { recursive: true })
  writeFileSync(join(team, 'General', 'Budget 2026.xlsx'), zip({ 'docProps/core.xml': core('Pat Lee'), 'xl/workbook.xml': '<workbook/>' }))
  writeFileSync(join(team, 'General', 'Plan.docx'), zip({ 'docProps/core.xml': core('Sam &amp; Co'), 'word/document.xml': '<w:document><w:p><w:r><w:t>Spring</w:t></w:r><w:r><w:t xml:space="preserve"> league</w:t></w:r></w:p><w:p><w:r><w:t>Rules &lt;draft&gt;</w:t></w:r></w:p></w:document>' }, false))
  writeFileSync(join(team, 'Events', 'Deck.pptx'), zip({ 'ppt/slides/slide10.xml': '<a:p><a:t>Ten</a:t></a:p>', 'ppt/slides/slide2.xml': '<a:p><a:t>Two</a:t></a:p>' }))
  writeFileSync(join(team, 'General', 'notes.txt'), '﻿kickoff at 5')
  writeFileSync(join(team, 'General', '~$Budget 2026.xlsx'), 'lock')
  writeFileSync(join(team, 'General', '.DS_Store'), '')
  writeFileSync(join(team, 'General', 'Cloud only.pdf'), '')
  truncateSync(join(team, 'General', 'Cloud only.pdf'), 200_000)
  writeFileSync(join(base, 'outside', 'secret.txt'), 'not his to share')
  symlinkSync(join(base, 'outside'), join(team, 'General', 'way out'))
  setCloudDir((host) => (host === 'env_mac' ? cloud : join(base, 'no-cloud')))
  office = new FakeOffice()
  setCarrier(() => office)
  opened = []
  setFilesOpener(async (path) => void opened.push(path))
  mac = ctxOn('env_mac')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('finding the libraries', () => {
  it('names teams and channels from the folders, and leaves other clouds out', async () => {
    const { libraries } = (await call('work.office.filesLibraries', {})) as { libraries: TeamsLibrary[] }
    expect(libraries.map((l) => [l.team, l.library, l.kind, l.tenant, l.channels])).toEqual([
      ['My files', null, 'mine', 'Purdue University', []],
      ['Purdue Esports', null, 'channels', 'Purdue University', ['Events', 'General']],
      ['RecWell', 'Site Policies', 'library', 'Purdue University', []]
    ])
    expect(libraries.every((l) => l.found && l.host === 'env_mac' && l.id.startsWith('env_mac~'))).toBe(true)
  })

  it('splits a team from its library at the last dash', () => {
    expect(splitLibraryName('Ops - East - Documents')).toEqual({ team: 'Ops - East', library: 'Documents' })
    expect(splitLibraryName('Shortcut')).toEqual({ team: 'Shortcut', library: null })
  })

  it('takes his edits: a folder added, a found one off, a web address', async () => {
    mkdirSync(join(base, 'Purdue University', 'Club - Documents'), { recursive: true })
    const roots = [{ folder: join(base, 'Purdue University', 'Club - Documents') }, { folder: join(cloud, 'OneDrive-Purdue University'), off: true }, { folder: team, web: 'https://purdue.sharepoint.com/sites/esports/Shared Documents' }]
    const got = (await call('work.office.filesSetRoots', { roots })) as { libraries: TeamsLibrary[]; off: string[] }
    expect(got.libraries.map((l) => [l.team, l.kind, l.found])).toEqual([
      ['Club', 'folder', false],
      ['Purdue Esports', 'channels', true],
      ['RecWell', 'library', true]
    ])
    expect(got.off).toEqual([join(cloud, 'OneDrive-Purdue University')])
    const esports = got.libraries.find((l) => l.team === 'Purdue Esports')!
    expect(teamsWebOf(esports, join(team, 'General', 'Budget 2026.xlsx'))).toBe('https://purdue.sharepoint.com/sites/esports/Shared Documents/General/Budget%202026.xlsx')
  })

  it("sets the list from this computer's window only", async () => {
    const { OFFICE_CAPS } = await import('@shared/contract-work-office')
    expect(OFFICE_CAPS['work.office.filesSetRoots']).toBe('local')
  })
})

describe('a folder', () => {
  it('lists folders first, with kind, size, when, who, and whether it is downloaded', async () => {
    const { entries } = (await call('work.office.filesList', file(join(team, 'General')))) as { entries: TeamsEntry[] }
    expect(entries.map((e) => [e.name, e.kind, e.local, e.by])).toEqual([
      ['Budgets', 'folder', true, null],
      ['Budget 2026.xlsx', 'workbook', true, 'Pat Lee'],
      ['Cloud only.pdf', 'pdf', false, null],
      ['notes.txt', 'text', true, null],
      ['Plan.docx', 'document', true, 'Sam & Co']
    ])
    expect(entries.find((e) => e.name === 'Cloud only.pdf')!.size).toBe(200_000)
  })

  it('refuses a folder outside the libraries, by a link or by ..', async () => {
    await expect(call('work.office.filesList', file(join(base, 'outside')))).rejects.toThrow('not in a Teams folder')
    await expect(call('work.office.filesList', file(join(team, 'General', 'way out')))).rejects.toThrow('not in a Teams folder')
    await expect(call('work.office.filesRead', file(join(team, '..', '..', '..', 'outside', 'secret.txt')))).rejects.toThrow('not in a Teams folder')
    await expect(call('work.office.filesList', file(join(team, 'General'), 'env_box'))).rejects.toThrow('another host')
  })

  it('holds a remote key to what it could name itself, and another host of his to the libraries', async () => {
    const key: Caller = { kind: 'remote', caps: ['read'] }
    await expect(call('work.office.filesList', file(team), key)).rejects.toThrow()
    await expect(call('work.office.filesSearch', { query: 'plan' }, key)).resolves.toEqual({ entries: [], more: false })
    const peer: Caller = { kind: 'remote', caps: ['read'], peer: 'env_box' }
    await expect(call('work.office.filesList', file(team), peer)).resolves.toMatchObject({ entries: expect.any(Array) })
  })
})

describe('search', () => {
  it('finds names holding every word, in one kind, newest first', async () => {
    const all = (await call('work.office.filesSearch', { query: 'budget' })) as { entries: TeamsEntry[] }
    expect(all.entries.map((e) => e.name).sort()).toEqual(['Budget 2026.xlsx', 'Budgets'])
    const books = (await call('work.office.filesSearch', { query: 'budget 2026', kind: 'workbook' })) as { entries: TeamsEntry[] }
    expect(books.entries.map((e) => e.name)).toEqual(['Budget 2026.xlsx'])
    const none = (await call('work.office.filesSearch', { query: 'secret' })) as { entries: TeamsEntry[] }
    expect(none.entries).toEqual([])
  })
})

describe('a file', () => {
  it('tells a cloud-only file by its blocks', () => {
    expect(isLocal({ size: 200_000, blocks: 0 })).toBe(false)
    expect(isLocal({ size: 0, blocks: 0 })).toBe(true)
    expect(isLocal(statSync(join(team, 'General', 'notes.txt')))).toBe(true)
  })

  it('downloads on demand by reading it, and answers it as it is now', async () => {
    const { entry } = (await call('work.office.filesFetch', file(join(team, 'General', 'notes.txt')))) as { entry: TeamsEntry }
    expect(entry).toMatchObject({ name: 'notes.txt', local: true })
  })

  it("reads a Word file's paragraphs, a deck's slides in order, a text file as it is", async () => {
    await expect(call('work.office.filesRead', file(join(team, 'General', 'Plan.docx')))).resolves.toMatchObject({ text: 'Spring league\nRules <draft>', truncated: false })
    await expect(call('work.office.filesRead', file(join(team, 'Events', 'Deck.pptx')))).resolves.toMatchObject({ text: 'Slide 1\nTwo\n\nSlide 2\nTen' })
    await expect(call('work.office.filesRead', file(join(team, 'General', 'notes.txt')))).resolves.toMatchObject({ text: 'kickoff at 5' })
    await expect(call('work.office.filesRead', file(join(team, 'General', 'Budget 2026.xlsx')))).rejects.toThrow('office_range_read')
  })

  it('opens an Office file in its app through the carrier, anything else with the system opener', async () => {
    await call('work.office.filesOpen', file(join(team, 'General', 'Budget 2026.xlsx')))
    await call('work.office.filesOpen', file(join(team, 'General', 'notes.txt')))
    expect(office.opened).toEqual([{ app: 'excel', ref: { kind: 'path', path: join(team, 'General', 'Budget 2026.xlsx') } }])
    expect(opened).toEqual([join(team, 'General', 'notes.txt')])
  })

  it('opens in the right canvas kind', () => {
    const at = (name: string, copy = false) => teamsCanvasOf({ name, path: `/t/${name}`, kind: teamsKindOf(name) }, 'env_mac', copy)
    expect(at('B.xlsx')).toEqual({ kind: 'sheet', source: { at: 'microsoft', host: 'env_mac', app: 'excel', name: 'B.xlsx', ref: { kind: 'path', path: '/t/B.xlsx' } } })
    expect(at('P.docx')?.kind).toBe('document')
    expect(at('D.pptx')?.kind).toBe('slides')
    expect(at('R.pdf')).toEqual({ kind: 'pdf', source: { at: 'file', host: 'env_mac', path: '/t/R.pdf' } })
    expect(at('shot.png')?.kind).toBe('media')
    expect(at('clip.mov')?.kind).toBe('media')
    expect(at('B.xlsx', true)).toEqual({ kind: 'sheet', source: { at: 'file', host: 'env_mac', path: '/t/B.xlsx' } })
    expect(at('list.csv')).toBeNull()
    expect(at('notes.txt')).toBeNull()
  })

  it('reads entries out of a zip, stored or packed, and nothing from a damaged one', () => {
    const path = join(base, 'z.zip')
    writeFileSync(path, zip({ a: 'one', b: 'two' }))
    expect([...zipEntries(path, ['b'])]).toEqual([['b', 'two']])
    writeFileSync(path, 'not a zip at all')
    expect(zipEntries(path, ['a']).size).toBe(0)
  })
})

describe('the tools', () => {
  const box = (copy: boolean, onPeer: (host: string, verb: string, args: unknown) => Promise<unknown>) => {
    const ctx = ctxOn('env_box') as ToolCtx
    const canvas: { kind: string; source: unknown; title: string }[] = []
    const scope = { sessionId: 's1', workspaceId: 'w1', sector: 'purdue', host: 'env_box', away: false, routineRunId: null, shared: () => true }
    Object.assign(ctx, {
      scope,
      sessionId: 's1',
      signal: new AbortController().signal,
      settings: { workspace: () => ({ mayUseDesktop: ['env_mac'] }) },
      scopeOf: () => scope,
      peer: (host: string) => ({ call: (_m: string, verb: string, args: unknown) => onPeer(host, verb, args) }),
      canvas: { paneOf: (id: string) => id, open: (_p: string, kind: string, source: unknown, title: string) => (canvas.push({ kind, source, title }), { id: 'item1' }) }
    })
    if (copy) void module.handle!({ id: '1', method: 'work.office.filesCopySet', params: { workspaceId: 'w1', on: true } } as unknown as ClientRequest, ctx, window)
    return { ctx, canvas }
  }
  // The Mac answers a box thread's call as servePeerWork does: its own module, as another host of his.
  const viaMac = (_host: string, verb: string, args: unknown) => call(`work.office.${verb}`, args, { kind: 'remote', caps: ['read', 'operate'], peer: 'env_box' })
  const tools = (): Record<string, WorkTool> => Object.fromEntries(teamsTools(() => office).map((t) => [t.name, t]))
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text

  it("lists, searches and reads the Mac's libraries from a box thread", async () => {
    const { ctx } = box(false, viaMac)
    const libs = JSON.parse(text(await tools().teams_libraries!.run({}, ctx))) as { id: string; team: string; host: string }[]
    const esports = libs.find((l) => l.team === 'Purdue Esports')!
    expect(esports.host).toBe('env_mac')
    const listed = JSON.parse(text(await tools().teams_list!.run({ library: esports.id, folder: 'General' }, ctx))) as { file: string; by?: string }[]
    expect(listed.map((e) => e.file)).toContain('General/Budget 2026.xlsx')
    expect(listed.find((e) => e.file === 'General/Plan.docx')!.by).toBe('Sam & Co')
    const found = JSON.parse(text(await tools().teams_search!.run({ query: 'deck' }, ctx))) as { library: string; file: string }[]
    expect(found).toEqual([expect.objectContaining({ library: esports.id, file: 'Events/Deck.pptx' })])
    expect(text(await tools().teams_read!.run({ library: esports.id, file: 'General/Plan.docx' }, ctx))).toBe('Spring league\nRules <draft>')
    const out = await tools().teams_read!.run({ library: esports.id, file: 'General/way out/secret.txt' }, ctx)
    expect(out).toMatchObject({ isError: true })
  })

  it('refuses a library on a host the workspace may not use', async () => {
    const { ctx } = box(false, viaMac)
    const out = await tools().teams_list!.run({ library: 'env_pc~0123456789' }, ctx)
    expect(text(out)).toContain('may not use')
  })

  it('with no copy allowed, opens a Mac file in its app there and leaves nothing on the box', async () => {
    const { ctx, canvas } = box(false, viaMac)
    const libs = JSON.parse(text(await tools().teams_libraries!.run({}, ctx))) as { id: string; team: string }[]
    const esports = libs.find((l) => l.team === 'Purdue Esports')!.id
    const said = text(await tools().teams_open!.run({ library: esports, file: 'General/Budget 2026.xlsx' }, ctx))
    expect(said).toContain('open in Excel on env_mac')
    expect(said).toContain('does not copy')
    expect(office.opened).toHaveLength(1)
    expect(canvas).toEqual([])
    expect(existsSync(copyDirOf(ctx.dataDir, 's1'))).toBe(false)
  })

  it('with the copy he allowed, lands the file in the thread\'s attachments and opens it in the canvas', async () => {
    const { ctx, canvas } = box(true, viaMac)
    const libs = JSON.parse(text(await tools().teams_libraries!.run({}, ctx))) as { id: string; team: string }[]
    const esports = libs.find((l) => l.team === 'Purdue Esports')!.id
    await tools().teams_open!.run({ library: esports, file: 'General/Plan.docx' }, ctx)
    expect(canvas).toEqual([{ kind: 'document', source: { at: 'file', host: 'env_box', path: expect.stringContaining(copyDirOf(ctx.dataDir, 's1')) }, title: 'Plan.docx' }])
    const copy = (canvas[0]!.source as { path: string }).path
    expect(readFileSync(copy)).toEqual(readFileSync(join(team, 'General', 'Plan.docx')))
    // Turned off, the copies its threads hold go too; a deleted thread's go with it.
    await module.handle!({ id: '1', method: 'work.office.filesCopySet', params: { workspaceId: 'w1', on: false } } as unknown as ClientRequest, ctx, window)
    expect(existsSync(copy)).toBe(false)
    mkdirSync(copyDirOf(ctx.dataDir, 's2'), { recursive: true })
    module.sessionsRemoved!(['s2'], ctx)
    expect(existsSync(copyDirOf(ctx.dataDir, 's2'))).toBe(false)
  })

  it("opens a file in the canvas of a thread on the file's own host", async () => {
    const { ctx: boxCtx, canvas } = box(false, viaMac)
    const ctx = Object.assign(mac, { scope: { ...(boxCtx as ToolCtx).scope, host: 'env_mac' }, sessionId: 's1', signal: (boxCtx as ToolCtx).signal, settings: { workspace: () => ({ mayUseDesktop: [] }) }, canvas: (boxCtx as ToolCtx).canvas }) as ToolCtx
    const libs = JSON.parse(text(await tools().teams_libraries!.run({}, ctx))) as { id: string; team: string }[]
    const esports = libs.find((l) => l.team === 'Purdue Esports')!.id
    await tools().teams_open!.run({ library: esports, file: 'General/Cloud only.pdf' }, ctx)
    expect(canvas).toEqual([{ kind: 'pdf', source: { at: 'file', host: 'env_mac', path: join(team, 'General', 'Cloud only.pdf') }, title: 'Cloud only.pdf' }])
  })
})

describe('from the review', () => {
  it('leaves a consumer OneDrive out, and lists a folder added through a link once, by its real path', async () => {
    mkdirSync(join(cloud, 'OneDrive-Personal'), { recursive: true })
    symlinkSync(team, join(base, 'Esports link'))
    await call('work.office.filesSetRoots', { roots: [{ folder: join(base, 'Esports link'), web: 'https://p.sharepoint.com/e' }] })
    const { libraries } = (await call('work.office.filesLibraries', {})) as { libraries: TeamsLibrary[] }
    expect(libraries.map((l) => l.team)).toEqual(['My files', 'Purdue Esports', 'RecWell'])
    expect(libraries.find((l) => l.team === 'Purdue Esports')).toMatchObject({ path: realpathSync(team), web: 'https://p.sharepoint.com/e' })
  })

  it('gives bytes only to another host of his, and refuses a file too big before it downloads', async () => {
    await expect(call('work.office.filesRead', { ...file(join(team, 'General', 'notes.txt')), as: 'bytes' })).rejects.toThrow('another host')
    const peer: Caller = { kind: 'remote', caps: ['read'], peer: 'env_box' }
    await expect(call('work.office.filesRead', { ...file(join(team, 'General', 'notes.txt')), as: 'bytes' }, peer)).resolves.toMatchObject({ name: 'notes.txt' })
    const big = join(team, 'General', 'Recording.mp4')
    writeFileSync(big, '')
    truncateSync(big, 60 * 1024 * 1024)
    await expect(call('work.office.filesRead', { ...file(big), as: 'bytes' }, peer)).rejects.toThrow('over 48 MB')
    expect(isLocal(statSync(big))).toBe(false)
  })

  it('reads only the head of a long text file', async () => {
    writeFileSync(join(team, 'General', 'big.log'), 'x'.repeat(1_000_000))
    const got = (await call('work.office.filesRead', file(join(team, 'General', 'big.log')))) as { text: string; truncated: boolean }
    expect(got.text.length).toBe(200_000)
    expect(got.truncated).toBe(true)
  })

  it('stops inflating an entry at the most it may be, whatever size the zip claims', () => {
    const path = join(base, 'bomb.docx')
    const bytes = zip({ 'docProps/core.xml': 'a'.repeat(2_000_000) })
    // The maker says the entry is ten bytes; it inflates to two million.
    bytes.writeUInt32LE(10, bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24)
    writeFileSync(path, bytes)
    expect(zipEntries(path, ['docProps/core.xml'], 1024).size).toBe(0)
  })

  it('lets a name that starts with two dots through the fence', async () => {
    writeFileSync(join(team, '..notes'), 'ok')
    await expect(call('work.office.filesRead', file(join(team, '..notes')))).rejects.toThrow('no text')
  })
})

describe('the shared-file rule on a Teams file', () => {
  it("writes the agent's own idea to a workbook in a folder he added as a suggestion, not to the file", async () => {
    const added = join(base, 'Purdue University', 'Club - Documents')
    mkdirSync(added, { recursive: true })
    const book = join(added, 'Roster.xlsx')
    writeFileSync(book, '')
    await call('work.office.filesSetRoots', { roots: [{ folder: added }] })
    office.addBook(book, { Sheet1: { A1: 1 } })
    const peer: Caller = { kind: 'remote', caps: ['read', 'operate'], peer: 'env_box' }
    const got = await call('work.office.write', { tool: 'office_range_write', args: { workbook: book, range: 'Sheet1!A1', values: [[2]], because: 'own' }, by: 'agent:env_box:t1' }, peer)
    expect(JSON.stringify(got)).toContain('nothing was written')
    // The same idea on a workbook outside every Teams folder is written (the rule judges the file, not the thread).
    office.addBook(join(base, 'outside', 'Mine.xlsx'), { Sheet1: { A1: 1 } })
    const own = await call('work.office.write', { tool: 'office_range_write', args: { workbook: join(base, 'outside', 'Mine.xlsx'), range: 'Sheet1!A1', values: [[2]], because: 'own' } }, window)
    expect(JSON.stringify(own)).not.toContain('nothing was written')
  })
})
