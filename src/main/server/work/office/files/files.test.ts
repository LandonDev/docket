import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { strToU8, zipSync } from 'fflate'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import { teamsCanvasOf, teamsKindOf, teamsWebOf, type TeamsEntry, type TeamsLibrary } from '@shared/contract-work-office'
import { FenceError, fenceRequest } from '../../../remote/fence'
import type { Caller, ToolCtx, WorkCtx, WorkTool } from '../../modules'
import { FakeOffice } from '../fake'
import { office as module, setCarrier } from '../index'
import { copyDirOf, copyFolderOf, setFilesOpener } from './handle'
import { isLocal, setCloudDir, splitLibraryName, tenantOfSynced } from './library'
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
    // The one table of file types (files.ts `kindOfEntry`) decides: a CSV is a sheet read as the file it is, with no Excel behind it.
    expect(at('list.csv')).toEqual({ kind: 'sheet', source: { at: 'file', host: 'env_mac', path: '/t/list.csv' } })
    // An old Office form has its app behind it in place; as a copy the sheet kind reads it, as an Excel copy of its own.
    expect(at('old.xls')).toEqual({ kind: 'sheet', source: { at: 'microsoft', host: 'env_mac', app: 'excel', name: 'old.xls', ref: { kind: 'path', path: '/t/old.xls' } } })
    expect(at('old.xls', true)).toEqual({ kind: 'sheet', source: { at: 'file', host: 'env_mac', path: '/t/old.xls' } })
    // A .tsv has no app behind it, as a .csv has none.
    expect(at('scores.tsv')).toEqual({ kind: 'sheet', source: { at: 'file', host: 'env_mac', path: '/t/scores.tsv' } })
    expect(at('macro.xlsb', true)).toBeNull()
    // Text and sound wait for the file kind: until then they open in their own app.
    expect(at('notes.txt')).toBeNull()
    expect(at('README.md')).toBeNull()
    expect(at('call.m4a')).toBeNull()
    expect(at('bundle.zip')).toBeNull()
    expect(teamsCanvasOf({ name: 'Events', path: '/t/Events', kind: 'folder' }, 'env_mac')).toBeNull()
  })

  it('names kinds from the one table, in the words its tools have always used', () => {
    expect(['B.xlsx', 'old.xls', 'list.csv', 'P.docx', 'D.pptx', 'R.pdf', 'shot.png', 'clip.mov', 'call.m4a', 'notes.txt', 'bundle.zip', 'thing.xyz'].map(teamsKindOf)).toEqual(['workbook', 'workbook', 'workbook', 'document', 'deck', 'pdf', 'picture', 'video', 'audio', 'text', 'other', 'other'])
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

describe('the layout OneDrive 26 writes (his Mac, 2026-11-20)', () => {
  // Names as they are on his Mac: his own OneDrive, and a team's library synced from Teams → Files → Sync beside it.
  let real26: string
  let recwell: string
  beforeEach(() => {
    real26 = join(base, 'CloudStorage-26')
    recwell = join(real26, 'OneDrive-purdue.edu-RecWell-TeamRecWell')
    for (const dir of ['Attachments', 'Meetings', 'Microsoft Copilot Chat Files', 'Recordings']) mkdirSync(join(real26, 'OneDrive-purdue.edu', dir), { recursive: true })
    for (const dir of ['Business Office', 'Engagement', 'IMs', 'Operations', 'Outreach', 'PD & Travel', 'Personnel', 'Photos']) mkdirSync(join(recwell, dir), { recursive: true })
    for (const dir of ['Club Sports', 'Esports', 'Intramurals']) mkdirSync(join(real26, 'OneDrive-purdue.edu-RecWell-SportPrograms', dir), { recursive: true })
    writeFileSync(join(recwell, 'Staff schedule.xlsx'), '')
    truncateSync(join(recwell, 'Staff schedule.xlsx'), 40_000)
    setCloudDir((host) => (host === 'env_mac' ? real26 : join(base, 'no-cloud')))
  })

  it("reads OneDrive-<tenant>-<name> beside OneDrive-<tenant> as a library of that tenant, named as OneDrive wrote it", async () => {
    const { libraries } = (await call('work.office.filesLibraries', {})) as { libraries: TeamsLibrary[] }
    expect(libraries.map((l) => [l.team, l.library, l.kind, l.tenant, l.channels])).toEqual([
      ['My files', null, 'mine', 'purdue.edu', []],
      ['RecWell-SportPrograms', null, 'library', 'purdue.edu', []],
      ['RecWell-TeamRecWell', null, 'library', 'purdue.edu', []]
    ])
    const { entries } = (await call('work.office.filesList', file(recwell))) as { entries: TeamsEntry[] }
    expect(entries.map((e) => e.name)).toContain('PD & Travel')
    expect(entries.find((e) => e.name === 'Staff schedule.xlsx')).toMatchObject({ kind: 'workbook', local: false })
  })

  it('reads its top folders as channels when one is General, the channel every team has', async () => {
    mkdirSync(join(recwell, 'General'))
    const { libraries } = (await call('work.office.filesLibraries', {})) as { libraries: TeamsLibrary[] }
    expect(libraries[2]).toMatchObject({ team: 'RecWell-TeamRecWell', kind: 'channels', channels: expect.arrayContaining(['General', 'Operations']) })
  })

  it('finds the tenant by the plain OneDrive folder, the longest that fits', () => {
    const names = ['purdue.edu', 'purdue.edu-RecWell-SportPrograms', 'purdue.edu-RecWell-TeamRecWell']
    expect(tenantOfSynced('purdue.edu-RecWell-TeamRecWell', names)).toBe('purdue.edu')
    expect(tenantOfSynced('purdue.edu', names)).toBeNull()
    expect(tenantOfSynced('purdue.edu-Ops', ['purdue', 'purdue.edu', 'purdue.edu-Ops'])).toBe('purdue.edu')
    // With no plain folder to tell the tenant by, a name is his own OneDrive.
    expect(tenantOfSynced('contoso-Sales', ['contoso-Sales'])).toBeNull()
  })

  it("holds its files to the shared-file rule and the copy switch, as a team's library", async () => {
    const book = join(recwell, 'Staff schedule.xlsx')
    office.addBook(book, { Sheet1: { A1: 1 } })
    const peer: Caller = { kind: 'remote', caps: ['read', 'operate'], peer: 'env_box' }
    const got = await call('work.office.write', { tool: 'office_range_write', args: { workbook: book, range: 'Sheet1!A1', values: [[2]], because: 'own' }, by: 'agent:env_box:t1' }, peer)
    expect(JSON.stringify(got)).toContain('nothing was written')
    // A box thread whose workspace has not turned the copy on gets no copy of it.
    const boxCtx = ctxOn('env_box', { scopeOf: () => ({ sessionId: 's1', workspaceId: 'w1' }) } as unknown as Partial<WorkCtx>)
    await expect(call('work.office.filesCopy', { sessionId: 's1', source: { at: 'file', host: 'env_mac', path: book } }, window, boxCtx)).rejects.toThrow('keeps Teams files where they are')
    await expect(call('work.office.filesRead', { ...file(book), as: 'bytes' })).rejects.toThrow('another host')
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

describe('the thread that already holds a file', () => {
  const item = (id: string, sessionId: string, source: object, state: 'open' | 'closed' = 'open') => ({ id, sessionId, workspaceId: 'w1', kind: 'document', title: id, source, state, position: 0, rev: 1, createdAt: 0, updatedAt: 0 })
  /** The workspace's host is `host`; the file is `plan` on `fileHost`. */
  const holding = async (items: ReturnType<typeof item>[], host = 'env_box', plan = '/c/T/General/Plan.docx', fileHost = 'env_mac') => {
    const forWorkspace = (id: string, o?: { open?: boolean }) => (id === 'w1' ? items.filter((i) => !o?.open || i.state === 'open') : [])
    const ctx = ctxOn(host, { canvas: { forWorkspace } } as unknown as Partial<WorkCtx>)
    const answer = (await call('work.office.filesThreads', { workspaceId: 'w1', source: { at: 'file', host: fileHost, path: plan } }, window, ctx)) as { threads: { sessionId: string; itemId: string }[] }
    return answer.threads.map((t) => [t.sessionId, t.itemId])
  }

  it('finds the copy he allowed by its folder, and the file as its Office app holds it, newest first, with each item\'s source', async () => {
    const plan = '/c/T/General/Plan.docx'
    const copy = join(copyFolderOf(ctxOn('env_box').dataDir, 's1', { host: 'env_mac', path: plan }), 'Plan.docx')
    const word = { at: 'microsoft', host: 'env_mac', app: 'word', name: 'Plan.docx', ref: { kind: 'path', path: plan } }
    const items = [item('copy', 's1', { at: 'file', host: 'env_box', path: copy }), item('word', 's3', word), item('here', 's4', { at: 'file', host: 'env_mac', path: plan }), item('also', 's4', { at: 'file', host: 'env_mac', path: plan })]
    expect(await holding(items)).toEqual([
      ['s1', 'copy'],
      ['s3', 'word'],
      ['s4', 'here'],
    ])
    const ctx = ctxOn('env_box', { canvas: { forWorkspace: () => items } } as unknown as Partial<WorkCtx>)
    const answer = (await call('work.office.filesThreads', { workspaceId: 'w1', source: { at: 'file', host: 'env_mac', path: plan } }, window, ctx)) as { threads: { source: unknown }[] }
    expect(answer.threads[1]!.source).toEqual(word)
  })

  it("finds the document a Word file became beside it on the workspace's own host, by the importer's names", async () => {
    const folder = join(base, 'lib', 'General')
    mkdirSync(folder, { recursive: true })
    const plan = join(folder, 'Plan  review.docx')
    const at = (name: string) => ({ at: 'file', host: 'env_mac', path: join(folder, name) })
    // Each records, as the importer writes it, the file it came from.
    for (const [name, from] of [['Plan review.tcdoc', 'Plan  review.docx'], ['Plan review 2.tcdoc', 'Plan  review.docx'], ['Plan review (2).tcdoc', 'Plan review (2).docx'], ['Report.tcdoc', 'Report.docx']])
      writeFileSync(join(folder, name), zipSync({ 'sidecar.json': strToU8(JSON.stringify({ source: { name: from, format: 'docx', importedAt: 1 } })) }))
    expect(await holding([item('made', 's1', at('Plan review.tcdoc'))], 'env_mac', plan)).toEqual([['s1', 'made']])
    expect(await holding([item('second', 's2', at('Plan review 2.tcdoc'))], 'env_mac', plan)).toEqual([['s2', 'second']])
    // Another file's document: "Plan review (2).docx" beside it, or a PDF of the same name.
    expect(await holding([item('other', 's3', at('Plan review (2).tcdoc'))], 'env_mac', plan)).toEqual([])
    expect(await holding([item('pdf', 's4', at('Report.tcdoc'))], 'env_mac', join(folder, 'Report.pdf'))).toEqual([])
    // Read through a link to the same folder, it is still the same document.
    symlinkSync(folder, join(base, 'lib', 'Linked'))
    expect(await holding([item('made', 's1', at('Plan review.tcdoc'))], 'env_mac', join(base, 'lib', 'Linked', 'Plan  review.docx'))).toEqual([['s1', 'made']])
  })

  it('passes over a closed item, another file of the same name, the same path on another host and another file\'s copy', async () => {
    const plan = '/c/T/General/Plan.docx'
    const other = join(copyFolderOf(ctxOn('env_box').dataDir, 's4', { host: 'env_mac', path: '/c/T/Events/Plan.docx' }), 'Plan.docx')
    expect(
      await holding([
        item('closed', 's1', { at: 'file', host: 'env_mac', path: plan }, 'closed'),
        item('elsewhere', 's2', { at: 'file', host: 'env_mac', path: '/c/T/Events/Plan.docx' }),
        item('other host', 's3', { at: 'file', host: 'env_pc', path: plan }),
        item('other copy', 's4', { at: 'file', host: 'env_box', path: other }),
        item('made far', 's5', { at: 'file', host: 'env_mac', path: '/c/T/General/Plan.tcdoc' }),
      ]),
    ).toEqual([])
  })
})

describe("his window on the box opens the Mac's files one after another (F-files-refused)", () => {
  // The box: a Work workspace whose copy switch is on and which may use the Mac. His Mac's window reaches it as a
  // remote key: each request passes the listener's fence first (index.ts), with the box's roots and its own id.
  const key: Caller = { kind: 'remote', caps: ['read', 'operate', 'approve'] }
  // Host ids as environment.ts makes them: the listener passes only such an id as another host's.
  const MAC = 'env_MacMacMacMacMacMacMacM'
  const BOX = 'env_BoxBoxBoxBoxBoxBoxBoxB'
  const rig = () => {
    const items: { id: string; sessionId: string; workspaceId: string; source: unknown; state: 'open' }[] = []
    const asked: { host: string; verb: string; args: unknown }[] = []
    const macCtx = ctxOn(MAC)
    setCloudDir((host) => (host === MAC ? cloud : join(base, 'no-cloud')))
    const ctx = ctxOn(BOX, {
      settings: { workspace: () => ({ mayUseDesktop: [MAC] }) },
      scopeOf: (sessionId: string) => ({ sessionId, workspaceId: 'w1', sector: 'purdue', host: BOX, away: false, routineRunId: null, shared: () => true }),
      // The Mac answers as servePeerWork does: its own module, as another host of his. A host the workspace may not
      // use is refused before it is asked, as work/peer.ts refuses it.
      peer: (host: string) => ({
        call: async (_m: string, verb: string, args: unknown) => {
          if (host !== MAC) throw new Error("this workspace may not use that host's desktop")
          asked.push({ host, verb, args })
          return call(`work.office.${verb}`, args, { kind: 'remote', caps: ['read'], peer: BOX }, macCtx)
        }
      }),
      canvas: { forWorkspace: (id: string) => items.filter((i) => i.workspaceId === id) }
    } as unknown as Partial<WorkCtx>)
    void module.handle!({ id: '1', method: 'work.office.filesCopySet', params: { workspaceId: 'w1', on: true } } as unknown as ClientRequest, ctx, window)
    const roots = [join(base, 'box-work')]
    mkdirSync(roots[0]!, { recursive: true })
    /** One request from his window: the listener's fence, then the pillar. */
    const fromWindow = async (method: string, params: Record<string, unknown>): Promise<never> => {
      const req = { id: '1', method, params } as unknown as ClientRequest
      fenceRequest(req, roots, [], [], BOX)
      return call(method, params, key, ctx)
    }
    /** The Files view's open (FilesView.tsx `useOpener`): the thread holding it, else a new thread, its copy and its item. */
    const open = async (sessionId: string, path: string): Promise<{ sessionId: string; reused: boolean; copy?: string }> => {
      const source = { at: 'file', host: MAC, path }
      const held = (await fromWindow('work.office.filesThreads', { workspaceId: 'w1', source })) as { threads: { sessionId: string }[] }
      if (held.threads[0]) return { sessionId: held.threads[0].sessionId, reused: true }
      const copy = (await fromWindow('work.office.filesCopy', { sessionId, source })) as { source: { at: 'file'; host: string; path: string } }
      items.push({ id: `item-${sessionId}`, sessionId, workspaceId: 'w1', source: copy.source, state: 'open' })
      return { sessionId, reused: false, copy: copy.source.path }
    }
    return { ctx, asked, fromWindow, open, roots, MAC }
  }
  const deck = () => join(team, 'Events', 'Deck.pptx')
  const pdf = () => join(team, 'General', 'Cloud only.pdf')
  const plan = () => join(team, 'General', 'Plan.docx')

  it('opens a deck, then a PDF, then a document, each a thread with a copy of its own bytes', async () => {
    const { open, asked } = rig()
    const first = await open('s1', deck())
    expect(readFileSync(first.copy!)).toEqual(readFileSync(deck()))
    const second = await open('s2', pdf())
    expect(second).toMatchObject({ sessionId: 's2', reused: false })
    expect(statSync(second.copy!).size).toBe(200_000)
    const third = await open('s3', plan())
    expect(readFileSync(third.copy!)).toEqual(readFileSync(plan()))
    // Every byte came from the Mac over the host link, never from a path of the box's disk.
    expect(asked.map((a) => [a.host, a.verb])).toEqual([[MAC, 'filesRead'], [MAC, 'filesRead'], [MAC, 'filesRead']])
  })

  it("opens the same file again in its own thread, making no second copy", async () => {
    const { open, asked } = rig()
    await open('s1', deck())
    await open('s2', pdf())
    expect(await open('s9', deck())).toEqual({ sessionId: 's1', reused: true })
    expect(asked).toHaveLength(2)
  })

  it("refuses a path of the box's own disk outside its roots, by its own host or by none, at the fence", async () => {
    const { fromWindow } = rig()
    const secret = join(base, 'outside', 'secret.txt')
    for (const source of [{ at: 'file', host: BOX, path: secret }, { at: 'file', path: secret }, { at: 'microsoft', host: BOX, app: 'word', name: 'x', ref: { kind: 'path', path: secret } }])
      await expect(fromWindow('work.office.filesCopy', { sessionId: 's1', source })).rejects.toThrow(FenceError)
    // One source of another host's beside one of this host's outside the roots: the request is refused whole.
    await expect(fromWindow('work.office.filesCopy', { sessionId: 's1', source: { at: 'file', host: MAC, path: deck() }, extra: { at: 'file', host: BOX, path: secret } })).rejects.toThrow(FenceError)
  })

  it("never opens a path of the box's disk for a source that claims another host: the claimed host is asked, and it holds the path to its libraries", async () => {
    const { fromWindow, asked } = rig()
    const secret = join(base, 'outside', 'secret.txt')
    await expect(fromWindow('work.office.filesCopy', { sessionId: 's1', source: { at: 'file', host: MAC, path: secret } })).rejects.toThrow('Teams')
    expect(asked).toEqual([{ host: MAC, verb: 'filesRead', args: { source: { at: 'file', host: MAC, path: secret }, as: 'bytes' } }])
    // A host the workspace may not use is never asked at all.
    await expect(fromWindow('work.office.filesCopy', { sessionId: 's1', source: { at: 'file', host: 'env_OtherOtherOtherOtherOt', path: secret } })).rejects.toThrow('may not use')
    expect(asked).toHaveLength(1)
    // The threads verb only matches the source against the canvas's items: it reads nothing.
    await expect(fromWindow('work.office.filesThreads', { workspaceId: 'w1', source: { at: 'file', host: 'env_OtherOtherOtherOtherOt', path: secret } })).resolves.toEqual({ threads: [] })
  })

  it('never writes a copy through a link left where it lands', async () => {
    const { ctx, open } = rig()
    const target = join(base, 'outside', 'secret.txt')
    // a link where the deck's copy would land
    const dir = copyFolderOf(ctx.dataDir, 's1', { host: MAC, path: deck() })
    mkdirSync(dir, { recursive: true })
    symlinkSync(target, join(dir, 'Deck.pptx'))
    await expect(open('s1', deck())).rejects.toThrow('is a link')
    // a link in place of the source's own folder
    const other = copyFolderOf(ctx.dataDir, 's2', { host: MAC, path: pdf() })
    mkdirSync(dirname(other), { recursive: true })
    symlinkSync(join(base, 'outside'), other)
    await expect(open('s2', pdf())).rejects.toThrow('not a folder')
    expect(readFileSync(target, 'utf8')).toBe('not his to share')
  })

  it("passes a file in the box's Windows VM by the guest's own path, and the pillar holds it to the VM's libraries", async () => {
    const { fromWindow } = rig()
    const guest = 'C:\\Users\\tcuser\\Purdue University\\RecWell - Documents\\Budget.xlsx'
    // The fence lets it by; with no VM on this box, the copy is refused in the pillar's own words, never at the fence.
    const err = await fromWindow('work.office.filesCopy', { sessionId: 's1', source: { at: 'file', host: BOX, path: guest } }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(FenceError)
  })
})
