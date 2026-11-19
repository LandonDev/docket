import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PdfProvenance } from '@shared/contract-work-pdf'
import type { MoveModule } from '../../sessionMove'
import type { FormField } from './form'

// The move modules `ensure` registers, caught so a test can drive them.
const registered: MoveModule[] = []
vi.mock('../../sessionMove', async (orig) => ({
  ...(await orig<typeof import('../../sessionMove')>()),
  registerMoveModule: (_db: unknown, m: MoveModule) => (registered.push(m), () => {})
}))
const { ensurePdfTables, PdfStore, shortName } = await import('./store')

const P1 = 'topmostSubform[0].Page1[0].'
const field = (over: Partial<FormField> & { key: string }): FormField => ({ label: '', type: 'text', page: 1, bbox: [0.1, 0.1, 0.5, 0.15], value: null, readOnly: false, ...over })
const FORM: FormField[] = [
  field({ key: `${P1}f1_01[0]` }),
  field({ key: `${P1}f1_02[0]`, label: 'Business name', value: 'Acme' }),
  field({ key: `${P1}c1_1[0]`, type: 'checkbox', value: false }),
  field({ key: 'kind', type: 'choice', options: ['person', 'company'] }),
  field({ key: 'ssn', maxLength: 3 }),
  field({ key: 'locked', readOnly: true }),
  field({ key: 'sig', type: 'signature' })
]
const NAME = FORM[0].key
const BIZ = FORM[1].key
const BOX = FORM[2].key
const src = (label: string): PdfProvenance => ({ kind: 'file', label, quote: label })
const AGENT = 'agent:env_test:t1' as const

let db: DatabaseSync
let store: InstanceType<typeof PdfStore>
const byKey = (key: string, labels: Record<string, string> | null = null) => store.fields('i1', FORM, labels).find((f) => f.key === key)!

beforeEach(() => {
  registered.length = 0
  db = new DatabaseSync(':memory:')
  ensurePdfTables(db)
  store = new PdfStore(db)
})

