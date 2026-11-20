import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import type { WorkScope } from '@shared/work'
import type { ToolCtx, WorkCtx } from '../modules'
import { ensureGuestTables, GUEST_LINKS_TABLE } from '../guests/store'
import { lifeos } from '.'
import { linksNamed, pageText, personPageTool, resolvePerson } from './people'

/*
 * person_page on a LifeOS that stands in: who it finds, the sector it reads
 * (the thread's own, never another), the guest links it asks LifeOS about,
 * and the page it answers.
 */

const NOW = Date.now()
const people = [
  { _id: 'p_maya', name: 'Maya Chen', emails: ['maya@school.edu'], lastAt: NOW - 1000 },
  { _id: 'p_tom', name: 'Tom Beck', emails: ['tom@school.edu'] },
  { _id: 'p_tom2', name: 'Tom Rivera', emails: [] }
]
const page = {
  person: { _id: 'p_maya', name: 'Maya Chen', notes: 'Runs the front desk.', emails: ['maya@school.edu'], phones: ['5551110000'] },
  lastAt: Date.UTC(2026, 10, 19, 15, 0),
  mail: [{ _id: 'mt1', subject: 'Bracket for Friday', snippet: 'Here it is', lastMessageAt: Date.UTC(2026, 10, 19, 15, 0), unread: true }],
  coming: [{ _id: 'ev1', title: 'Tryouts', startsAt: Date.UTC(2026, 10, 21, 18, 0), location: 'Arena' }],
  recent: [],
  tasks: [
    { _id: 't1', title: 'Send the bracket', status: 'todo', relation: 'asked' as const },
    { _id: 't2', title: 'Seat list', status: 'todo', dueAt: Date.UTC(2026, 10, 24, 14, 0), relation: 'waiting' as const }
  ],
  shared: [{ table: 'docs' as const, id: 'd1', title: 'Run of show' }]
}

let db: DatabaseSync
let asked: { fn: string; args: Record<string, unknown> }[]
let ctx: WorkCtx

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  ensureGuestTables(db)
  asked = []
  ctx = {
    db,
    lifeos: {
      owner: () => ({
        query: async (fn: string, args: Record<string, unknown>) => {
          asked.push({ fn, args })
          if (fn === 'people:directory') return args.sector === 'purdue' ? people : []
          if (fn === 'people:page') return args.id === 'p_maya' ? page : null
          return null
        }
      })
    }
  } as unknown as WorkCtx
})

const link = (id: string, name: string, source: object, over: { expires?: number; revoked?: number | null; created?: number } = {}) =>
  db
    .prepare(`INSERT INTO ${GUEST_LINKS_TABLE} (id, secret_hash, name, source, title, role, created_at, expires_at, revoked_at, by_session) VALUES (?, 'h', ?, ?, 't', 'comment', ?, ?, ?, NULL)`)
    .run(id, name, JSON.stringify(source), over.created ?? NOW - 10, over.expires ?? NOW + 86_400_000, over.revoked ?? null)

const scope = (over: Partial<WorkScope> = {}): WorkScope => ({ sessionId: 't1', workspaceId: 'ws', sector: 'purdue', host: 'env_box', away: false, routineRunId: null, shared: () => false, ...over })
const run = async (args: unknown, s: WorkScope = scope()) => {
  const parsed = personPageTool.input.safeParse(args)
  if (!parsed.success) throw new Error(parsed.error.message)
  const answer = await personPageTool.run(parsed.data, { ...ctx, sessionId: 't1', scope: s, signal: new AbortController().signal } as ToolCtx)
  return { text: (answer.content[0] as { text: string }).text, isError: answer.isError === true }
}

describe('resolvePerson', () => {
  it('finds by id, by address in any case, by whole name, and by every word asked', () => {
    expect(resolvePerson(people, 'p_tom')).toEqual({ person: people[1] })
    expect(resolvePerson(people, 'MAYA@school.edu')).toEqual({ person: people[0] })
    expect(resolvePerson(people, 'maya  chen')).toEqual({ person: people[0] })
    expect(resolvePerson(people, 'chen')).toEqual({ person: people[0] })
  })
  it('names everyone an ask fits more than one of, and says none for an unknown address', () => {
    expect(resolvePerson(people, 'Tom')).toEqual({ several: [people[1], people[2]] })
    expect(resolvePerson(people, 'nobody@school.edu')).toEqual({ none: true })
  })
})

