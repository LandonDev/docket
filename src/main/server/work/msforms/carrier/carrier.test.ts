import { describe, expect, it } from 'vitest'
import { screenOfObservation } from '@shared/computer/outward'
import type { ComputerAction } from '@shared/computer/protocol'
import type { MsFormSettings } from '@shared/work/msforms'
import { FakeForms, type FakeFormState } from './fakePage'
import { guardStep } from './guard'
import { opsCarrier } from './ops'
import { countOf, formOf, linkOf, settingsOf } from './read'
import { authorize, CarrierRefused, CarrierStop, type CarrierOp } from './types'

/**
 * The carrier on a fake Forms page in the trial's names: what a read says,
 * what the guard lets each operation press, the authorization's binding, and
 * the stops that say what was done.
 */

const app = { bundleId: 'org.chromium.Chromium', name: 'Chromium' }
const screen = (lines: string) => screenOfObservation(`app "Chromium" · window "Dummy" · 1280×800\n${lines.trim()}`, app)!

// The trial's shapes, with made-up names.
const AT_REST = screen(`
[1] window "TempCode proof forms builder"
  [2] input "Address and search bar" = "https://forms.cloud.microsoft/Pages/DesignPageV2.aspx?subpage=design&id=FakeFormId00000000000001"
  [3] button "Form title TempCode proof forms builder Saved"
  [4] input "Form description" = "A made-up form"
  [5] button "1. Question title Which dummy colour do you pick? Choice Required to answer"
    [6] radio "Red" unchecked
    [7] radio "Green" unchecked
    [8] radio "Blue" unchecked
  [9] button "2. Question title Write a made-up word Text"
  [10] button "3. Question title Pick a made-up date Date"
  [11] button "4. Question title Rank the shapes Ranking"
  [12] button "Customer feedback template"
  [13] button "Collect responses"
`)
const SETTINGS = screen(`
[1] group "Settings"
  [2] radio "Anyone can respond" unchecked
  [3] radio "Only people in purdue.edu can respond" checked
  [4] checkbox "Record name" checked
  [5] checkbox "One response per person" unchecked
  [6] checkbox "Accept responses" checked
  [7] checkbox "Start date" unchecked
  [8] checkbox "End date" unchecked
`)
const COLLECT = screen(`
[1] dialog "Send and collect responses"
  [2] input "Link for Collecting Responses" = "https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=FakeFormId00000000000001" read-only
  [3] checkbox "Shorten URL" unchecked
  [4] button "Copy link"
  [5] checkbox "Outlook" checked
  [6] button "Send"
`)

describe('a read of the page', () => {
  it('reads the form at rest: title, description, every question with its type and options', () => {
    const read = formOf(AT_REST)
    expect(read).toMatchObject({ formId: 'FakeFormId00000000000001', title: 'TempCode proof forms builder', description: 'A made-up form' })
    expect(read.questions).toEqual([
      { title: 'Which dummy colour do you pick?', type: 'choice', options: ['Red', 'Green', 'Blue'], required: true },
      { title: 'Write a made-up word', type: 'text', required: false },
      { title: 'Pick a made-up date', type: 'date', required: false },
      { title: 'Rank the shapes', type: 'other', kind: 'Ranking' }
    ])
  })

  it('reads Settings, the link and the count', () => {
    expect(settingsOf(SETTINGS)).toEqual({ accepting: true, orgOnly: true, recordName: true, onePerPerson: false })
    expect(linkOf(COLLECT)).toBe('https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=FakeFormId00000000000001')
    expect(countOf(screen('[1] text "12 Responses"'))).toBe(12)
    expect(countOf(screen('[1] text "No responses yet"'))).toBe(0)
  })
})

