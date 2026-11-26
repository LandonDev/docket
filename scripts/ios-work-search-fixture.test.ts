import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SearchAnswer, SearchHit } from '../src/shared/work/search'
import { activeOf, begin, busy, emptyModel, failed, landInstant, landSource, paramsFor, placesMix, point, rowsOf, step, type Row, type SearchHost, type SearchModel } from '../src/renderer/src/work/search/model'

/* The phone's Work search (ios/TempCodeClient/Sources/TempCodeClient/Work/Search/WorkSearchModel.swift) is a port of
 * the window's model (src/renderer/src/work/search/model.ts): the generations, the two speeds, what is out, the rows in
 * their order, the highlight. This test runs the window's own model over scripted cases and writes, after each step,
 * what it asks and the rows it draws to Fixtures/search/model.json; WorkSearchModelTests replays the same steps on the
 * phone's port and holds it to the file. UPDATE_FIXTURES=1 writes the file. */

const ROOT = resolve(__dirname, '..')
const FIXTURE = join(ROOT, 'ios/TempCodeClient/Tests/TempCodeClientTests/Fixtures/search/model.json')

type Host = SearchHost & { workspaceId?: string }
const BOX: Host = { id: 'box', name: 'The box', home: true }
const MAC: Host = { id: 'mac', name: 'MacBook', home: false }

let n = 0
const hit = (kind: string, title: string, over: Partial<SearchHit> = {}): SearchHit => ({
  key: `${kind}:${title.toLowerCase().replace(/\s+/g, '-')}`,
  kind,
  title,
  workspaceId: 'w-cosmic',
  open: { to: 'view', view: kind === 'person' ? 'people' : kind, with: { [kind]: `id-${++n}` } },
  ...over
})
const group = (kind: string, label: string, hits: SearchHit[], more = false, source = `lifeos.${kind}`) => ({ source, kind, label, hits, more })
const answer = (over: Partial<SearchAnswer> = {}): SearchAnswer => ({ groups: [], pending: [], quiet: [], ...over })

type Step =
  | { op: 'begin'; text: string; kind?: string | null; scope?: string | null; within?: string[] | null; hosts: Host[]; offline?: string[]; unsearched?: string | null }
  | { op: 'instant'; host: string; answer: SearchAnswer; gen?: number }
  | { op: 'source'; host: string; source: string; answer: SearchAnswer; gen?: number }
  | { op: 'failed'; host: string; source?: { source: string; kind: string }; gen?: number }
  | { op: 'step'; by: 1 | -1 }
  | { op: 'point'; id: string }

interface Case {
  name: string
  /** rowsOf's `scoped` */
  scoped?: boolean
  /** a workspace's job, as a Recent row compares two */
  jobs?: Record<string, string>
  steps: Step[]
}

const people = [hit('person', 'Dana Budget'), hit('person', 'Omar Budgeson', { detail: 'omar@cosmic.gg' })]
const thread = hit('thread', 'Budget review', { key: 'thread:s1', open: { to: 'thread', sessionId: 's1', seq: 42 }, snippet: 'the budget is due' })
const mails = Array.from({ length: 5 }, (_, i) => hit('mail', `Budget ${i + 1}`, { detail: 'Dana Lee', at: 1_764_000_000_000 + i }))
const file = hit('file', 'Budget.xlsx', {
  key: 'file:abc',
  open: { to: 'file', ref: { at: 'place', id: 'folder', path: 'Budgets/Budget.xlsx' }, name: 'Budget.xlsx' },
  chip: { kind: 'file', label: 'Budget.xlsx', ref: { at: 'file', host: 'box', path: '/w/Budget.xlsx' } },
  cloud: true
})
const held = hit('held', 'Send the budget', { key: 'item:h1', open: { to: 'chip', chip: { kind: 'held', label: 'Send the budget', ref: { at: 'item', id: 'h1' } } } })
const mixed = hit('task', 'Budget sign-off', { open: { to: 'view', view: 'tasks', with: { task: 't9', flag: true, n: 3, none: null, doc: { id: 'd1', title: 'Doc' } } } })