describe('the fields', () => {
  it('shows the file\'s own fields as they are when nothing of ours is over them', () => {
    const fields = store.fields('i1', FORM)
    expect(fields).toHaveLength(FORM.length)
    expect(byKey(NAME)).toEqual({ key: NAME, label: 'f1_01', type: 'text', page: 1, bbox: [0.1, 0.1, 0.5, 0.15], origin: 'acroform', value: null, state: 'empty', provenance: [] })
    expect(byKey(BIZ)).toMatchObject({ label: 'Business name', value: 'Acme', state: 'accepted' })
    expect(byKey(BOX)).toMatchObject({ value: false, state: 'empty' })
    expect(byKey('kind')).toMatchObject({ options: ['person', 'company'] })
    expect(byKey('sig')).toMatchObject({ state: 'needs-owner' })
    // A label read off the page fills in for one the file lacks, never over the file's own.
    expect(byKey(NAME, { [NAME]: '1 Name', [BIZ]: 'other' }).label).toBe('1 Name')
    expect(byKey(BIZ, { [BIZ]: 'other' }).label).toBe('Business name')
    expect(shortName(`${P1}Address_ReadOrder[0].f1_07[0]`)).toBe('f1_07')
  })

  it('keeps the labels read off the page by the file\'s rev', () => {
    store.setLabels('i1', 't1', 'rev1', { [NAME]: '1 Name' })
    expect(store.labels('i1', 'rev1')).toEqual({ [NAME]: '1 Name' })
    expect(store.labels('i1', 'rev2')).toBeNull()
  })

  it('suggests: an agent\'s value waits with its source, and the file\'s value is what a copy carries until he accepts', () => {
    const r = store.fill('i1', 't1', [{ key: BIZ, value: 'Acme LLC', source: src('Purdue profile') }, { key: BOX, value: true, source: src('mail') }], AGENT, FORM, false)
    expect(r).toEqual({ done: [BIZ, BOX], refused: [] })
    expect(byKey(BIZ)).toMatchObject({ value: 'Acme', proposed: 'Acme LLC', state: 'proposed', provenance: [src('Purdue profile')], by: AGENT })
    expect(byKey(BOX)).toMatchObject({ value: false, proposed: true, state: 'proposed' })
    expect(store.pending('i1')).toBe(2)
    expect(store.ownValues('i1')).toEqual([])
    expect(store.written('i1')).toBeNull()
    // A second suggestion replaces the first, and its source with it.
    store.fill('i1', 't1', [{ key: BIZ, value: 'Acme Inc', source: src('Run of show.docx, p. 2') }], AGENT, FORM, false)
    expect(byKey(BIZ)).toMatchObject({ proposed: 'Acme Inc', provenance: [src('Run of show.docx, p. 2')] })
  })

  it('refuses by name a value the field cannot take', () => {
    const r = store.fill(
      'i1',
      't1',
      [
        { key: 'nope', value: 'x', source: src('a') },
        { key: 'sig', value: 'x', source: src('a') },
        { key: 'locked', value: 'x', source: src('a') },
        { key: BOX, value: 'yes', source: src('a') },
        { key: NAME, value: true, source: src('a') },
        { key: 'kind', value: 'trust', source: src('a') },
        { key: 'ssn', value: '1234', source: src('a') },
        { key: 'kind', value: 'company', source: src('a') }
      ],
      AGENT,
      FORM,
      false
    )
    expect(r.done).toEqual(['kind'])
    expect(r.refused).toEqual([
      'nope: the form has no field of that name',
      "sig: the signature and its date are the owner's to place",
      'locked: the form does not let this field be changed',
      `${BOX}: a checkbox takes true or false`,
      `${NAME}: this field takes text`,
      'kind: not one of its options (person, company)',
      'ssn: at most 3 characters fit'
    ])
  })

  it('writes: in "Agent writes" the values land accepted as one write, and Undo puts each field back as it was', () => {
    store.setOwn('i1', 't1', NAME, 'Ada', FORM[0])
    const r = store.fill(
      'i1',
      't1',
      [
        { key: NAME, value: 'Ada Exampleton', source: src('profile') },
        { key: BIZ, value: 'Acme LLC', source: src('profile') },
        { key: NAME, value: 'Ada E.', source: src('profile') }
      ],
      AGENT,
      FORM,
      true
    )
    expect(r.written).toMatchObject({ text: 'Filled 2 fields' })
    expect(store.written('i1')).toMatchObject({ id: r.written!.id, text: 'Filled 2 fields' })
    expect(byKey(NAME)).toMatchObject({ value: 'Ada E.', state: 'accepted' })
    expect(byKey(BIZ)).toMatchObject({ value: 'Acme LLC', state: 'accepted', provenance: [src('profile')] })
    expect(store.ownValues('i1')).toEqual(expect.arrayContaining([{ key: NAME, value: 'Ada E.' }, { key: BIZ, value: 'Acme LLC' }]))
    expect(store.undo('i1', 'not-it')).toBe(false)
    expect(store.undo('i1', r.written!.id)).toBe(true)
    // His own value comes back, not the middle one; the field he never touched is the file's again.
    expect(byKey(NAME)).toMatchObject({ value: 'Ada', state: 'accepted', by: 'owner' })
    expect(byKey(BIZ)).toMatchObject({ value: 'Acme', state: 'accepted', provenance: [] })
    expect(store.written('i1')).toBeNull()
    expect(store.undo('i1', r.written!.id)).toBe(false)
  })

  it('review: accept takes the value; reject drops it and what he had before stands', () => {
    store.setOwn('i1', 't1', BIZ, 'Mine', FORM[1])
    store.fill('i1', 't1', [{ key: NAME, value: 'Ada', source: src('a') }, { key: BIZ, value: 'Theirs', source: src('b') }, { key: BOX, value: true, source: src('c') }], AGENT, FORM, false)
    expect(store.review('i1', [NAME], 'accept')).toEqual([NAME])
    expect(byKey(NAME)).toMatchObject({ value: 'Ada', state: 'accepted', provenance: [src('a')] })
    expect(byKey(NAME).proposed).toBeUndefined()
    expect(store.review('i1', 'all', 'reject').sort()).toEqual([BIZ, BOX].sort())
    expect(byKey(BIZ)).toMatchObject({ value: 'Mine', state: 'accepted', provenance: [{ kind: 'manual', label: 'You typed it', confidence: 1 }] })
    expect(byKey(BOX)).toMatchObject({ value: false, state: 'empty', provenance: [] })
    expect(store.pending('i1')).toBe(0)
    expect(store.review('i1', 'all', 'accept')).toEqual([])
  })

  it('setField: his own value, marked as typed; null gives the file\'s back; a signature is his press, not a value', () => {
    store.fill('i1', 't1', [{ key: NAME, value: 'Ada', source: src('a') }], AGENT, FORM, false)
    store.setOwn('i1', 't1', NAME, 'Ada Lovelace', FORM[0])
    expect(byKey(NAME)).toMatchObject({ value: 'Ada Lovelace', state: 'accepted', by: 'owner', provenance: [{ kind: 'manual', label: 'You typed it', confidence: 1 }] })
    expect(store.pending('i1')).toBe(0)
    store.setOwn('i1', 't1', NAME, null, FORM[0])
    expect(byKey(NAME)).toMatchObject({ value: null, state: 'empty' })
    expect(() => store.setOwn('i1', 't1', 'sig', 'x', FORM[6])).toThrow('Press Sign to place your signature and the date.')
    expect(() => store.setOwn('i1', 't1', BOX, 'on', FORM[2])).toThrow('A checkbox is on or off.')
    expect(() => store.setOwn('i1', 't1', NAME, true, FORM[0])).toThrow('This field takes text.')
    expect(() => store.setOwn('i1', 't1', 'ghost', 'x', undefined)).toThrow('The form has no field named ghost.')
  })

  it('places boxes on a page with no field there; the signature and its date wait for him', () => {
    store.place('i1', 't1', [
      { key: 'box:line', type: 'text', label: 'Phone', page: 2, bbox: [0.1, 0.5, 0.4, 0.52] },
      { key: 'box:sig', type: 'signature', label: 'Signature', page: 1, bbox: [0.12, 0.73, 0.5, 0.76] },
      { key: 'box:date', type: 'date', label: 'Date', page: 1, bbox: [0.6, 0.73, 0.9, 0.76] }
    ], AGENT)
    const overlays = store.fields('i1', FORM).filter((f) => f.origin === 'overlay')
    // After the file's own, in page order.
    expect(overlays.map((f) => [f.key, f.page, f.state])).toEqual([
      ['box:date', 1, 'needs-owner'],
      ['box:sig', 1, 'needs-owner'],
      ['box:line', 2, 'empty']
    ])
    expect(store.fill('i1', 't1', [{ key: 'box:line', value: '555-0100', source: src('mail') }, { key: 'box:date', value: 'today', source: src('a') }], AGENT, FORM, false).refused).toEqual([
      "box:date: the signature and its date are the owner's to place"
    ])
    // Placing the same key again moves the box and keeps its value.
    store.place('i1', 't1', [{ key: 'box:line', type: 'text', label: 'Phone', page: 2, bbox: [0.1, 0.6, 0.4, 0.62] }], AGENT)
    expect(store.fields('i1', FORM).find((f) => f.key === 'box:line')).toMatchObject({ bbox: [0.1, 0.6, 0.4, 0.62], state: 'proposed', proposed: '555-0100' })
    // A box of ours emptied by him stays a box.
    store.setOwn('i1', 't1', 'box:line', null, undefined)
    expect(store.fields('i1', FORM).find((f) => f.key === 'box:line')).toMatchObject({ state: 'empty', value: null })
  })

  it('signs: his press fills the signature boxes, the date boxes with the day, and the file\'s own signature fields; unsigning takes them off', () => {
    store.place('i1', 't1', [
      { key: 'box:sig', type: 'signature', label: 'Signature', page: 1, bbox: [0.12, 0.73, 0.5, 0.76] },
      { key: 'box:date', type: 'date', label: 'Date', page: 1, bbox: [0.6, 0.73, 0.9, 0.76] }
    ], AGENT)
    store.sign('i1', 't1', true, FORM, 'November 19, 2026')
    expect(store.signedAt('i1')).toEqual(expect.any(Number))
    const f = (k: string) => store.fields('i1', FORM).find((x) => x.key === k)!
    expect(f('box:sig')).toMatchObject({ value: true, state: 'accepted', by: 'owner' })
    expect(f('box:date')).toMatchObject({ value: 'November 19, 2026', state: 'accepted' })
    expect(f('sig')).toMatchObject({ state: 'accepted', by: 'owner' })
    // A signature is never a value in the copy's own fields.
    expect(store.ownValues('i1')).toEqual([])
    store.sign('i1', 't1', false, FORM, 'November 19, 2026')
    expect(store.signedAt('i1')).toBeNull()
    expect([f('box:sig').state, f('box:date').state, f('sig').state]).toEqual(['needs-owner', 'needs-owner', 'needs-owner'])
    expect(f('box:date').value).toBeNull()
  })

  it('keeps the item\'s mode, "Agent suggests" until he says otherwise', () => {
    expect(store.mode('i1')).toBe('suggests')
    store.setMode('i1', 't1', 'writes')
    expect(store.mode('i1')).toBe('writes')
    store.setMode('i1', 't1', 'suggests')
    expect(store.mode('i1')).toBe('suggests')
  })
})