describe('the guard', () => {
  const click = (element: number): ComputerAction => ({ action: 'left_click', element }) as ComputerAction
  const refuses = (op: CarrierOp, s: typeof AT_REST, element: number) => expect(() => guardStep(op, s, click(element)), `${op} ${element}`).toThrow(CarrierRefused)

  it('never presses Send, Copy link or a template card, whatever the operation', () => {
    for (const op of ['make', 'write', 'settings', 'collect', 'audience', 'close'] as const) {
      refuses(op, COLLECT, 6)
      refuses(op, COLLECT, 4)
      refuses(op, AT_REST, 12)
    }
  })

  it("takes the rev and the job a grant must name from the form's row as it stands, never from the grant (review 15)", async () => {
    const { page, carrier, auth } = rig()
    page.add(form())
    await expect(carrier.close(auth('close', { open: false }, { rev: 2 }), 'FakeFormId00000000000001', false)).rejects.toThrow('the form changed since it was authorized')
    const gone = rig(new FakeForms(), null)
    gone.page.add(form())
    await expect(gone.carrier.close(gone.auth('close', { open: false }), 'FakeFormId00000000000001', false)).rejects.toThrow('not one this computer keeps')
    const elsewhere = rig(new FakeForms(), { workspaceId: 'w-other', rev: 3 })
    elsewhere.page.add(form())
    await expect(elsewhere.carrier.close(elsewhere.auth('close', { open: false }), 'FakeFormId00000000000001', false)).rejects.toThrow('authorized for another job')
  })

  it("words a refusal without the page's own words (review 21)", () => {
    const err = (() => {
      try {
        guardStep('collect', COLLECT, click(6))
      } catch (e) {
        return e as Error
      }
      return null
    })()
    expect(err?.message).toBe('The carrier refused a step: that control is one no carrier operation presses. Nothing more was done in Forms.')
  })

  it('keeps each outward toggle to the operation that is that act', () => {
    // Accept responses on, and Anyone can respond, only where collecting or who-can-answer is the act.
    const off = screen('[1] checkbox "Accept responses" unchecked')
    refuses('settings', off, 1)
    refuses('write', off, 1)
    expect(() => guardStep('collect', off, click(1))).not.toThrow()
    refuses('settings', SETTINGS, 2)
    expect(() => guardStep('audience', SETTINGS, click(2))).not.toThrow()
    expect(() => guardStep('settings', SETTINGS, click(6))).not.toThrow()
    refuses('write', AT_REST, 13)
    expect(() => guardStep('collect', AT_REST, click(13))).not.toThrow()
  })

  it('presses no Escape or Return, and types only into fields', () => {
    expect(() => guardStep('write', AT_REST, { action: 'key', element: 4, text: 'Escape' } as ComputerAction)).toThrow(CarrierRefused)
    expect(() => guardStep('write', AT_REST, { action: 'key', element: 4, text: 'Return' } as ComputerAction)).toThrow(CarrierRefused)
    expect(() => guardStep('write', AT_REST, { action: 'type', element: 5, text: 'x' } as ComputerAction)).toThrow(CarrierRefused)
    expect(() => guardStep('write', AT_REST, { action: 'type', element: 4, text: 'x' } as ComputerAction)).not.toThrow()
  })
})

const WS = 'w1'
const settings: MsFormSettings = { accepting: false, orgOnly: true, recordName: true, onePerPerson: true }
const form = (over: Partial<FakeFormState> = {}): FakeFormState => ({
  formId: 'FakeFormId00000000000001',
  title: 'TempCode proof survey',
  description: '',
  questions: [{ title: 'Name', type: 'text', required: true }],
  settings: { ...settings },
  count: 0,
  ...over
})

function rig(page = new FakeForms(), row: { workspaceId: string; rev: number } | null = { workspaceId: WS, rev: 3 }) {
  const carrier = opsCarrier({ computer: page, host: 'env_box', exclusive: (fn) => fn(), workspaceOf: () => row, patience: { mount: 0, made: 0 } })
  const auth = (op: CarrierOp, payload: unknown, o: { formId?: string; rev?: number; by?: 'owner' | 'pillar' } = {}) =>
    authorize({ host: 'env_box', workspaceId: WS, target: { formId: o.formId ?? 'FakeFormId00000000000001' }, op, rev: o.rev ?? 3, by: o.by ?? 'owner', payload })
  return { page, carrier, auth }
}

