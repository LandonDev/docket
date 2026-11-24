import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { fromOurQuestion } from '@shared/work/msforms'
import { ensureFormsTables, FormsStore } from '../../forms/store'
import type { Caller } from '../../modules'
import { paragraphsOfMarkdown, questionsOfDocument } from './document'
import { MakerFromSchema, NO_QUESTIONS, NOT_YOUR_JOB, questionsFrom } from './index'
import { CHOICE_MOST, CHOICE_ROWS, questionsOfSheet, rowsOfCells } from './sheet'
import { startSurvey, surveyMessage, surveyTitle } from './survey'

/** The makers (docs/agents/work-msforms.md "The makers"): the document grammar, the header row, our form's types, and the survey thread. */

const doc = (md: string) => questionsOfDocument(paragraphsOfMarkdown(md))

describe('the document grammar', () => {
  it('makes each numbered paragraph a question and the list under it its options', () => {
    const form = doc(['# Tryouts sign-up', 'Tell us when you can come.', '', '1. Your name', '2. Which night?', '   - Monday', '   - Tuesday', '   - Wednesday', '3. Anything else?'].join('\n'))
    expect(form).toEqual({
      title: 'Tryouts sign-up',
      description: 'Tell us when you can come.',
      questions: [
        { title: 'Your name', type: 'text', required: false },
        { title: 'Which night?', type: 'choice', options: ['Monday', 'Tuesday', 'Wednesday'], required: false },
        { title: 'Anything else?', type: 'text', required: false }
      ]
    })
  })

  it('takes a heading as a question, and a deeper numbered list as options', () => {
    expect(doc(['## Which game?', '1. Valorant', '2. Rocket League'].join('\n')).questions).toEqual([
      { title: 'Which game?', type: 'text', required: false },
      { title: 'Valorant', type: 'text', required: false },
      { title: 'Rocket League', type: 'text', required: false }
    ])
    expect(doc(['1. Which game?', '   1. Valorant', '   2. Rocket League'].join('\n')).questions).toEqual([{ title: 'Which game?', type: 'choice', options: ['Valorant', 'Rocket League'], required: false }])
    // Word's numbered list as the reader writes it, with emphasis and escapes
    expect(doc('1\\. **Team** name').questions).toEqual([])
    expect(doc('1. **Team** name (required)').questions).toEqual([{ title: 'Team name', type: 'text', required: true }])
  })

  it('reads Required from "(required)" or a trailing star, and drops the mark', () => {
    expect(doc(['1. Email (required)', '2. Phone *', '3. Notes (Required) about you'].join('\n')).questions).toEqual([
      { title: 'Email', type: 'text', required: true },
      { title: 'Phone', type: 'text', required: true },
      { title: 'Notes about you', type: 'text', required: true }
    ])
  })

  it('reads the three kinds: (date), (rating) and (long)', () => {
    expect(doc(['1. When can you start? (date)', '2. How was it? (rating) *', '3. How was it, out of ten? (rating 10)', '4. Tell us more (long)', '   - ignored'].join('\n')).questions).toEqual([
      { title: 'When can you start?', type: 'date', required: false },
      { title: 'How was it?', type: 'rating', scale: 5, required: true },
      { title: 'How was it, out of ten?', type: 'rating', scale: 10, required: false },
      { title: 'Tell us more', type: 'text', long: true, required: false }
    ])
  })

  it('leaves plain words out, keeps options once each, and finds nothing in a page of prose', () => {
    expect(doc(['1. Shirt size', '- S', '- M', '- M', '- [ ] L', 'A note in between.', '2. Name'].join('\n')).questions).toEqual([
      { title: 'Shirt size', type: 'choice', options: ['S', 'M', 'L'], required: false },
      { title: 'Name', type: 'text', required: false }
    ])
    expect(doc('Just a paragraph.\n\nAnother one.')).toEqual({ description: 'Just a paragraph.\nAnother one.', questions: [] })
  })
})

