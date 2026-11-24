import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, unzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { FileVersionStore, fileDocName } from 'work-kit/collab-server'
import * as Y from 'yjs'
import { isAgentBranch, PrivateBranchStore } from './privateBranches'

/* Agent branches of a .tcdoc kept on this host, never in the file (docs/agents/work-docs.md "Agent suggestions stay private"). */

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'private-branches-'))
  dirs.push(dir)
  const file = { path: join(dir, 'Library', 'Plan.tcdoc') }
  const name = fileDocName(file.path)
  const inner = new FileVersionStore()
  const base = await inner.cut(name, { snapshot: Y.encodeSnapshot(Y.snapshot(new Y.Doc())), clients: {}, cause: 'import', epoch: 0 }, file)
  const store = new PrivateBranchStore(inner, join(dir, 'data', 'private-branches'))
  const zip = () => unzipSync(new Uint8Array(readFileSync(file.path)))
  const zipText = () => Object.values(zip()).map((v) => Buffer.from(v).toString('latin1')).join('\n')
  return { dir, file, name, inner, base, store, zip, zipText }
}

describe('PrivateBranchStore', () => {
  it("gives a branch a new revision at every update, two in one millisecond included, so a decision bound to one never takes the other", async () => {
    const r = await rig()
    const still = new PrivateBranchStore(r.inner, join(r.dir, 'data', 'private-branches'), () => 1_800_000_000_000)
    const id = await still.createBranch(r.name, { state: strToU8('one'), baseVersionId: r.base, authors: ['agent:env_box:t1'], label: 'Suggestions' }, r.file)
    const revision = async () => (await still.branches(r.name, r.file)).find((b) => b.id === id)!.editedAt
    const seen = [await revision()]
    for (const words of ['two', 'three']) {
      await still.setBranch(r.name, id, { state: strToU8(words) }, r.file)
      seen.push(await revision())
    }
    expect(new Set(seen).size).toBe(3)
  })

  it('names an agent\'s branch by its principal: a thread\'s or a LifeOS bot\'s, never a person\'s', () => {
    expect(isAgentBranch({ authors: ['agent:env_box:t1'] })).toBe(true)
    expect(isAgentBranch({ authors: ['lifeos:bot:k1'] })).toBe(true)
    for (const p of ['owner', 'external:Ada Reviewer', 'guest:L1', 'lifeos:desktop']) expect(isAgentBranch({ authors: [p] }), p).toBe(false)
  })

  it('keeps an agent\'s new branch under this host\'s data, 0700, and a person\'s in the file', async () => {
    const r = await rig()
    const agent = await r.store.createBranch(r.name, { state: strToU8('Zanzibar words'), baseVersionId: r.base, authors: ['agent:env_box:t1'], label: 'Suggestions' }, r.file)
    const person = await r.store.createBranch(r.name, { state: strToU8('Ada words'), baseVersionId: r.base, authors: ['external:Ada Reviewer'], label: 'Ada Reviewer' }, r.file)
    expect(r.zipText()).not.toContain('Zanzibar')
    expect(r.zip()[`branches/${person}.yjs`]).toBeDefined()
    expect(statSync(r.store.dirOf(r.file)).mode & 0o777).toBe(0o700)
    expect(statSync(join(r.store.dirOf(r.file), `${agent}.yjs`)).mode & 0o777).toBe(0o600)
    expect((await r.store.branches(r.name, r.file)).map((b) => b.id).sort()).toEqual([agent, person].sort())
    expect(Buffer.from(await r.store.branchState(r.name, agent, r.file)).toString()).toBe('Zanzibar words')
    await expect(r.store.createBranch(r.name, { state: strToU8('x'), baseVersionId: 'vnone', authors: ['agent:env_box:t1'], label: 'Suggestions' }, r.file)).rejects.toThrow(/not this doc's/)
  })

  it('moves an agent branch an older file still holds out of it at the first touch, losing nothing', async () => {
    const r = await rig()
    // As FileVersionStore alone kept it: inside the zip.
    const legacy = await r.inner.createBranch(r.name, { state: strToU8('Zanzibar words'), baseVersionId: r.base, authors: ['agent:env_box:t1'], label: 'Suggestions' }, r.file)
    const person = await r.inner.createBranch(r.name, { state: strToU8('Ada words'), baseVersionId: r.base, authors: ['external:Ada Reviewer'], label: 'Ada Reviewer' }, r.file)
    expect(r.zipText()).toContain('Zanzibar')
    const rows = await r.store.branches(r.name, r.file)
    expect(rows.map((b) => `${b.id} ${b.status}`).sort()).toEqual([`${legacy} pending`, `${person} pending`].sort())
    expect(r.zipText()).not.toContain('Zanzibar')
    expect(r.zipText()).not.toContain('agent:env_box:t1')
    expect(r.zip()[`branches/${person}.yjs`]).toBeDefined()
    expect(Buffer.from(await r.store.branchState(r.name, legacy, r.file)).toString()).toBe('Zanzibar words')
    // Versions stay where they were.
    expect((await r.store.list(r.name, r.file)).map((v) => v.id)).toEqual([r.base])
  })

  it('rewrites a pending branch in place, and removes it once decided', async () => {
    const r = await rig()
    const id = await r.store.createBranch(r.name, { state: strToU8('first'), baseVersionId: r.base, authors: ['agent:env_box:t1'], label: 'Suggestions' }, r.file)
    await r.store.setBranch(r.name, id, { state: strToU8('second') }, r.file)
    expect(Buffer.from(await r.store.branchState(r.name, id, r.file)).toString()).toBe('second')
    await r.store.setBranch(r.name, id, { status: 'merged' }, r.file)
    expect(existsSync(r.store.dirOf(r.file))).toBe(false)
    expect(await r.store.branches(r.name, r.file)).toEqual([])
    // A person's branch is decided in the file, as before.
    const person = await r.store.createBranch(r.name, { state: strToU8('Ada'), baseVersionId: r.base, authors: ['external:Ada Reviewer'], label: 'Ada' }, r.file)
    await r.store.setBranch(r.name, person, { status: 'dropped' }, r.file)
    expect((await r.store.branches(r.name, r.file)).map((b) => b.status)).toEqual(['dropped'])
  })
})