describe('linksNamed', () => {
  it('keeps live links named for them, folded for case and accents, newest first, one an item', () => {
    const held = [
      { name: 'maya chen', table: 'docs' as const, id: 'd1', role: 'view', expiresAt: NOW + 1, createdAt: 1 },
      { name: 'Maya  Chen', table: 'docs' as const, id: 'd1', role: 'edit', expiresAt: NOW + 1, createdAt: 2 },
      { name: 'Máya Chen', table: 'sheets' as const, id: 's1', role: 'view', expiresAt: NOW + 1, createdAt: 3 },
      { name: 'Maya Chen', table: 'docs' as const, id: 'd_old', role: 'view', expiresAt: NOW - 1, createdAt: 4 },
      { name: 'Tom Beck', table: 'docs' as const, id: 'd2', role: 'view', expiresAt: NOW + 1, createdAt: 5 }
    ]
    expect(linksNamed(held, 'Maya Chen', NOW).map((l) => [l.id, l.role])).toEqual([
      ['s1', 'view'],
      ['d1', 'edit']
    ])
  })
})

describe('person_page', () => {
  it("answers the page in the thread's own sector, asking LifeOS about the links named for them", async () => {
    link('g1', 'Maya Chen', { at: 'lifeos', table: 'docs', id: 'd1' })
    link('g2', 'Maya Chen', { at: 'lifeos', table: 'sheets', id: 's9' }, { revoked: NOW - 5 })
    link('g3', 'Tom Beck', { at: 'lifeos', table: 'docs', id: 'd2' })
    const { text, isError } = await run({ person: 'Maya' })
    expect(isError).toBe(false)
    expect(asked).toEqual([
      { fn: 'people:directory', args: { sector: 'purdue' } },
      { fn: 'people:page', args: { id: 'p_maya', sector: 'purdue', shared: [{ table: 'docs', id: 'd1' }] } }
    ])
    expect(text).toContain('# Maya Chen (person p_maya, purdue)')
    expect(text).toContain('- Bracket for Friday, 2026-11-19 15:00Z, unread (mail thread mt1)')
    expect(text).toContain('## Asked for by them\n- Send the bracket (task t1, todo)')
    expect(text).toContain('## Waiting on them\n- Seat list, due 2026-11-24 14:00Z (task t2, todo)')
    expect(text).toContain('- Run of show (document d1), can comment until')
  })

  it('never reads another sector than its own, and a Work Chat must name one', async () => {
    expect(await run({ person: 'Maya', sector: 'cosmic' })).toEqual({ text: 'This thread reads only the purdue sector.', isError: true })
    expect(await run({ person: 'Maya' }, scope({ workspaceId: null, sector: null }))).toEqual({ text: 'Name the sector: a Work Chat reads every one.', isError: true })
    expect(await run({ person: 'Maya' }, scope({ sector: null }))).toEqual({ text: 'This workspace is linked to no LifeOS sector.', isError: true })
    expect(asked).toEqual([])
    expect((await run({ person: 'Maya', sector: 'purdue' }, scope({ workspaceId: null, sector: null }))).isError).toBe(false)
  })

  it('says who it could not tell apart, and who is not in the sector', async () => {
    expect((await run({ person: 'Tom' })).text).toBe("Several of purdue's people match Tom: Tom Beck (p_tom), Tom Rivera (p_tom2). Ask again by id.")
    expect(await run({ person: 'Pat' })).toEqual({ text: "No one in purdue's people is Pat.", isError: true })
  })

  it('is listed to a Work thread as read-only, by the lifeos pillar', () => {
    const tools = lifeos.tools!(scope())
    expect(tools.map((t) => [t.name, t.readOnly])).toEqual([['person_page', true]])
  })

  it('says when nothing is live with them', () => {
    const quiet = { ...page, mail: [], coming: [], tasks: [], shared: [], person: { ...page.person, notes: '', phones: [] }, lastAt: undefined }
    expect(pageText(quiet, [], 'purdue')).toBe('# Maya Chen (person p_maya, purdue)\nAddresses: maya@school.edu\n\nNothing live with them in purdue.')
  })
})