describe('the authorization', () => {
  it('refuses one for another form, another operation, another rev or another payload', async () => {
    const { page, carrier, auth } = rig()
    page.add(form())
    const before = page.forms.get('FakeFormId00000000000001')!.questions
    const changes = [{ op: 'remove' as const, at: 0 }]
    await expect(carrier.write(auth('write', { changes, before }, { formId: 'FakeFormId00000000000099' }), 'FakeFormId00000000000001', changes, before)).rejects.toThrow('another form')
    await expect(carrier.write(auth('settings', { changes, before }), 'FakeFormId00000000000001', changes, before)).rejects.toThrow(CarrierRefused)
    await expect(carrier.write(auth('write', { changes: [], before }), 'FakeFormId00000000000001', changes, before)).rejects.toThrow('not what was authorized')
    expect(() => auth('collect', {}, { by: 'pillar' })).toThrow(CarrierRefused)
    expect(page.log).toEqual([])
  })
})

describe('the operations', () => {
  it('writes an added question with Required set and its options, then reads it back', async () => {
    const { page, carrier, auth } = rig()
    page.add(form())
    const before = structuredClone(page.forms.get('FakeFormId00000000000001')!.questions)
    const changes = [{ op: 'add' as const, question: { title: 'Which night?', type: 'choice' as const, options: ['Mon', 'Tue', 'Wed'], required: false } }]
    const { read } = await carrier.write(auth('write', { changes, before }), 'FakeFormId00000000000001', changes, before)
    expect(read.questions).toEqual([
      { title: 'Name', type: 'text', required: true },
      { title: 'Which night?', type: 'choice', options: ['Mon', 'Tue', 'Wed'], required: false }
    ])
    // Required was turned off on the new question (Forms copied it on), and no Return or Escape was pressed.
    expect(page.log).toContain('click Required')
    expect(page.log.some((l) => /key (Return|Escape)/.test(l))).toBe(false)
  })

  it('stops on drift and says nothing was changed', async () => {
    const { page, carrier, auth } = rig()
    page.add(form())
    const before = [{ title: 'Full name', type: 'text' as const, required: true }]
    const changes = [{ op: 'remove' as const, at: 0 }]
    const err = await carrier.write(auth('write', { changes, before }), 'FakeFormId00000000000001', changes, before).catch((e) => e)
    expect(err).toBeInstanceOf(CarrierStop)
    expect(err.message).toMatch(/not as it was read .*no change was not done|not as it was read/)
    expect(page.forms.get('FakeFormId00000000000001')!.questions).toHaveLength(1)
  })

  it('an add that does not show stops and says what was done', async () => {
    const { page, carrier, auth } = rig()
    page.add(form())
    page.dropTitles.add('Ghost')
    const before = structuredClone(page.forms.get('FakeFormId00000000000001')!.questions)
    const changes = [
      { op: 'add' as const, question: { title: 'Phone', type: 'text' as const, required: false } },
      { op: 'add' as const, question: { title: 'Ghost', type: 'text' as const, required: false } },
      { op: 'add' as const, question: { title: 'Size', type: 'text' as const, required: false } }
    ]
    const err = await carrier.write(auth('write', { changes, before }), 'FakeFormId00000000000001', changes, before).catch((e) => e)
    expect(err).toBeInstanceOf(CarrierStop)
    expect(err.message).toContain('Did 1 of 3 changes (added "Phone")')
    expect(err.message).toContain('"Ghost"')
    expect(err.read.questions.map((q: { title: string }) => q.title)).toEqual(['Name', 'Phone'])
  })

  it("the make's first step is Accept responses off, and a failure there keeps the form, said as taking answers", async () => {
    const { page, carrier } = rig()
    const makeAuth = (payload: unknown) => authorize({ host: 'env_box', workspaceId: WS, target: { folder: { libraryId: 'lib', path: 'Esports' } }, op: 'make', rev: 0, by: 'owner', payload })
    const ask = { workspaceId: WS, folderUrl: 'https://purdue0.sharepoint.com/sites/RecWell/Shared%20Documents/Forms/AllItems.aspx?id=x', title: 'TempCode proof make', description: '', questions: [{ title: 'Name', type: 'text' as const, required: true }], settings }
    const payload = { title: ask.title, description: '', questions: ask.questions, settings, folder: { libraryId: 'lib', path: 'Esports' } }
    const { read } = await carrier.make(makeAuth(payload), ask)
    expect(read).toMatchObject({ title: 'TempCode proof make', settings: { accepting: false, orgOnly: true, recordName: true, onePerPerson: true } })
    expect(read.questions).toEqual([{ title: 'Name', type: 'text', required: true }])
    const steps = page.log.filter((l) => l.startsWith('click') || l.startsWith('type'))
    expect(steps.slice(0, 4)).toEqual(['click Create or upload', 'click Forms survey', 'click Settings', 'click Options for responses Accept responses'])

    const stuck = new FakeForms()
    stuck.stuck.add('Options for responses Accept responses')
    const err = await rig(stuck).carrier.make(makeAuth(payload), ask).catch((e) => e)
    expect(err).toBeInstanceOf(CarrierStop)
    expect(err.message).toContain('may take answers')
    expect(err.read.settings.accepting).toBe(true)
    expect(err.formId).toMatch(/^FakeFormId/)
    // Nothing after the failed first step: no title, no question.
    expect(stuck.log.some((l) => l.startsWith('type'))).toBe(false)

    // a make that stops after the form exists names the form, so its row is kept (P1: the title step)
    const moved = new FakeForms()
    moved.twoTitles = true
    const late = await rig(moved).carrier.make(makeAuth(payload), ask).catch((e) => e)
    expect(late).toBeInstanceOf(CarrierStop)
    expect(late.message, late.message).toContain("the form title was not on the page")
    expect(late.formId).toMatch(/^FakeFormId/)

    // its window is not closed while Forms still says it is saving (P1: a made form's title was lost that way)
    const slow = new FakeForms()
    slow.saving = 2
    await rig(slow).carrier.make(makeAuth(payload), ask)
    expect(slow.saving).toBeLessThanOrEqual(0)
    const stuckSaving = new FakeForms()
    stuckSaving.neverSaves = true
    const unsaved = await rig(stuckSaving).carrier.make(makeAuth(payload), ask).catch((e) => e)
    expect(unsaved).toBeInstanceOf(CarrierStop)
    expect(unsaved.message).toContain('Forms did not finish saving the last change')
    expect(unsaved.formId).toMatch(/^FakeFormId/)
  })

  it('collects: Accept responses on, the link read from the dialog, nothing sent or copied', async () => {
    const { page, carrier } = rig()
    page.add(form())
    const auth = authorize({ host: 'env_box', workspaceId: WS, target: { formId: 'FakeFormId00000000000001' }, op: 'collect', rev: 3, by: 'act', payload: {} })
    const { read, link } = await carrier.collect(auth, 'FakeFormId00000000000001', settings)
    expect(link).toBe('https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=FakeFormId00000000000001')
    expect(read.settings.accepting).toBe(true)
    expect(page.log.some((l) => /click (Send|Copy link|Shorten URL|Outlook)/.test(l))).toBe(false)
  })
})