describe('highlights and the signature', () => {
  it('keeps highlights by page and time, and drops one by id', () => {
    const a = store.mark('i1', 't1', { page: 2, quads: [[0.1, 0.2, 0.5, 0.22]], text: 'clause 7.2' }, 'owner')
    const b = store.mark('i1', 't1', { page: 1, quads: [[0.1, 0.1, 0.3, 0.12], [0.1, 0.12, 0.2, 0.14]], text: 'two lines', note: 'check' }, AGENT)
    expect(store.marks('i1')).toEqual([
      { id: b, page: 1, quads: [[0.1, 0.1, 0.3, 0.12], [0.1, 0.12, 0.2, 0.14]], text: 'two lines', note: 'check', by: AGENT, at: expect.any(Number) },
      { id: a, page: 2, quads: [[0.1, 0.2, 0.5, 0.22]], text: 'clause 7.2', by: 'owner', at: expect.any(Number) }
    ])
    store.unmark('i1', b)
    store.unmark('other', a)
    expect(store.marks('i1').map((m) => m.id)).toEqual([a])
  })

  it('keeps one drawn signature per host, forgets it on null, and reads a broken row as none', () => {
    expect(store.signature()).toBeNull()
    const sig = { width: 300, height: 100, strokes: [[[10, 50], [80, 20], [150, 60]] as Array<[number, number]>] }
    store.setSignature(sig)
    expect(store.signature()).toEqual(sig)
    db.prepare(`UPDATE work_pdf_signature SET strokes = '{"width":-1}'`).run()
    expect(store.signature()).toBeNull()
    store.setSignature(sig)
    store.setSignature(null)
    expect(store.signature()).toBeNull()
  })
})

