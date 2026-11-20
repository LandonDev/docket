import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkToolResult } from '@shared/work'
import type { ToolCtx } from '../modules'
import { ensurePuts, fileTools, FILE_MAX_BYTES, freeName, guestNameRefusal, NOT_IN_WORKSPACE, RUNS, TOO_BIG, type GuestFiles } from './files'

/**
 * The file tools over a fake guest (its three folders in memory, its admin
 * answering the few scripts the tools send) and a real workspace folder:
 * the fence at both ends, the cap, the refused types, the Result and its
 * undo.
 */

let dir: string
let ws: string
let db: DatabaseSync
let results: { kind: string; summary: string; undo?: { pillar: string; verb: string; args: unknown } }[]
let guestFolders: Record<string, Map<string, Buffer>>
let enterLine: string | null
let links: Set<string>

const fakeGuest = (): GuestFiles => ({
  enter: async () => enterLine,
  async admin(script) {
    const folder = /\$dir = 'C:\\Users\\tcuser\\(\w+)'/.exec(script)?.[1] ?? ''
    if (links.has(folder)) throw new Error("the guest's script failed (exit 1): that folder is not a plain folder")
    const files = guestFolders[folder]
    const name = /Join-Path \$dir '((?:[^']|'')*)'/.exec(script)?.[1]?.replace(/''/g, "'")
    if (script.includes('Get-ChildItem')) return [...files.keys()].join('\r\n')
    if (script.includes('Remove-Item')) {
      const f = name !== undefined ? files.get(name) : undefined
      if (!f) return 'gone'
      const want = /-ne '([0-9a-f]{64})'/.exec(script)?.[1]
      if (createHash('sha256').update(f).digest('hex') !== want) return 'changed'
      files.delete(name!)
      return 'removed'
    }
    if (script.includes('size $($f.Length)')) {
      const f = name !== undefined ? files.get(name) : undefined
      return f ? `size ${f.length}` : 'missing'
    }
    throw new Error(`a script the fake does not know: ${script.slice(0, 80)}`)
  },
  async send(local, rel) {
    const [folder, name] = rel.split('/')
    guestFolders[folder].set(name, readFileSync(local))
  },
  async fetch(rel, local) {
    const [folder, name] = rel.split('/')
    writeFileSync(local, guestFolders[folder].get(name)!)
  }
})

const ctxOf = (sessionId = 't-work', workspaceId: string | null = 'ws') =>
  ({
    db,
    sessionId,
    scope: { sessionId, workspaceId },
    signal: new AbortController().signal,
    reaches: () => true,
    results: { add: (r: (typeof results)[number]) => results.push(r) }
  }) as unknown as ToolCtx