const CASES: Case[] = [
  {
    name: 'two hosts, two speeds',
    steps: [
      { op: 'begin', text: '  budget ', hosts: [BOX, MAC] },
      {
        op: 'instant',
        host: 'box',
        answer: answer({ groups: [group('thread', 'Threads', [thread], false, 'search.thread'), group('person', 'People', people)], pending: [{ source: 'lifeos.mail', kind: 'mail' }, { source: 'lifeos.task', kind: 'task' }], searched: 2 })
      },
      { op: 'instant', host: 'mac', answer: answer({ groups: [group('thread', 'Threads', [thread, hit('thread', 'Budget on the Mac', { key: 'thread:s2', workspaceId: 'w-mac' })], false, 'search.thread'), group('file', 'Files', [file], false, 'files.file'), group('held', 'Outbox', [held], false, 'mentions.held')], searched: 3 }) },
      { op: 'source', host: 'box', source: 'lifeos.mail', answer: answer({ groups: [group('mail', 'Mail', mails, true)], searched: 1 }) },
      { op: 'failed', host: 'box', source: { source: 'lifeos.task', kind: 'task' } }
    ]
  },
  {
    name: 'new words keep the rows standing',
    steps: [
      { op: 'begin', text: 'bud', hosts: [BOX] },
      { op: 'instant', host: 'box', answer: answer({ groups: [group('person', 'People', people)], searched: 1 }) },
      { op: 'begin', text: 'budgeso', hosts: [BOX] },
      // the older generation's answer is dropped
      { op: 'instant', host: 'box', gen: 1, answer: answer({ groups: [group('person', 'People', [hit('person', 'Stale')])] }) },
      { op: 'instant', host: 'box', answer: answer({ groups: [group('person', 'People', [hit('person', 'Zed Budgeson'), people[1]!])], searched: 1 }) },
      { op: 'begin', text: 'budgeso', hosts: [BOX] },
      { op: 'instant', host: 'box', answer: answer({ groups: [group('person', 'People', [hit('person', 'Amy Budgeson'), people[1]!, hit('person', 'Zed Budgeson')])], searched: 1 }) }
    ]
  },
  {
    name: 'nothing found, scoped',
    scoped: true,
    steps: [
      { op: 'begin', text: 'zz', hosts: [{ ...BOX, workspaceId: 'w-cosmic' }], scope: 'cosmic', within: ['w-cosmic'] },
      { op: 'instant', host: 'box', answer: answer({ searched: 1 }) }
    ]
  },
  {
    name: 'nothing searched says only why',
    steps: [
      { op: 'begin', text: 'zz', hosts: [BOX] },
      { op: 'instant', host: 'box', answer: answer({ searched: 0, quiet: [{ cause: 'lifeos', line: 'Not signed in to LifeOS.' }] }) }
    ]
  },
  {
    name: 'one letter asks no network',
    steps: [
      { op: 'begin', text: 'b', hosts: [BOX] },
      { op: 'instant', host: 'box', answer: answer({ groups: [group('person', 'People', people)], pending: [{ source: 'lifeos.mail', kind: 'mail' }], searched: 1 }) }
    ]
  },
  {
    name: 'recent across hosts',
    jobs: { 'w-cosmic': 'cosmic', 'w-cosmic-mac': 'cosmic' },
    steps: [
      { op: 'begin', text: '', hosts: [BOX, MAC] },
      {
        op: 'instant',
        host: 'box',
        answer: answer({
          groups: [group('recent', 'Recent', [hit('mail', 'Old mail', { openedAt: 100 }), hit('person', 'Dana Lee', { openedAt: 300 }), hit('message', 'Standup', { key: 'm1', openedAt: 250 }), hit('message', 'Standup', { key: 'm2', openedAt: 260 })], false, 'search.recent')]
        })
      },
      {
        op: 'instant',
        host: 'mac',
        answer: answer({ groups: [group('recent', 'Recent', [hit('person', 'Dana Lee', { key: 'person:dana-mac', workspaceId: 'w-cosmic-mac', openedAt: 400 }), ...Array.from({ length: 8 }, (_, i) => hit('task', `Task ${i}`, { openedAt: 10 + i }))], false, 'search.recent')] })
      }
    ]
  },
  {
    name: 'quiet lines',
    steps: [
      { op: 'begin', text: 'budget', hosts: [BOX, MAC], offline: ['Purdue laptop is offline'], unsearched: 'Folders on Purdue laptop were not searched.' },
      { op: 'instant', host: 'box', answer: answer({ quiet: [{ cause: 'lifeos', line: 'LifeOS is still connecting.' }, { cause: 'files', line: 'A library is asleep.' }], searched: 1 }) },
      { op: 'instant', host: 'mac', answer: answer({ quiet: [{ cause: 'files', line: 'A library is asleep.' }], searched: 1 }) },
      { op: 'begin', text: 'budget2', hosts: [BOX, MAC] },
      { op: 'failed', host: 'mac' },
      { op: 'instant', host: 'box', answer: answer({ quiet: [{ cause: 'lifeos', line: 'LifeOS refused this host\'s sign-in.' }], searched: 0 }) }
    ]
  },
  {
    name: 'the highlight',
    steps: [
      { op: 'begin', text: 'budget', hosts: [BOX] },
      { op: 'instant', host: 'box', answer: answer({ groups: [group('person', 'People', people), group('thread', 'Threads', [thread], false, 'search.thread')], pending: [{ source: 'lifeos.mail', kind: 'mail' }], searched: 2 }) },
      { op: 'step', by: 1 },
      { op: 'step', by: 1 },
      { op: 'step', by: -1 },
      { op: 'point', id: 'hit:thread:s1' },
      { op: 'source', host: 'box', source: 'lifeos.mail', answer: answer({ groups: [group('mail', 'Mail', mails.slice(0, 2))], searched: 1 }) },
      { op: 'step', by: 1 },
      { op: 'step', by: 1 },
      { op: 'step', by: 1 },
      { op: 'instant', host: 'box', answer: answer({ groups: [group('person', 'People', people)], searched: 1 }) }
    ]
  },
  {
    name: 'a chosen row the answer took away',
    steps: [
      { op: 'begin', text: 'budget', hosts: [BOX] },
      { op: 'instant', host: 'box', answer: answer({ groups: [group('person', 'People', people)], searched: 1 }) },
      { op: 'point', id: `hit:${people[1]!.key}` },
      { op: 'begin', text: 'budget', hosts: [BOX] },
      { op: 'instant', host: 'box', answer: answer({ groups: [group('person', 'People', [people[0]!])], searched: 1 }) },
      { op: 'step', by: 1 }
    ]
  },
  {
    name: 'one kind alone, and back out',
    steps: [
      { op: 'begin', text: 'budget', hosts: [BOX, MAC] },
      { op: 'instant', host: 'box', answer: answer({ groups: [group('mail', 'Mail', mails, true)], searched: 1 }) },
      { op: 'begin', text: 'budget', kind: 'mail', hosts: [BOX, MAC] },
      { op: 'instant', host: 'box', answer: answer({ groups: [group('mail', 'Mail', [...mails, ...Array.from({ length: 30 }, (_, i) => hit('mail', `More ${i}`))])], searched: 1 }) },
      { op: 'begin', text: 'budget', kind: null, hosts: [BOX, MAC] }
    ]
  },
  {
    name: 'narrowed to a job',
    steps: [
      { op: 'begin', text: 'budget', hosts: [BOX, MAC] },
      { op: 'instant', host: 'box', answer: answer({ groups: [group('person', 'People', [people[0]!, hit('person', 'Hypixel Budget', { workspaceId: 'w-hypixel' }), hit('person', 'Chats Budget', { workspaceId: null })])], searched: 1 }) },
      { op: 'begin', text: 'budget', scope: 'cosmic', within: ['w-cosmic'], hosts: [{ ...BOX, workspaceId: 'w-cosmic' }] },
      { op: 'begin', text: 'budget', scope: null, hosts: [BOX, MAC] }
    ]
  },
  {
    name: 'deeper and mixed kinds',
    steps: [
      { op: 'begin', text: 'bu', hosts: [BOX] },
      { op: 'instant', host: 'box', answer: answer({ groups: [group('receipt', 'Receipts', [hit('receipt', 'Budget lunch')], false, 'money.receipt'), group('task', 'Tasks', [mixed]), group('card', 'Cards', [hit('card', 'Budget card')], false, 'mentions.card')], deeper: ['file'], searched: 2 }) },
      { op: 'begin', text: 'bud', hosts: [BOX] },
      { op: 'begin', text: 'bud', hosts: [MAC] }
    ]
  }
]