describe("a sheet's header row", () => {
  const rows = (n: number, values: (i: number) => string[]) => [['Name', 'Team', 'Shirt', 'Notes'], ...Array.from({ length: n }, (_, i) => values(i))]

  it(`makes a column of at most ${CHOICE_MOST} distinct values over at least ${CHOICE_ROWS} rows a Choice, in the order they first appear`, () => {
    const got = questionsOfSheet(rows(6, (i) => [`Player ${i}`, ['Blue', 'Gold'][i % 2]!, ['M', 'L', 'S'][i % 3]!, i === 0 ? 'late' : '']))
    expect(got).toEqual([
      { title: 'Name', type: 'text', required: false },
      { title: 'Team', type: 'choice', options: ['Blue', 'Gold'], required: false },
      { title: 'Shirt', type: 'choice', options: ['M', 'L', 'S'], required: false },
      { title: 'Notes', type: 'text', required: false }
    ])
  })

  it('keeps Text under five filled rows, past eight values, with one value alone, or with every value different', () => {
    expect(questionsOfSheet(rows(4, (i) => ['x', ['Blue', 'Gold'][i % 2]!, 'M', '']))[1]).toMatchObject({ type: 'text' })
    expect(questionsOfSheet(rows(9, (i) => ['x', `Team ${i}`, 'M', '']))[1]).toMatchObject({ type: 'text' })
    expect(questionsOfSheet(rows(6, () => ['x', 'Blue', 'M', '']))[1]).toMatchObject({ type: 'text' })
    expect(questionsOfSheet(rows(6, (i) => ['x', `Team ${i}`, 'M', '']))[1]).toMatchObject({ type: 'text' })
    expect(questionsOfSheet([['A', '', 'C']])).toEqual([{ title: 'A', type: 'text', required: false }, { title: 'C', type: 'text', required: false }])
    // another header row
    expect(questionsOfSheet([['Roster'], ['Name', 'Year']], 1).map((q) => q.title)).toEqual(['Name', 'Year'])
  })

  it("places the sheet reader's cells by their address, an empty cell keeping its column", () => {
    expect(rowsOfCells([[{ at: 'A1', v: 'Name' }, { at: 'C1', v: 'Year' }], [{ at: "'Q1'!A2", v: 'Dana' }, { at: 'C2', v: 2026 }]])).toEqual([
      ['Name', '', 'Year'],
      ['Dana', '', '2026']
    ])
  })
})

describe("our form's types", () => {
  it('map short, long, choice, dropdown and section to Forms', () => {
    expect(fromOurQuestion({ label: 'Name', type: 'short', required: true })).toEqual({ title: 'Name', type: 'text', required: true })
    expect(fromOurQuestion({ label: 'Why', type: 'long' })).toEqual({ title: 'Why', type: 'text', long: true, required: false })
    expect(fromOurQuestion({ label: 'Night', type: 'choice', options: ['Mon'] })).toEqual({ title: 'Night', type: 'choice', options: ['Mon'], required: false })
    expect(fromOurQuestion({ label: 'Team', type: 'dropdown', options: ['A', 'B'] })).toEqual({ title: 'Team', type: 'choice', dropdown: true, options: ['A', 'B'], required: false })
    expect(fromOurQuestion({ label: 'Part 2', type: 'section', required: true })).toEqual({ title: 'Part 2', type: 'section', required: false })
  })
})