const tool = (name: string) => fileTools(() => fakeGuest()).find((t) => t.name === name)!
const call = (name: string, args: unknown, sessionId?: string, workspaceId?: string | null) => tool(name).run(args, ctxOf(sessionId, workspaceId)) as Promise<WorkToolResult>
const text = (r: WorkToolResult) => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'winvm-files-'))
  ws = join(dir, 'Purdue')
  mkdirSync(join(ws, 'out'), { recursive: true })
  writeFileSync(join(ws, 'Budget.xlsx'), 'a budget')
  writeFileSync(join(dir, 'secret.txt'), 'not the workspace\'s')
  db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT)')
  db.prepare('INSERT INTO workspaces (id, path) VALUES (?, ?)').run('ws', ws)
  ensurePuts(db)
  results = []
  guestFolders = { Documents: new Map(), Downloads: new Map(), Desktop: new Map() }
  enterLine = null
  links = new Set()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('windows_put', () => {
  it("copies a workspace file into tcuser's folder, records a Result whose undo removes it, and the undo removes it", async () => {
    const r = await call('windows_put', { path: 'Budget.xlsx', to: 'Documents' })
    expect(r.isError).toBeFalsy()
    expect(text(r)).toBe('Put Budget.xlsx in Documents on the Windows VM as C:\\Users\\tcuser\\Documents\\Budget.xlsx.')
    expect(guestFolders.Documents.get('Budget.xlsx')?.toString()).toBe('a budget')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ kind: 'windows.put', summary: 'Put Budget.xlsx in Documents on the Windows VM', undo: { pillar: 'winvm', verb: 'windows_put_undo' } })
    const undo = await call('windows_put_undo', results[0].undo!.args)
    expect(text(undo)).toBe('Removed Budget.xlsx from Documents on the Windows VM.')
    expect(guestFolders.Documents.has('Budget.xlsx')).toBe(false)
    expect(text(await call('windows_put_undo', results[0].undo!.args))).toBe('Budget.xlsx was already gone from Documents.')
  })

  it('takes a free name when the one asked for is taken, and a name of its own', async () => {
    guestFolders.Downloads.set('budget.xlsx', Buffer.from('theirs'))
    await call('windows_put', { path: 'Budget.xlsx', to: 'Downloads' })
    expect([...guestFolders.Downloads.keys()]).toEqual(['budget.xlsx', 'Budget (1).xlsx'])
    await call('windows_put', { path: 'Budget.xlsx', to: 'Desktop', name: 'Q3 budget.xlsx' })
    expect(guestFolders.Desktop.has('Q3 budget.xlsx')).toBe(true)
  })

  it('leaves a file that changed since it was put, and refuses another thread its undo', async () => {
    await call('windows_put', { path: 'Budget.xlsx', to: 'Documents' })
    const args = results[0].undo!.args
    expect((await call('windows_put_undo', args, 't-other')).isError).toBe(true)
    guestFolders.Documents.set('Budget.xlsx', Buffer.from('edited in the guest'))
    const r = await call('windows_put_undo', args)
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/changed since it was put; it is left as it is/)
    expect(guestFolders.Documents.has('Budget.xlsx')).toBe(true)
  })

  it('takes nothing from outside the workspace: no step out, no link out, no Work Chat', async () => {
    expect(text(await call('windows_put', { path: '../secret.txt', to: 'Documents' }))).toBe(NOT_IN_WORKSPACE)
    expect(text(await call('windows_put', { path: join(dir, 'secret.txt'), to: 'Documents' }))).toBe(NOT_IN_WORKSPACE)
    symlinkSync(join(dir, 'secret.txt'), join(ws, 'looks-local.txt'))
    expect(text(await call('windows_put', { path: 'looks-local.txt', to: 'Documents' }))).toBe(NOT_IN_WORKSPACE)
    expect((await call('windows_put', { path: 'Budget.xlsx', to: 'Documents' }, 't-chat', null)).isError).toBe(true)
    expect(guestFolders.Documents.size).toBe(0)
  })

  it('refuses a file Windows runs, by its name in the workspace or the name asked for', async () => {
    for (const name of ['setup.exe', 'run.ps1', 'a.lnk', 'b.reg', 'c.msi', 'd.bat', 'e.hta', 'f.vbs', 'g.dll']) {
      writeFileSync(join(ws, name), 'x')
      expect(text(await call('windows_put', { path: name, to: 'Downloads' })), name).toBe(RUNS)
    }
    expect(text(await call('windows_put', { path: 'Budget.xlsx', to: 'Downloads', name: 'Budget.cmd' }))).toBe(RUNS)
    expect(guestFolders.Downloads.size).toBe(0)
  })

  it('refuses a name that is not a plain file name in the folder', async () => {
    for (const name of ['..', 'a\\b.txt', 'a/b.txt', 'x.txt:hidden', 'PROGRA~1.txt', 'CON.txt', 'nul', 'trailing.', 'trailing ', 'a?.txt'])
      expect(await call('windows_put', { path: 'Budget.xlsx', to: 'Documents', name }), name).toMatchObject({ isError: true })
    expect(guestFolders.Documents.size).toBe(0)
  })

  it('refuses a file past 200 MB', async () => {
    writeFileSync(join(ws, 'big.mp4'), '')
    truncateSync(join(ws, 'big.mp4'), FILE_MAX_BYTES + 1)
    expect(text(await call('windows_put', { path: 'big.mp4', to: 'Documents' }))).toBe(TOO_BIG)
  })

  it('refuses a guest folder that is a link elsewhere, and passes on the lease or wake refusal', async () => {
    links.add('Documents')
    await expect(call('windows_put', { path: 'Budget.xlsx', to: 'Documents' })).rejects.toThrow('not a plain folder')
    enterLine = "The Windows VM is in use by 'Expense report'."
    expect(text(await call('windows_put', { path: 'Budget.xlsx', to: 'Downloads' }))).toBe(enterLine)
  })
})

describe('windows_get', () => {
  it("copies a file from tcuser's folder into the workspace, under a free name, into a folder of the workspace", async () => {
    guestFolders.Downloads.set('Report.pdf', Buffer.from('a report'))
    expect(text(await call('windows_get', { from: 'Downloads', name: 'Report.pdf' }))).toBe('Copied Report.pdf from Downloads on the Windows VM into the workspace as Report.pdf.')
    expect(readFileSync(join(ws, 'Report.pdf'), 'utf8')).toBe('a report')
    expect(text(await call('windows_get', { from: 'Downloads', name: 'Report.pdf' }))).toMatch(/as Report \(1\)\.pdf\.$/)
    expect(text(await call('windows_get', { from: 'Downloads', name: 'Report.pdf', path: 'out' }))).toMatch(/as out\/Report\.pdf\.$/)
  })

  it('refuses a missing file, a bad name, a folder outside the workspace and a file past 200 MB', async () => {
    expect(text(await call('windows_get', { from: 'Desktop', name: 'nope.txt' }))).toBe('refused: no file nope.txt in Desktop')
    expect((await call('windows_get', { from: 'Desktop', name: '..\\..\\tcadmin\\secret.txt' })).isError).toBe(true)
    guestFolders.Desktop.set('a.txt', Buffer.from('x'))
    expect(text(await call('windows_get', { from: 'Desktop', name: 'a.txt', path: '..' }))).toBe(NOT_IN_WORKSPACE)
    const big = { length: FILE_MAX_BYTES + 1 } as Buffer
    guestFolders.Desktop.set('big.mp4', big)
    expect(text(await call('windows_get', { from: 'Desktop', name: 'big.mp4' }))).toBe(TOO_BIG)
  })
})

describe('the names', () => {
  it('a free name numbers before the extension', () => {
    const taken = new Set(['a.txt', 'a (1).txt'])
    expect(freeName('a.txt', (n) => taken.has(n))).toBe('a (2).txt')
    expect(freeName('b.txt', (n) => taken.has(n))).toBe('b.txt')
  })

  it('a guest name is a plain name', () => {
    expect(guestNameRefusal('Budget 2026.xlsx')).toBeNull()
    expect(guestNameRefusal('LPT1')).toMatch(/device name/)
    expect(guestNameRefusal('a:b')).toMatch(/stream/)
  })
})