describe('the review’s carrier fixes', () => {
  it('an agent’s write stops when the page takes answers, read inside the same run', async () => {
    const { page, carrier, auth } = rig()
    page.add(form({ settings: { ...settings, accepting: true } }))
    const before = structuredClone(page.forms.get('FakeFormId00000000000001')!.questions)
    const changes = [{ op: 'remove' as const, at: 0 }]
    const err = await carrier.write(auth('write', { changes, before }, { by: 'pillar' }), 'FakeFormId00000000000001', changes, before).catch((e) => e)
    expect(err).toBeInstanceOf(CarrierStop)
    expect(err.message).toContain('takes answers now')
    expect(page.forms.get('FakeFormId00000000000001')!.questions).toHaveLength(1)
  })

  it('an agent’s end date on a form taking answers only shortens it', async () => {
    const { shortens } = await import('./ops')
    expect(shortens('12/10/2026', '12/1/2026')).toBe(true)
    expect(shortens(undefined, '12/1/2026')).toBe(true)
    expect(shortens('12/1/2026', '12/10/2026')).toBe(false)
    expect(shortens('12/1/2026', undefined)).toBe(false)
    expect(shortens('12/1/2026', 'soon')).toBe(false)
    const { page, carrier, auth } = rig()
    page.add(form({ settings: { ...settings, accepting: true, endDate: '12/1/2026' } }))
    const later = { endDate: '12/31/2026' }
    const err = await carrier.settings(auth('settings', later, { by: 'pillar' }), 'FakeFormId00000000000001', later).catch((e) => e)
    expect(err).toBeInstanceOf(CarrierStop)
    expect(page.forms.get('FakeFormId00000000000001')!.settings.endDate).toBe('12/1/2026')
  })
})
