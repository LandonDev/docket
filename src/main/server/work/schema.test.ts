import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkModule } from './modules'
import { ensureWorkTables } from './schema'

/**
 * Each ensure runs inside a savepoint the host owns: all of it lands or none
 * of it does, and whatever an ensure does, the host is never left inside a
 * transaction that its later writes would join and lose.
 */

let db: DatabaseSync
const tables = (): string[] => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((r) => r.name)
const pillar = (id: WorkModule['id'], ensure: WorkModule['ensure']): WorkModule => ({ id, ensure })
/** The host's own life after the ensures: a plain write and a transaction of its own both hold. */
const hostStillWrites = (): void => {
  expect(db.isTransaction).toBe(false)
  db.exec(`CREATE TABLE IF NOT EXISTS host (id TEXT PRIMARY KEY)`)
  db.prepare(`INSERT INTO host (id) VALUES (?)`).run(`plain-${Math.random()}`)
  db.exec('BEGIN')
  db.prepare(`INSERT INTO host (id) VALUES (?)`).run(`in-a-transaction-${Math.random()}`)
  db.exec('COMMIT')
  expect(db.isTransaction).toBe(false)
}
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  db.close()
  vi.restoreAllMocks()
})

describe('an ensure', () => {
  it('that succeeds lands whole, and the host is in no transaction after it', () => {
    const failed = ensureWorkTables(db, [pillar('mail', (d) => d.exec(`CREATE TABLE work_mail_a (id TEXT); CREATE TABLE work_mail_b (id TEXT)`))])
    expect(failed.size).toBe(0)
    expect(tables()).toEqual(['work_mail_a', 'work_mail_b'])
    hostStillWrites()
  })

  it('that fails partway leaves nothing of itself behind: no half-made table, no open transaction', () => {
    const failed = ensureWorkTables(db, [
      pillar('mail', (d) => {
        d.exec(`CREATE TABLE work_mail_a (id TEXT)`)
        d.prepare(`INSERT INTO work_mail_a (id) VALUES ('x')`).run()
        d.exec(`CREATE TABLE`)
      }),
      pillar('tasks', (d) => d.exec(`CREATE TABLE work_tasks_a (id TEXT)`))
    ])
    expect([...failed.keys()]).toEqual(['mail'])
    expect(failed.get('mail')).toMatch(/^work: mail could not make its tables: /)
    // the pillar after it is untouched by the fault
    expect(tables()).toEqual(['work_tasks_a'])
    hostStillWrites()
  })

  it('that runs BEGIN is refused by the database and counted a fault; the host is left in no transaction and loses no later write', () => {
    const failed = ensureWorkTables(db, [
      pillar('mail', (d) => {
        d.exec('BEGIN')
        d.exec(`CREATE TABLE work_mail_a (id TEXT)`)
        d.exec('CREATE TABLE')
      })
    ])
    expect(failed.get('mail')).toContain('cannot start a transaction within a transaction')
    expect(tables()).toEqual([])
    hostStillWrites()
    // what the host wrote afterwards is there to stay: nothing was waiting to roll it back
    expect((db.prepare(`SELECT COUNT(*) AS n FROM host`).get() as { n: number }).n).toBe(2)
  })

  it('that commits or rolls back the transaction the host ran it in is counted a fault, and nothing is left open', () => {
    for (const end of ['COMMIT', 'ROLLBACK']) {
      const failed = ensureWorkTables(db, [
        pillar('mail', (d) => {
          d.exec(`CREATE TABLE IF NOT EXISTS work_mail_c (id TEXT)`)
          d.exec(end)
        })
      ])
      expect(failed.get('mail'), end).toBe('work: mail could not make its tables: its ensure ended the transaction the host ran it in (an ensure never runs COMMIT or ROLLBACK)')
      hostStillWrites()
    }
  })

  it('that ends the host\'s transaction and then opens its own is rolled back, so no later write joins it', () => {
    const failed = ensureWorkTables(db, [
      pillar('mail', (d) => {
        d.exec('COMMIT')
        d.exec('BEGIN')
        d.exec(`CREATE TABLE work_mail_d (id TEXT)`)
      })
    ])
    expect(failed.has('mail')).toBe(true)
    expect(tables()).toEqual([])
    hostStillWrites()
  })

  it('may nest a savepoint of its own for a step that must be atomic', () => {
    const failed = ensureWorkTables(db, [
      pillar('mail', (d) => {
        d.exec(`CREATE TABLE work_mail_e (id TEXT)`)
        d.exec('SAVEPOINT step')
        d.exec(`CREATE TABLE work_mail_f (id TEXT)`)
        d.exec('ROLLBACK TO step; RELEASE step')
      })
    ])
    expect(failed.size).toBe(0)
    expect(tables()).toEqual(['work_mail_e'])
    hostStillWrites()
  })

  it('run while the host is inside a transaction of its own leaves that transaction the host\'s to end', () => {
    db.exec('BEGIN')
    db.exec(`CREATE TABLE host_before (id TEXT)`)
    const failed = ensureWorkTables(db, [pillar('mail', (d) => void d.exec('CREATE TABLE')), pillar('tasks', (d) => d.exec(`CREATE TABLE work_tasks_a (id TEXT)`))])
    expect([...failed.keys()]).toEqual(['mail'])
    expect(db.isTransaction).toBe(true)
    db.exec('COMMIT')
    expect(tables()).toEqual(['host_before', 'work_tasks_a'])
  })
})