describe('questionsFrom', () => {
  let db: DatabaseSync
  let dir: string
  const items = new Map<string, { id: string; kind: string; workspaceId: string | null }>()
  const scopes = new Map<string, { workspaceId: string }>([['t-purdue', { workspaceId: 'ws-purdue' }], ['t-cosmic', { workspaceId: 'ws-cosmic' }]])
  const ctx = () =>
    ({
      db,
      host: 'env_test',
      canvas: { get: (id: string) => items.get(id) ?? null },
      scopeOf: (id: string) => scopes.get(id) ?? null,
      reaches: () => true,
      settings: { get: () => ({}) }
    }) as never
  const thread = (sessionId: string): Caller => ({ kind: 'model', sessionId }) as Caller
  const owner = { kind: 'local' } as Caller

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'makers-'))
    db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, kind TEXT, sector TEXT)`)
    db.prepare(`INSERT INTO workspaces (id, name, path, kind, sector) VALUES ('ws-purdue', 'Purdue', ?, 'work', 'purdue'), ('ws-cosmic', 'Cosmic', ?, 'work', 'cosmic')`).run(join(dir, 'purdue'), join(dir, 'cosmic'))
    ensureFormsTables(db)
    items.clear()
    items.set('f1', { id: 'f1', kind: 'form', workspaceId: 'ws-purdue' })
    new FormsStore(db).create('f1', 'pane-1', {
      title: 'Tryouts',
      description: 'Sign up here.',
      questions: [
        { id: 'a', label: 'Name', type: 'short', required: true },
        { id: 'b', label: 'Night', type: 'dropdown', required: false, options: ['Mon', 'Tue'] }
      ]
    })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("makes our form's title and questions, for his press and for a thread of its own job", async () => {
    const want = { title: 'Tryouts', description: 'Sign up here.', questions: [{ title: 'Name', type: 'text', required: true }, { title: 'Night', type: 'choice', dropdown: true, options: ['Mon', 'Tue'], required: false }] }
    expect(await questionsFrom(ctx(), thread('t-purdue'), { form: 'f1' })).toEqual(want)
    expect(await questionsFrom(ctx(), owner, { form: 'f1' })).toEqual(want)
  })

  it("refuses a thread another job's form, and names nothing of it", async () => {
    await expect(questionsFrom(ctx(), thread('t-cosmic'), { form: 'f1' })).rejects.toThrow(NOT_YOUR_JOB)
    await expect(questionsFrom(ctx(), thread('t-cosmic'), { form: 'nope' })).rejects.toThrow(NOT_YOUR_JOB)
    await expect(questionsFrom(ctx(), thread('t-nobody'), { form: 'f1' })).rejects.toThrow(NOT_YOUR_JOB)
  })

  it("refuses a Microsoft form's answers workbook as a sheet to make a form from, before any cell is read", async () => {
    const { mkdirSync } = await import('node:fs')
    const { registerReadOnlyFile } = await import('../../files/hooks')
    mkdirSync(join(dir, 'purdue'), { recursive: true })
    const book = join(dir, 'purdue', 'Answers.xlsx')
    writeFileSync(book, 'not read')
    const off = registerReadOnlyFile((_c, f) => (f.path.endsWith('Answers.xlsx') ? { reason: 'r', refused: 'refused: w', readRefused: 'refused: read it with msform_answers.' } : null))
    try {
      await expect(questionsFrom(ctx(), thread('t-purdue'), { sheet: { at: 'file', host: 'env_test', path: book } })).rejects.toThrow('refused: read it with msform_answers.')
    } finally {
      off()
    }
  })

  it("reads a .tcdoc in the job's folder, and refuses one outside it", async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'purdue'), { recursive: true })
    const path = join(dir, 'purdue', 'Survey.tcdoc')
    writeFileSync(path, zipSync({ 'preview.md': strToU8('1. Name (required)\n2. Night?\n   - Mon\n   - Tue\n') }))
    expect(await questionsFrom(ctx(), thread('t-purdue'), { document: { at: 'file', host: 'env_test', path } })).toEqual({
      questions: [
        { title: 'Name', type: 'text', required: true },
        { title: 'Night?', type: 'choice', options: ['Mon', 'Tue'], required: false }
      ]
    })
    await expect(questionsFrom(ctx(), thread('t-cosmic'), { document: { at: 'file', host: 'env_test', path } })).rejects.toThrow(NOT_YOUR_JOB)
    writeFileSync(path, zipSync({ 'preview.md': strToU8('Only prose here.') }))
    await expect(questionsFrom(ctx(), thread('t-purdue'), { document: { at: 'file', host: 'env_test', path } })).rejects.toThrow(NO_QUESTIONS)
  })

  it('takes one source at a time, as the tool input says', () => {
    expect(MakerFromSchema.safeParse({ form: 'f1' }).success).toBe(true)
    expect(MakerFromSchema.safeParse({ sheet: { at: 'file', host: 'h', path: '/a.xlsx' }, row: 2 }).success).toBe(true)
    expect(MakerFromSchema.safeParse({ template: 'Sign-up', fields: { Event: 'Tryouts' } }).success).toBe(true)
    expect(MakerFromSchema.safeParse({ form: 'f1', template: 'x' }).success).toBe(false)
  })
})

describe('the follow-up survey', () => {
  const event = { _id: 'ev1', sector: 'purdue', title: 'Esports staff sync', startsAt: Date.UTC(2026, 10, 24, 20), allDay: false, attendees: [{ address: 'dana@purdue.edu', name: 'Dana Lee' }, { address: 'sam@purdue.edu', response: 'declined' }] }

  it('names the event, its time and its attendees, and holds both steps for his press', () => {
    const text = surveyMessage(event, 'America/Chicago')
    expect(text).toContain('“Esports staff sync” on Tuesday, November 24 at 2:00 PM')
    expect(text).toContain('Dana Lee <dana@purdue.edu>')
    expect(text).not.toContain('sam@purdue.edu')
    expect(text).toMatch(/msform_create .*`collect: true`/)
    expect(text).toMatch(/draft_mail/)
    expect(text).toMatch(/never send it yourself/)
    expect(surveyTitle('Esports staff sync')).toBe('Follow-up survey: Esports staff sync')
  })

  it('starts one thread in the job about the event, read through the sector fence', async () => {
    const started: unknown[] = []
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, kind TEXT, sector TEXT)`)
    db.prepare(`INSERT INTO workspaces VALUES ('ws-purdue', 'Purdue', '/w/p', 'work', 'purdue'), ('ws-cosmic', 'Cosmic', '/w/c', 'work', 'cosmic')`).run()
    const ctx = {
      db,
      host: 'env_test',
      reaches: () => true,
      scopeOf: () => null,
      clock: { lifeos: () => 'America/Chicago' },
      lifeos: { connected: () => true, owner: () => ({ query: async (fn: string, args: { id: string }) => (fn === 'events:get' && args.id === 'ev1' ? event : null) }) },
      threads: { start: async (o: unknown) => (started.push(o), 'thread-1') }
    } as never
    const by = { kind: 'local' } as Caller
    expect(await startSurvey(ctx, by, 'ws-purdue', 'ev1')).toEqual({ sessionId: 'thread-1' })
    expect(started).toEqual([
      expect.objectContaining({ workspaceId: 'ws-purdue', title: 'Follow-up survey: Esports staff sync', about: { kind: 'event', label: 'Esports staff sync', ref: { at: 'lifeos', table: 'events', id: 'ev1' } }, text: expect.stringContaining('Esports staff sync'), by })
    ])
    await expect(startSurvey(ctx, by, 'ws-cosmic', 'ev1')).rejects.toThrow('not in')
    await expect(startSurvey(ctx, by, 'ws-purdue', 'nope')).rejects.toThrow('no such event')
    expect(started).toHaveLength(1)
  })
})