describe('deleted and moved threads', () => {
  const fillTwo = (): void => {
    store.fill('i1', 't1', [{ key: NAME, value: 'Ada', source: src('a') }], AGENT, FORM, false)
    store.mark('i1', 't1', { page: 1, quads: [[0, 0, 1, 0.1]], text: 'x' }, 'owner')
    store.fill('i2', 't2', [{ key: NAME, value: 'Bo', source: src('b') }], 'agent:env_test:t2', FORM, false)
    store.mark('i2', 't2', { page: 1, quads: [[0, 0, 1, 0.1]], text: 'y' }, 'owner')
    store.setSignature({ width: 10, height: 10, strokes: [[[1, 1]]] })
  }

  it('removeSessions drops a thread\'s rows and nobody else\'s; his signature is the host\'s and stays', () => {
    fillTwo()
    store.removeSessions(['t1'])
    expect(store.pending('i1')).toBe(0)
    expect(store.marks('i1')).toEqual([])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM work_pdf_items WHERE session_id = 't1'`).get()).toEqual({ n: 0 })
    expect(store.pending('i2')).toBe(1)
    expect(store.marks('i2')).toHaveLength(1)
    expect(store.signature()).not.toBeNull()
  })

  it('registers a move module per table that rides with a thread, never the signature', () => {
    expect(registered.map((m) => m.id)).toEqual(['pdf-items', 'pdf-fields', 'pdf-marks'])
    fillTwo()
    const host = { db } as never
    const rows = Object.fromEntries(registered.map((m) => [m.id, m.rows!(host, ['t1'])]))
    expect(rows['pdf-items']).toHaveLength(1)
    expect(rows['pdf-fields']).toEqual([expect.objectContaining({ item_id: 'i1', key: NAME, state: 'proposed' })])
    expect(rows['pdf-marks']).toEqual([expect.objectContaining({ item_id: 'i1', text: 'x' })])
    // The source drops them once the move is done, and the receiver lands them as they were.
    for (const m of registered) m.drop!(host, ['t1'])
    expect(store.pending('i1')).toBe(0)
    for (const m of registered) m.land!(host, rows[m.id], { ids: ['t1'], from: 'env_box', workspaceId: 'w9', land: (p) => p })
    expect(byKey(NAME)).toMatchObject({ proposed: 'Ada', state: 'proposed' })
    expect(store.marks('i1')).toHaveLength(1)
    expect(store.pending('i2')).toBe(1)
  })
})

describe('the review\'s holes (B2, B3, M5, B4, M1)', () => {
  const SIG = { key: 'box:sig', type: 'signature' as const, label: 'Signature', page: 1, bbox: [0.12, 0.73, 0.5, 0.76] as [number, number, number, number] }
  const DATE = { key: 'box:date', type: 'date' as const, label: 'Date', page: 1, bbox: [0.6, 0.73, 0.9, 0.76] as [number, number, number, number] }
  const f = (k: string) => store.fields('i1', FORM).find((x) => x.key === k)!

  it('B2: a signed box cannot be moved, so his ink stays where he pressed Sign; an unsigned one moves', () => {
    store.place('i1', 't1', [SIG, DATE], AGENT, FORM)
    // Before he signs, the agent may still move the boxes.
    expect(store.place('i1', 't1', [{ ...SIG, page: 2 }], AGENT, FORM).refused).toEqual([])
    store.place('i1', 't1', [SIG], AGENT, FORM)
    store.sign('i1', 't1', true, FORM, 'November 19, 2026', 'rev1')
    const r = store.place('i1', 't1', [{ ...SIG, page: 3, bbox: [0.5, 0.5, 0.7, 0.55] }, { ...DATE, bbox: [0, 0, 0.2, 0.05] }], AGENT, FORM)
    expect(r).toEqual({ placed: [], refused: ['box:sig: the owner has signed there; it cannot be moved', 'box:date: the owner has signed there; it cannot be moved'] })
    expect(f('box:sig')).toMatchObject({ page: 1, bbox: SIG.bbox, state: 'accepted' })
    // Placing it again where it is changes nothing and is no move.
    expect(store.place('i1', 't1', [SIG], AGENT, FORM).refused).toEqual([])
  })

  it('B3: a box keeps its type: a text box with a value cannot become a signature or a date, nor a signed box text', () => {
    store.place('i1', 't1', [{ key: 'box:t', type: 'text', label: 'x', page: 1, bbox: [0, 0, 0.2, 0.05] }], AGENT, FORM)
    store.fill('i1', 't1', [{ key: 'box:t', value: 'x', source: src('profile') }], AGENT, FORM, false)
    for (const type of ['signature', 'date'] as const) {
      expect(store.place('i1', 't1', [{ key: 'box:t', type, label: 'x', page: 1, bbox: [0, 0, 0.2, 0.05] }], AGENT, FORM).refused).toEqual([`box:t: it is a text box; place a new key for a ${type} box`])
    }
    expect(f('box:t')).toMatchObject({ type: 'text', proposed: 'x' })
    store.place('i1', 't1', [SIG], AGENT, FORM)
    store.sign('i1', 't1', true, FORM, 'today', 'rev1')
    expect(store.place('i1', 't1', [{ ...SIG, type: 'text' }], AGENT, FORM).refused).toEqual(['box:sig: it is a signature box; place a new key for a text box'])
    expect(f('box:sig')).toMatchObject({ type: 'signature', value: true })
  })

  it('M5: place takes only box: keys, never one the form owns, so his value in a form field stays his', () => {
    store.setOwn('i1', 't1', NAME, 'His value', FORM[0])
    const r = store.place('i1', 't1', [{ key: NAME, type: 'text', label: 'x', page: 1, bbox: [0, 0, 0.2, 0.05] }, { key: 'free', type: 'text', label: 'y', page: 1, bbox: [0, 0, 0.2, 0.05] }], AGENT, FORM)
    expect(r.placed).toEqual([])
    expect(r.refused).toEqual([`${NAME}: a placed box's key starts with "box:" and is not one of the form's fields`, 'free: a placed box\'s key starts with "box:" and is not one of the form\'s fields'])
    expect(f(NAME)).toMatchObject({ origin: 'acroform', value: 'His value' })
    expect(store.ownValues('i1')).toEqual([{ key: NAME, value: 'His value' }])
  })

  it('B4: a signature stands only over the file version and the values he signed', () => {
    store.place('i1', 't1', [SIG, DATE], AGENT, FORM)
    store.setOwn('i1', 't1', NAME, 'Ada', FORM[0])
    store.sign('i1', 't1', true, FORM, 'November 19, 2026', 'rev1')
    expect(store.signedOver('i1', 't1', 'rev1', FORM)).toBe(true)
    // Marks and suggestions are not values he signed over.
    store.mark('i1', 't1', { page: 1, quads: [[0, 0, 1, 0.1]], text: 'x' }, 'owner')
    store.fill('i1', 't1', [{ key: BIZ, value: 'Waiting', source: src('a') }], AGENT, FORM, false)
    expect(store.signedOver('i1', 't1', 'rev1', FORM)).toBe(true)
    // A new version of the file: off, and the boxes wait for him again.
    expect(store.signedOver('i1', 't1', 'rev2', FORM)).toBe(false)
    expect(store.signedAt('i1')).toBeNull()
    expect([f('box:sig').state, f('box:date').state]).toEqual(['needs-owner', 'needs-owner'])
    const each: Array<[string, () => void]> = [
      ['a direct write', () => store.fill('i1', 't1', [{ key: NAME, value: 'Bo', source: src('a') }], AGENT, FORM, true)],
      ['a review', () => store.review('i1', 'all', 'accept')],
      ['his own edit', () => store.setOwn('i1', 't1', NAME, 'Ada L.', FORM[0])],
      ['a box placed after', () => store.place('i1', 't1', [{ key: 'box:new', type: 'text', label: 'n', page: 1, bbox: [0, 0, 0.1, 0.1] }], AGENT, FORM)]
    ]
    for (const [why, change] of each) {
      store.sign('i1', 't1', true, FORM, 'November 19, 2026', 'rev1')
      expect(store.signedOver('i1', 't1', 'rev1', FORM), `before ${why}`).toBe(true)
      change()
      expect(store.signedOver('i1', 't1', 'rev1', FORM), why).toBe(false)
    }
  })

  it('M1: Undo of an agent\'s write leaves a field he changed since; the others go back', () => {
    const r = store.fill('i1', 't1', [{ key: NAME, value: 'A', source: src('a') }, { key: BIZ, value: 'Agent LLC', source: src('a') }], AGENT, FORM, true)
    store.setOwn('i1', 't1', NAME, 'B (his correction)', FORM[0])
    expect(store.undo('i1', r.written!.id)).toBe(true)
    expect(f(NAME)).toMatchObject({ value: 'B (his correction)', by: 'owner' })
    expect(f(BIZ)).toMatchObject({ value: 'Acme', provenance: [] })
  })
})

describe('round three: the hash counts what the copy carries (N2)', () => {
  it('a suggestion over an accepted field or box keeps the signature; a placed box\'s value counts while a suggestion waits', () => {
    store.place('i1', 't1', [{ key: 'box:sig', type: 'signature', label: 'S', page: 1, bbox: [0.1, 0.7, 0.4, 0.75] }, { key: 'box:t', type: 'text', label: 'T', page: 1, bbox: [0.1, 0.8, 0.4, 0.85] }], AGENT, FORM)
    store.setOwn('i1', 't1', NAME, 'Ada', FORM[0])
    store.setOwn('i1', 't1', 'box:t', 'mine', undefined)
    store.sign('i1', 't1', true, FORM, 'November 19, 2026', 'rev1')
    store.fill('i1', 't1', [{ key: NAME, value: 'Other', source: src('a') }, { key: 'box:t', value: 'theirs', source: src('a') }], AGENT, FORM, false)
    expect(store.signedOver('i1', 't1', 'rev1', FORM)).toBe(true)
    store.review('i1', ['box:t'], 'reject')
    expect(store.signedOver('i1', 't1', 'rev1', FORM)).toBe(true)
    store.review('i1', [NAME], 'accept')
    expect(store.signedOver('i1', 't1', 'rev1', FORM)).toBe(false)
  })
})
