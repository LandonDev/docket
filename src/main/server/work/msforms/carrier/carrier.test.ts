import { describe, expect, it } from 'vitest'
import { screenOfObservation } from '@shared/computer/outward'
import type { ComputerAction } from '@shared/computer/protocol'
import type { MsFormSettings } from '@shared/work/msforms'
import { FakeForms, type FakeFormState } from './fakePage'
import { guardStep } from './guard'
import { opsCarrier } from './ops'
import { countOf, formOf, linkOf, settingsOf } from './read'
import { Page } from './steps'
import { authorize, CarrierGone, CarrierRefused, CarrierStop, makePayload, pullPayload, readPayload, settingsPayload, type CarrierOp, type FormRead } from './types'

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

  it("reads a form with no answers as 0, in the Responses view's own words (P5)", () => {
    expect(countOf(screen(`
[1] window "Untitled form"
  [2] text "No responses yet, get your data now."
  [3] button "Share to collect responses"
`))).toBe(0)
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

  it("lets a pull press Continue only in the dialog that says it opens Excel for the web (P1)", () => {
    const dialog = screen('[1] dialog\n  [2] heading "View your responses in Excel for the web"\n  [3] button "Close"\n  [4] button "Continue"')
    expect(() => guardStep('pull', dialog, click(4))).not.toThrow()
    refuses('pull', screen('[1] dialog\n  [2] heading "Share this form"\n  [4] button "Continue"'), 4)
    refuses('pull', screen('[4] button "Continue"'), 4)
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

const FOLDER_URL = 'https://purdue0.sharepoint.com/sites/RecWell/Shared%20Documents/Forms/AllItems.aspx?id=x'
const PULL = { siteUrl: 'https://purdue0.sharepoint.com/sites/RecWell', folderServerPath: '/sites/RecWell/Shared Documents/Esports', uniqueId: 'fce429aa-7efc-4bac-93c5-6219e85183f4', name: 'TempCode proof survey.xlsx' }
type Row = { workspaceId: string; rev: number; pull?: typeof PULL | null }

function rig(page = new FakeForms(), row: Row | null = { workspaceId: WS, rev: 3, pull: PULL }) {
  const carrier = opsCarrier({
    computer: page,
    host: 'env_box',
    exclusive: (fn) => fn(),
    rowOf: () => (row ? { pull: null, ...row } : null),
    // the host's own page for the folder: only the job's own library folder has one
    folderOf: (workspaceId, folder) => (workspaceId === WS && folder.libraryId === 'lib' && folder.path === 'Esports' ? { url: FOLDER_URL } : null),
    patience: { mount: 0, made: 0 }
  })
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

  it("writes a Choice question's options exactly as asked on a page that redraws a committed option and opens a question above on Add new question (P5)", async () => {
    const page = new FakeForms()
    page.redraws = true
    page.insertsBetween = true
    const { carrier, auth } = rig(page)
    page.add(form())
    const before = structuredClone(page.forms.get('FakeFormId00000000000001')!.questions)
    const changes = [{ op: 'add' as const, question: { title: 'Which size?', type: 'choice' as const, options: ['Small', 'Medium', 'Large'], required: false } }]
    const { read } = await carrier.write(auth('write', { changes, before }), 'FakeFormId00000000000001', changes, before)
    expect(read.questions).toEqual([
      { title: 'Name', type: 'text', required: true },
      { title: 'Which size?', type: 'choice', options: ['Small', 'Medium', 'Large'], required: false }
    ])
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
    const ask = { workspaceId: WS, folder: { libraryId: 'lib', path: 'Esports' }, folderUrl: FOLDER_URL, title: 'TempCode proof make', description: '', questions: [{ title: 'Name', type: 'text' as const, required: true }], settings }
    const payload = makePayload(ask)
    const { read } = await carrier.make(makeAuth(payload), ask)
    expect(read).toMatchObject({ title: 'TempCode proof make', settings: { accepting: false, orgOnly: true, recordName: true, onePerPerson: true } })
    expect(read.questions).toEqual([{ title: 'Name', type: 'text', required: true }])
    const steps = page.log.filter((l) => l.startsWith('click') || l.startsWith('type'))
    expect(steps.slice(0, 4)).toEqual(['click Create or upload', 'click Forms survey', 'click Settings', 'click Options for responses Accept responses'])

    // New → Form (no questions): Settings is opened once, and the read keeps what the panel read back
    const bare = new FakeForms()
    const bareAsk = { ...ask, questions: [] }
    const { read: bareRead } = await rig(bare).carrier.make(makeAuth({ ...payload, questions: [] }), bareAsk)
    expect(bareRead).toMatchObject({ title: 'TempCode proof make', questions: [], settings: { accepting: false, orgOnly: true, recordName: true, onePerPerson: true } })
    expect(bare.log.filter((l) => l === 'click Settings')).toHaveLength(1)

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

    // a browser stopped part way (the box browser's memory cap, P5) still names the form, said by what was done
    for (const [step, mayTake] of [['Settings', true], ['title field', false]] as const) {
      const dies = new FakeForms()
      dies.diesAfter = step
      const gone = await rig(dies).carrier.make(makeAuth(payload), ask).catch((e) => e)
      expect(gone, `dies after ${step}`).toBeInstanceOf(CarrierStop)
      expect(gone.formId).toMatch(/^FakeFormId/)
      if (mayTake) expect(gone.message).toContain('may take answers')
      else expect(gone.message).toBe('made the form with Accept responses off; set who can answer; then the box browser stopped before the make finished. The form is in Forms as far as it got.')
      if (!mayTake) expect(gone.read.settings.accepting).toBe(false)
    }

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

  it("names a form Forms says no longer exists as gone, apart from any other stop (P5)", async () => {
    const { page, carrier, auth } = rig()
    page.add(form())
    page.gone.add('FakeFormId00000000000001')
    const err = await carrier.read(auth('read', readPayload('FakeFormId00000000000001')), 'FakeFormId00000000000001').catch((e) => e)
    expect(err).toBeInstanceOf(CarrierGone)
    expect(err).not.toBeInstanceOf(CarrierStop)
    expect(err.formId).toBe('FakeFormId00000000000001')
  })

  it('collects: Accept responses on, the link read from the dialog, nothing sent or copied', async () => {
    const { page, carrier } = rig()
    page.add(form())
    const auth = authorize({ host: 'env_box', workspaceId: WS, target: { formId: 'FakeFormId00000000000001' }, op: 'collect', rev: 3, by: 'act', payload: settingsPayload(settings) })
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

describe('each grant binds the call that runs (review 15)', () => {
  const ID = 'FakeFormId00000000000001'
  const other: MsFormSettings = { ...settings, orgOnly: false }

  it('a read takes a read grant of its own, at the row\'s rev, and nothing else', async () => {
    const { page, carrier, auth } = rig()
    page.add(form())
    await expect(carrier.read(auth('collect', settingsPayload(settings)), ID)).rejects.toThrow('authorized to collect, not read')
    await expect(carrier.read(auth('settings', { read: ID }, { by: 'pillar' }), ID)).rejects.toThrow(CarrierRefused)
    await expect(carrier.read(auth('read', readPayload(ID), { rev: 2 }), ID)).rejects.toThrow('the form changed since it was authorized')
    await expect(carrier.read(auth('read', readPayload('FakeFormId00000000000002')), ID)).rejects.toThrow('not what was authorized')
    expect(page.log).toEqual([])
    const read: FormRead = await carrier.read(auth('read', readPayload(ID), { by: 'pillar' }), ID)
    expect(read.formId).toBe(ID)
  })

  it('collect and audience run only the settings their grant names, at the row\'s rev', async () => {
    const { page, carrier, auth } = rig()
    page.add(form())
    await expect(carrier.collect(auth('collect', settingsPayload(other)), ID, settings)).rejects.toThrow('not what was authorized')
    await expect(carrier.collect(auth('collect', settingsPayload(settings), { rev: 2 }), ID, settings)).rejects.toThrow('changed since')
    await expect(carrier.audience(auth('audience', settingsPayload(settings)), ID, other)).rejects.toThrow('not what was authorized')
    await expect(carrier.audience(auth('collect', settingsPayload(other)), ID, other)).rejects.toThrow('not audience')
    expect(page.log).toEqual([])
    await carrier.audience(auth('audience', settingsPayload(other)), ID, other)
    expect(page.forms.get(ID)!.settings.orgOnly).toBe(false)
  })

  it('a make opens only the page the host makes for the folder it names, and its grant binds that page', async () => {
    const page = new FakeForms()
    const { carrier } = rig(page)
    const ask = { workspaceId: WS, folder: { libraryId: 'lib', path: 'Esports' }, folderUrl: FOLDER_URL, title: 'TempCode proof make', description: '', questions: [], settings }
    const grant = (payload: unknown, folder = ask.folder) => authorize({ host: 'env_box', workspaceId: WS, target: { folder }, op: 'make', rev: 0, by: 'owner', payload })
    // another folder than the grant names, a page the host did not make, a grant without the page, another job's folder
    await expect(carrier.make(grant(makePayload(ask), { libraryId: 'lib', path: 'Other' }), ask)).rejects.toThrow('another form')
    const elsewhere = { ...ask, folderUrl: 'https://evil.sharepoint.com/sites/X/Shared%20Documents/Forms/AllItems.aspx' }
    await expect(carrier.make(grant(makePayload(elsewhere)), elsewhere)).rejects.toThrow(CarrierRefused)
    const { folderUrl: _url, ...noUrl } = makePayload(ask)
    await expect(carrier.make(grant(noUrl), ask)).rejects.toThrow('not what was authorized')
    const otherJob = { ...ask, workspaceId: 'w2' }
    await expect(carrier.make(authorize({ host: 'env_box', workspaceId: 'w2', target: { folder: ask.folder }, op: 'make', rev: 0, by: 'owner', payload: makePayload(otherJob) }), otherJob)).rejects.toThrow(CarrierRefused)
    expect(page.log).toEqual([])
    await carrier.make(grant(makePayload(ask)), ask)
    expect(page.log[0]).toBe(`open ${FOLDER_URL}`)
  })

  it("a pull binds the workbook's own id and name, as the form's row names them", async () => {
    const { page, carrier, auth } = rig()
    page.add(form({ count: 1 }))
    const ask = { ...PULL, lastModified: null }
    // a grant made without the workbook's id and name, and a call for another workbook than the row's
    await expect(carrier.pull(auth('pull', { formId: ID, siteUrl: PULL.siteUrl, folder: PULL.folderServerPath }), ID, ask)).rejects.toThrow('not what was authorized')
    const another = { ...ask, uniqueId: '00000000-0000-0000-0000-000000000000' }
    await expect(carrier.pull(auth('pull', pullPayload(ID, another)), ID, another)).rejects.toThrow(CarrierRefused)
    const renamed = { ...ask, name: 'Other.xlsx' }
    await expect(carrier.pull(auth('pull', pullPayload(ID, renamed)), ID, renamed)).rejects.toThrow(CarrierRefused)
    expect(page.log).toEqual([])
  })
})

describe('the page an operation drives is the one its open made (review 16)', () => {
  const ID = 'FakeFormId00000000000001'
  const stub = (addresses: string[]) => {
    let at = 0
    return {
      read: async () => screen(`[1] window "Form"\n  [2] input "Address and search bar" = "${addresses[Math.min(at++, addresses.length - 1)]}"\n  [3] button "Settings"`),
      act: async () => ({ ok: true }),
      wait: async () => undefined
    } as never
  }

  it('stops at a read that shows another form, or no form id at all', async () => {
    const builder = (id: string) => `https://forms.cloud.microsoft/Pages/DesignPageV2.aspx?subpage=design&id=${id}`
    await expect(new Page(stub([builder(ID)]), 't:A', 'write', ID).read()).resolves.toBeTruthy()
    await expect(new Page(stub([builder('FakeFormId00000000000002')]), 't:A', 'write', ID).read()).rejects.toThrow('another form')
    await expect(new Page(stub(['https://forms.cloud.microsoft/Pages/DesignPageV2.aspx']), 't:A', 'write', ID).read()).rejects.toThrow('another form')
    // a page that moved to another form between two steps stops before the second
    const moving = new Page(stub([builder(ID), builder('FakeFormId00000000000002')]), 't:A', 'write', ID)
    await moving.read()
    await expect(moving.act((x) => [click(x, 3)], 'Settings')).rejects.toThrow('another form')
  })

  it("a make takes its form only from the page Forms survey opened from the folder's own page, never another new Forms page", async () => {
    const page = new FakeForms()
    // another Forms page opens at the same moment, from another page (a thread's SharePoint tab), after the make's own
    page.stray = true
    const { carrier } = rig(page)
    const ask = { workspaceId: WS, folder: { libraryId: 'lib', path: 'Esports' }, folderUrl: FOLDER_URL, title: 'TempCode proof make', description: '', questions: [], settings }
    const { read } = await carrier.make(authorize({ host: 'env_box', workspaceId: WS, target: { folder: ask.folder }, op: 'make', rev: 0, by: 'owner', payload: makePayload(ask) }), ask)
    expect(read.formId).toBe('FakeFormId00000000000001')
    expect(page.forms.get(page.strayId!)!.title).toBe('Untitled form')
    expect(page.forms.get(page.strayId!)!.settings.accepting).toBe(true)
  })

  it('a make whose new page names no opener takes no form', async () => {
    const page = new FakeForms()
    page.noOpener = true
    const { carrier } = rig(page)
    const ask = { workspaceId: WS, folder: { libraryId: 'lib', path: 'Esports' }, folderUrl: FOLDER_URL, title: 'TempCode proof make', description: '', questions: [], settings }
    const err = await carrier.make(authorize({ host: 'env_box', workspaceId: WS, target: { folder: ask.folder }, op: 'make', rev: 0, by: 'owner', payload: makePayload(ask) }), ask).catch((e) => e)
    expect(err).toBeInstanceOf(CarrierStop)
    expect(err.message).toContain('did not show the new form')
  })
})

const click = (s: ReturnType<typeof screen>, index: number): ComputerAction => {
  void s
  return { action: 'left_click', element: index } as ComputerAction
}
