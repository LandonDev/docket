import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from '../db'
import type { SessionRegistry } from '../sessions'

// Two parts of the context that throw while they are made: one a function member, one a group of members.
vi.mock('./formats/jobs', () => ({
  convertPart: () => {
    throw new Error('no toolchain dir')
  }
}))
vi.mock('./lifeos/ctx', () => ({
  lifeosPart: () => {
    throw new Error('the vault is locked')
  }
}))
const { startWork } = await import('./ctx')

let dir: string
let db: ReturnType<typeof openDb>
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-work-parts-'))
  db = openDb(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

it('a part of the context that fails to start never stops the host: its members answer its fault, and the rest are whole', () => {
  const said = vi.spyOn(console, 'error').mockImplementation(() => {})
  const work = startWork({ db, store: new Store(db), registry: { get: () => null } as unknown as SessionRegistry, environmentId: 'env_test', dataDir: dir, log: () => {} }, [])
  expect(said.mock.calls.map((c) => String(c[0])).sort()).toEqual([
    '[work] work: formats/jobs.ts did not start: no toolchain dir',
    '[work] work: lifeos/ctx.ts did not start: the vault is locked'
  ])
  const { ctx } = work
  expect(() => ctx.convert({ from: 'odt', to: 'docx', input: '/a.odt' })).toThrow('work: formats/jobs.ts did not start: no toolchain dir')
  expect(() => ctx.lifeos.connected()).toThrow('work: lifeos/ctx.ts did not start: the vault is locked')
  expect(() => ctx.lifeos.jwt('purdue')).toThrow('work: lifeos/ctx.ts did not start: the vault is locked')
  expect(() => ctx.links.forThread('s')).toThrow('work: lifeos/ctx.ts did not start: the vault is locked')
  // the parts that started are untouched, and the switch still answers
  expect(() => ctx.canvas.open('s', 'pdf', { at: 'thread' }, 'A')).toThrow('unknown thread: s')
  expect(ctx.enabled()).toBe(false)
  expect(work.settings.set({ enabled: true })).toEqual({ enabled: true })
  work.close()
})
