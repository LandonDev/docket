import { expect, it, vi } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import { handled, NOT_HANDLED } from '@shared/work'
import type { WorkModule } from '../../modules'

/**
 * Purdue's rule (docs/agents/work-search.md "What search keeps, and
 * Purdue"): a search over a Teams library reads no file. Every way this
 * process opens or lists a file is watched while a search runs over a
 * stand-in library of files kept in the cloud, as he types and for all
 * files, and none may be used. What search asks Files for is names and a
 * query: no verb that reads, fetches or opens.
 */

const opened = vi.hoisted(() => [] as string[])
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  const note =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      opened.push(String(args[0]))
      return fn(...args)
    }
  return { ...fs, openSync: note(fs.openSync), open: note(fs.open), readFileSync: note(fs.readFileSync), readFile: note(fs.readFile), createReadStream: note(fs.createReadStream), readdirSync: note(fs.readdirSync), readdir: note(fs.readdir), statSync: note(fs.statSync) }
})
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const note =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      opened.push(String(args[0]))
      return fn(...args)
    }
  return { ...fs, open: note(fs.open), readFile: note(fs.readFile), readdir: note(fs.readdir), stat: note(fs.stat) }
})

const { runSearch } = await import('../run')
const { everywhere, makeRig, window } = await import('../testkit')
const { fileSources } = await import('./files')

it('reads no file during a search over a Teams library, as he types and for all files', async () => {
  const rig = makeRig()
  const asked: string[] = []
  const cloud = (key: string, name: string) => ({
    key,
    ref: { at: 'microsoft', account: 'a', ref: { kind: 'path', path: `/Users/him/Library/CloudStorage/OneDrive-Dummy U/${name}` } },
    folder: null,
    name,
    kind: 'sheet',
    local: false,
    where: { place: 'teams:staff', name: 'Esports Staff', trail: ['General'] }
  })
  const teams: WorkModule = {
    id: 'files',
    ensure() {},
    async handle(req: ClientRequest) {
      asked.push(req.method)
      if (req.method === 'work.files.names') return handled({ entries: [cloud('t1', 'Staff payroll.xlsx')] })
      if (req.method === 'work.files.search') return handled({ entries: [cloud('t1', 'Staff payroll.xlsx'), cloud('t2', 'Payroll 2026.xlsx')] })
      return NOT_HANDLED
    }
  }
  const own = fileSources([teams])
  opened.length = 0
  const typed = await runSearch(rig.ctx, { modules: [], own, reach: everywhere, text: 'payroll', by: window })
  const all = await runSearch(rig.ctx, { modules: [], own, reach: everywhere, text: 'payroll', by: window, kind: 'file' })
  expect(opened).toEqual([])
  expect(typed.groups[0].hits[0]).toMatchObject({ title: 'Staff payroll.xlsx', detail: 'Esports Staff › General', cloud: true })
  expect(all.groups.flatMap((g) => g.hits).length).toBeGreaterThan(1)
  expect([...new Set(asked)].sort()).toEqual(['work.files.names', 'work.files.search'])
})
