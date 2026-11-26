import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readBootMirror } from './bootMirror'
import { openDb, Store } from './server/db'
import { LaunchMirror } from './server/launchMirror'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-boot-mirror-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const summary = (id: string, updatedAt: number) => ({ id, archived: false, updatedAt, title: id })

async function seeded(o: { workOn?: boolean } = {}): Promise<string> {
  const path = join(dir, 'docket.db')
  const db = openDb(path)
  const store = new Store(db)
  const mirror = new LaunchMirror(db)
  await mirror.write({ environmentId: 'local', full: true, upserts: [summary('a', 1), summary('b', 2)], removed: [], workspaces: [], projects: [], cursor: { seq: 7, generation: 'g1' } })
  await mirror.write({ environmentId: 'env_gone', full: true, upserts: [summary('c', 3)], removed: [], workspaces: [], projects: [], cursor: null })
  if (o.workOn) store.setSetting('work', JSON.stringify({ enabled: true }))
  db.close()
  return path
}

describe('the boot read of the launch mirror', () => {
  it('answers the mirror of every saved host through a read-only connection, newest first, before the server opens the file', async () => {
    const path = await seeded()
    const opened: { readOnly?: boolean }[] = []
    const read = readBootMirror(path, (p) => {
      const options = { readOnly: true }
      opened.push(options)
      return new DatabaseSync(p, options)
    })
    expect(opened).toEqual([{ readOnly: true }])
    expect(read.workOn).toBe(false)
    expect(read.snapshot?.environments).toEqual([])
    // a host no longer saved is left out of the answer, and left in the file for the server to forget
    expect(read.snapshot?.hosts.map((h) => [h.environmentId, h.sessions.map((s) => s.id), h.cursor])).toEqual([['local', ['b', 'a'], { seq: 7, generation: 'g1' }]])
    const db = openDb(path)
    expect(new LaunchMirror(db).hostIds().sort()).toEqual(['env_gone', 'local'])
    db.close()
  })

  it('says whether Work is on for this host, so its code loads at once only then', async () => {
    expect(readBootMirror(await seeded({ workOn: true })).workOn).toBe(true)
  })

  it('a first launch has nothing to read: no snapshot, nothing made', () => {
    const path = join(dir, 'docket.db')
    expect(readBootMirror(path)).toEqual({ snapshot: null, workOn: false })
    expect(() => statSync(path)).toThrow()
  })

  it('a database with no mirror tables yet answers no snapshot, and the window waits for the server', () => {
    const path = join(dir, 'docket.db')
    const db = openDb(path)
    db.close()
    expect(readBootMirror(path).snapshot).toBeNull()
  })
})
