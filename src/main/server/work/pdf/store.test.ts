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
const { ensurePdfTables, PDF_KEYED, PdfStore, shortName } = await import('./store')
const { ensureCanvasTables } = await import('../canvas/store')
const { fileKeyOf, moveFileKeys } = await import('../canvas/fileKey')

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

describe('kept by the file: a Files tab and a thread on one PDF share its rows', () => {
  const PATH = '/w/Job/Bracket.pdf'
  const fileOf = (path = PATH) => ({ at: 'file' as const, host: 'env_box', path })
  type Source = Parameters<typeof fileKeyOf>[0]['source']
  let n = 0
  const canvasItem = (id: string, sessionId: string, workspaceId: string, source: Source, on: DatabaseSync = db) => {
    n++
    on.prepare(`INSERT INTO work_canvas_items (id, session_id, workspace_id, kind, title, source, state, position, rev, created_at, updated_at) VALUES (?, ?, ?, 'pdf', 'Bracket.pdf', ?, 'open', 0, 0, ?, ?)`).run(id, sessionId, workspaceId, JSON.stringify(source), n, n)
    return { id, sessionId, workspaceId, source }
  }
  const gone = (id: string): void => void db.prepare(`DELETE FROM work_canvas_items WHERE id = ?`).run(id)
  const count = (table: string, on: DatabaseSync = db): number => (on.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  const keysOf = (table: string, on: DatabaseSync = db): Array<[string, string | null]> => on.prepare(`SELECT item_id, file_key FROM ${table} ORDER BY rowid`).all().map((r) => [String(r.item_id), r.file_key as string | null])
  const mark = (item: Parameters<typeof store.keep>[0], text: string): string => {
    const k = store.keep(item)
    return store.mark(k.id, k.sessionId, { page: 1, quads: [[0, 0, 1, 0.1]], text }, 'owner')
  }
  const marksOf = (item: Parameters<typeof store.keep>[0]): string[] => store.marks(store.keep(item).id).map((m) => m.text)

  beforeEach(() => ensureCanvasTables(db))

  it('reads and writes one set of rows through either item, each kept by the file\'s key', () => {
    const thread = canvasItem('i1', 't1', 'w1', fileOf())
    const tab = canvasItem('tab1', 'files:w1', 'w1', fileOf())
    const a = store.keep(thread)
    store.fill(a.id, a.sessionId, [{ key: NAME, value: 'Ada', source: src('profile') }], AGENT, FORM, false)
    mark(thread, 'from the thread')
    const b = store.keep(tab)
    expect(b).toEqual(a)
    expect(store.fields(b.id, FORM).find((f) => f.key === NAME)).toMatchObject({ proposed: 'Ada', state: 'proposed' })
    // And back: what the tab does, the thread sees.
    store.review(b.id, 'all', 'accept')
    mark(tab, 'from the tab')
    store.setMode(b.id, b.sessionId, 'writes')
    expect(store.fields(store.keep(thread).id, FORM).find((f) => f.key === NAME)).toMatchObject({ value: 'Ada', state: 'accepted' })
    expect(marksOf(thread)).toEqual(['from the thread', 'from the tab'])
    expect(store.mode(store.keep(thread).id)).toBe('writes')
    // A direct write through the thread is taken back through the tab.
    const w = store.fill(a.id, a.sessionId, [{ key: BIZ, value: 'Ada LLC', source: src('profile') }], AGENT, FORM, true).written!
    expect(store.undo(store.keep(tab).id, w.id)).toBe(true)
    expect(store.fields(a.id, FORM).find((f) => f.key === BIZ)).toMatchObject({ value: 'Acme', state: 'accepted', provenance: [] })
    const key = fileKeyOf(thread)
    for (const table of ['work_pdf_items', 'work_pdf_fields', 'work_pdf_marks']) expect(new Set(keysOf(table).map(([, k]) => k))).toEqual(new Set([key]))
  })

  it('keeps an item with no file, or of another workspace, to its own rows', () => {
    const thread = canvasItem('i1', 't1', 'w1', fileOf())
    mark(thread, 'his')
    const made = canvasItem('m1', 't1', 'w1', { at: 'thread' })
    const other = canvasItem('o1', 't2', 'w2', fileOf())
    expect(store.keep(made)).toEqual({ id: 'm1', sessionId: 't1', fileKey: '' })
    expect(store.keep(other).id).toBe('o1')
    expect(marksOf(made)).toEqual([])
    expect(marksOf(other)).toEqual([])
    mark(made, 'made')
    expect(marksOf(thread)).toEqual(['his'])
  })

  it('keeps the rows while one item on the file is left, and drops them with the last', () => {
    const thread = canvasItem('i1', 't1', 'w1', fileOf())
    const tab = canvasItem('tab1', 'files:w1', 'w1', fileOf())
    mark(thread, 'x')
    gone('i1')
    store.removeItems(['i1'])
    expect(store.keep(tab)).toMatchObject({ id: 'tab1', sessionId: 'files:w1' })
    expect(marksOf(tab)).toEqual(['x'])
    // Closing a tab that only reads the rows takes nothing.
    const again = canvasItem('i2', 't1', 'w1', fileOf())
    gone('i2')
    store.removeItems(['i2'])
    expect(marksOf(tab)).toEqual(['x'])
    gone('tab1')
    store.removeItems(['tab1'])
    for (const table of ['work_pdf_items', 'work_pdf_fields', 'work_pdf_marks']) expect(count(table)).toBe(0)
    expect(again.id).toBe('i2')
  })

  it("passes a deleted thread's rows to the tab that shows its file; a thread alone on its file takes them with it", () => {
    const thread = canvasItem('i1', 't1', 'w1', fileOf())
    const tab = canvasItem('tab1', 'files:w1', 'w1', fileOf())
    mark(thread, 'x')
    const lone = canvasItem('i3', 't3', 'w1', fileOf('/w/Job/Other.pdf'))
    mark(lone, 'y')
    // The thread's canvas rows may still be there when the pillar hears: they are not heirs.
    store.removeSessions(['t1', 't3'])
    expect(store.keep(tab)).toMatchObject({ id: 'tab1', sessionId: 'files:w1' })
    expect(marksOf(tab)).toEqual(['x'])
    expect(db.prepare(`SELECT COUNT(*) AS n FROM work_pdf_marks WHERE item_id = 'i3'`).get()).toEqual({ n: 0 })
  })

  it('fills the key at start for rows an older build made, and keeps two items that each had rows apart', () => {
    const old = new DatabaseSync(':memory:')
    // The tables as an older build made them: no file key.
    old.exec(`CREATE TABLE work_pdf_items (item_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'suggests', signed_at INTEGER, signed_rev TEXT, signed_hash TEXT, written TEXT, labels TEXT, updated_at INTEGER NOT NULL)`)
    old.exec(`CREATE TABLE work_pdf_fields (item_id TEXT NOT NULL, session_id TEXT NOT NULL, key TEXT NOT NULL, origin TEXT NOT NULL, type TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', page INTEGER NOT NULL DEFAULT 1, bbox TEXT, value TEXT, proposed TEXT, state TEXT NOT NULL, provenance TEXT NOT NULL DEFAULT '[]', by TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (item_id, key))`)
    old.exec(`CREATE TABLE work_pdf_marks (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, session_id TEXT NOT NULL, page INTEGER NOT NULL, quads TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', note TEXT, by TEXT NOT NULL, at INTEGER NOT NULL)`)
    ensureCanvasTables(old)
    const first = canvasItem('i1', 't1', 'w1', fileOf(), old)
    const second = canvasItem('i2', 't2', 'w1', fileOf(), old)
    canvasItem('m1', 't1', 'w1', { at: 'thread' }, old)
    old.prepare(`INSERT INTO work_pdf_items (item_id, session_id, updated_at) VALUES ('i1', 't1', 1)`).run()
    old.prepare(`INSERT INTO work_pdf_fields (item_id, session_id, key, origin, type, state, updated_at) VALUES ('i1', 't1', ?, 'acroform', 'text', 'proposed', 1)`).run(NAME)
    const oldMark = old.prepare(`INSERT INTO work_pdf_marks (id, item_id, session_id, page, quads, text, by, at) VALUES (?, ?, ?, 1, '[]', ?, 'owner', 1)`)
    oldMark.run('k1', 'i1', 't1', 'one')
    // A highlight with no item row (an older build made those), one on a thread's own file, one of an item that is gone.
    oldMark.run('k2', 'i2', 't2', 'two')
    oldMark.run('k3', 'm1', 't1', 'made')
    oldMark.run('k4', 'gone', 't1', 'gone')
    ensurePdfTables(old)
    const s = new PdfStore(old)
    const key = fileKeyOf(first)
    // i2's item row was made last (for its highlight), so it keeps the file's rows; i1 keeps its own apart.
    expect(keysOf('work_pdf_marks', old)).toEqual([['i1', ''], ['i2', key], ['m1', ''], ['gone', '']])
    expect(keysOf('work_pdf_items', old).sort()).toEqual([['gone', ''], ['i1', ''], ['i2', key], ['m1', '']])
    expect(keysOf('work_pdf_fields', old)).toEqual([['i1', '']])
    // Each reads its own as before; a new tab on the file reads the keeper's.
    expect(s.marks(s.keep(first).id).map((m) => m.text)).toEqual(['one'])
    expect(s.pending(s.keep(first).id)).toBe(1)
    expect(s.marks(s.keep(second).id).map((m) => m.text)).toEqual(['two'])
    expect(s.keep(canvasItem('tab1', 'files:w1', 'w1', fileOf(), old)).id).toBe('i2')
    // An older build still writes by its own columns; the next start fills the key.
    oldMark.run('k5', 'i2', 't2', 'later')
    expect(keysOf('work_pdf_marks', old).at(-1)).toEqual(['i2', null])
    ensurePdfTables(old)
    expect(keysOf('work_pdf_marks', old).at(-1)).toEqual(['i2', key])
    old.close()
  })

  it('re-points the key when the file is renamed, and a file new at the old name starts with none', () => {
    const NEW = '/w/Job/Bracket final.pdf'
    const thread = canvasItem('i1', 't1', 'w1', fileOf())
    const tab = canvasItem('tab1', 'files:w1', 'w1', fileOf())
    mark(thread, 'x')
    moveFileKeys(db, PDF_KEYED, fileOf(), fileOf(NEW))
    // As Files does next: the items name the new path.
    db.prepare(`UPDATE work_canvas_items SET source = ?`).run(JSON.stringify(fileOf(NEW)))
    const moved = { ...tab, source: fileOf(NEW) }
    expect(store.keep(moved)).toMatchObject({ id: 'i1', fileKey: fileKeyOf(moved) })
    expect(marksOf(moved)).toEqual(['x'])
    expect(marksOf(canvasItem('i9', 't9', 'w1', fileOf()))).toEqual([])
    expect(keysOf('work_pdf_marks')).toEqual([['i1', fileKeyOf(moved)]])
  })

  it('lets a moving thread take the rows it shares and leaves the tab its own, with new ids on what stays twice', () => {
    const host = { db } as never
    const tab = canvasItem('tab1', 'files:w1', 'w1', fileOf())
    const thread = canvasItem('i1', 't1', 'w1', fileOf())
    const id = mark(tab, 'the tab kept it')
    const rows = Object.fromEntries(registered.map((m) => [m.id, m.rows!(host, ['t1'])]))
    expect(rows['pdf-items']).toEqual([expect.objectContaining({ item_id: 'i1', session_id: 't1', file_key: null })])
    expect(rows['pdf-marks']).toEqual([expect.objectContaining({ item_id: 'i1', session_id: 't1', text: 'the tab kept it', file_key: null })])
    expect((rows['pdf-marks'][0] as { id: string }).id).not.toBe(id)
    for (const m of registered) m.drop!(host, ['t1'])
    expect(marksOf(tab)).toEqual(['the tab kept it'])
    // The tab closes and the thread keeps them; the thread moves, takes them, and they pass to a new tab here.
    gone('tab1')
    store.removeItems(['tab1'])
    expect(store.keep(thread)).toMatchObject({ id: 'i1', sessionId: 't1' })
    mark(thread, 'the thread kept it')
    const tab2 = canvasItem('tab2', 'files:w1', 'w1', fileOf())
    const taken = registered.find((m) => m.id === 'pdf-marks')!.rows!(host, ['t1']) as Array<{ id: string; item_id: string }>
    expect(taken.map((r) => r.item_id)).toEqual(['i1', 'i1'])
    for (const m of registered) m.drop!(host, ['t1'])
    expect(store.keep(tab2)).toMatchObject({ id: 'tab2', sessionId: 'files:w1' })
    expect(store.marks('tab2').map((m) => m.id).filter((x) => taken.some((t) => t.id === x))).toEqual([])
    expect(marksOf(tab2)).toEqual(['the tab kept it', 'the thread kept it'])
  })
})