function rowJSON(row: Row): unknown {
  if (row.type === 'hit') return { type: 'hit', id: row.id, host: row.host, key: row.hit.key }
  return row
}

function compute(): unknown {
  return {
    cases: CASES.map((c) => {
      let model: SearchModel = emptyModel()
      const jobOf = c.jobs ? (id: string | null): string => (id ? (c.jobs![id] ?? id) : '') : undefined
      const steps = c.steps.map((s) => {
        let params: unknown[] | undefined
        let ask: unknown[] | undefined
        switch (s.op) {
          case 'begin':
            model = begin(model, { text: s.text, kind: s.kind ?? null, scope: s.scope ?? null, within: s.within ?? null, hosts: s.hosts, offline: s.offline, unsearched: s.unsearched ?? null })
            params = s.hosts.map((h) => paramsFor(model, h, { workspaceId: h.workspaceId }))
            break
          case 'instant': {
            const landed = landInstant(model, s.gen ?? model.gen, s.host, s.answer)
            model = landed.model
            ask = landed.ask
            const host = model.hosts.find((h) => h.id === s.host) as Host | undefined
            params = host ? landed.ask.map((a) => paramsFor(model, host, { workspaceId: host.workspaceId, sources: [a.source] })) : []
            break
          }
          case 'source':
            model = landSource(model, s.gen ?? model.gen, s.host, s.source, s.answer)
            break
          case 'failed':
            model = failed(model, s.gen ?? model.gen, s.host, s.source ?? null)
            break
          case 'step':
            model = step(model, rowsOf(model, { scoped: c.scoped, jobOf }), s.by)
            break
          case 'point':
            model = point(model, s.id)
            break
        }
        const rows = rowsOf(model, { scoped: c.scoped, jobOf })
        return {
          ...s,
          expect: {
            rows: rows.map(rowJSON),
            active: activeOf(model, rows),
            busy: busy(model),
            gen: model.gen,
            mix: placesMix(1, rows),
            ...(params ? { params } : {}),
            ...(ask ? { ask } : {})
          }
        }
      })
      return { name: c.name, ...(c.scoped ? { scoped: true } : {}), ...(c.jobs ? { jobs: c.jobs } : {}), steps }
    })
  }
}

describe('Work search fixture', () => {
  it("holds the phone's port to the window's model", () => {
    const computed = `${JSON.stringify(compute(), null, 2)}\n`
    if (process.env.UPDATE_FIXTURES === '1') {
      mkdirSync(dirname(FIXTURE), { recursive: true })
      writeFileSync(FIXTURE, computed)
    }
    expect(readFileSync(FIXTURE, 'utf8'), 'run with UPDATE_FIXTURES=1, then carry the change to WorkSearchModel.swift').toBe(computed)
  })
})
