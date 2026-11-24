import type { TeamsLibrary } from '@shared/contract-work-office'
import { applyChange, MSFORM_NEW_SETTINGS, type MsAnyQuestion, type MsChange, type MsFormSettings } from '@shared/work/msforms'
import { CarrierStop, checkAuth, type CarrierAuth, type CarrierOp, type FormRead, type MakeAsk, type MsCarrier, type PullAsk } from './carrier/types'

/**
 * A carrier for tests (no browser): forms kept in memory as Forms would keep
 * them, every operation checking its authorization as the real one does. Its
 * `calls` say what ran, and `stopAt` makes an operation stop part way.
 */

export const TEST_LIBRARY: TeamsLibrary = {
  id: 'box~recwell',
  host: 'env_test',
  path: 'C:\\Users\\tcuser\\purdue.edu\\RecWell - Documents',
  team: 'RecWell',
  library: 'Documents',
  tenant: 'Purdue University',
  kind: 'channels',
  channels: ['Esports'],
  web: 'https://purdue0.sharepoint.com/sites/RecWell/Shared Documents/',
  found: true,
  vm: true
}

export const FORM_A = 'Ob0wQVN8nEGx5YdY1tY_IQaWFXVrVqJAiq2zrvrFVrNURDVET1gyWlpLNkJXOUsyWEJXNFlKMzMxVC4u'

interface FakeForm {
  formId: string
  title: string
  description: string
  questions: MsAnyQuestion[]
  settings: MsFormSettings
  count: number
}

export class FakeCarrier implements MsCarrier {
  readonly forms = new Map<string, FakeForm>()
  readonly calls: { op: CarrierOp | 'read'; formId: string | null; by: string }[] = []
  /** the next op of this name stops with this sentence after its first step */
  stopAt: Partial<Record<CarrierOp, string>> = {}
  next = 0
  host = 'env_test'
  /** the workspace a test expects; the carrier checks authorizations against it */
  constructor(readonly workspaceId: string) {}

  private form(formId: string): FakeForm {
    const f = this.forms.get(formId)
    if (!f) throw new Error('no such form')
    return f
  }
  private readOf(f: FakeForm, link: string | null = null): FormRead {
    return { formId: f.formId, title: f.title, description: f.description, questions: structuredClone(f.questions), settings: { ...f.settings }, count: f.count, signedInAs: 'lphale@purdue.edu', link }
  }
  private check(auth: CarrierAuth, op: CarrierOp, formId: string, payload: unknown): void {
    checkAuth(auth, { host: this.host, workspaceId: this.workspaceId, target: { formId }, op, payload, rev: auth.rev })
  }

  async make(auth: CarrierAuth, ask: MakeAsk) {
    this.calls.push({ op: 'make', formId: null, by: auth.by })
    const formId = `${FORM_A.slice(0, 40)}${String(++this.next).padStart(4, '0')}`
    const f: FakeForm = { formId, title: 'Untitled form', description: '', questions: [], settings: { ...MSFORM_NEW_SETTINGS, accepting: true, onePerPerson: false }, count: 0 }
    this.forms.set(formId, f)
    // The first step: Accept responses off.
    if (this.stopAt.make === 'accepting') {
      delete this.stopAt.make
      throw new CarrierStop('The form was made but may take answers until Accept responses is off. Open it and turn that off, or delete it.', this.readOf(f))
    }
    f.title = ask.title
    f.description = ask.description
    f.questions = [...ask.questions]
    f.settings = { ...ask.settings, accepting: false }
    return { read: this.readOf(f) }
  }
  async read(auth: CarrierAuth, formId: string) {
    this.calls.push({ op: 'read', formId, by: auth.by })
    if (!('formId' in auth.target) || auth.target.formId !== formId) throw new Error('read of another form')
    return this.readOf(this.form(formId))
  }
  async write(auth: CarrierAuth, formId: string, changes: readonly MsChange[], before: readonly MsAnyQuestion[]) {
    this.check(auth, 'write', formId, { changes, before })
    this.calls.push({ op: 'write', formId, by: auth.by })
    const f = this.form(formId)
    let done = 0
    for (const c of changes) {
      if (this.stopAt.write && done === 1) {
        const words = this.stopAt.write
        delete this.stopAt.write
        throw new CarrierStop(words, this.readOf(f))
      }
      f.questions = applyChange(f.questions, c)
      done++
    }
    return { read: this.readOf(f) }
  }
  async settings(auth: CarrierAuth, formId: string, patch: Partial<MsFormSettings>) {
    this.check(auth, 'settings', formId, patch)
    this.calls.push({ op: 'settings', formId, by: auth.by })
    const f = this.form(formId)
    f.settings = { ...f.settings, ...patch }
    return { read: this.readOf(f) }
  }
  async collect(auth: CarrierAuth, formId: string, settings: MsFormSettings) {
    this.calls.push({ op: 'collect', formId, by: auth.by })
    const f = this.form(formId)
    f.settings = { ...settings, accepting: true }
    const link = `https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=${formId}`
    return { read: this.readOf(f, link), link }
  }
  async audience(auth: CarrierAuth, formId: string, settings: MsFormSettings) {
    this.calls.push({ op: 'audience', formId, by: auth.by })
    const f = this.form(formId)
    f.settings = { ...settings }
    return { read: this.readOf(f) }
  }
  async close(auth: CarrierAuth, formId: string, open: boolean) {
    this.check(auth, 'close', formId, { open })
    this.calls.push({ op: 'close', formId, by: auth.by })
    const f = this.form(formId)
    f.settings.accepting = open
    return { read: this.readOf(f) }
  }
  /** the next counts throw this */
  countThrows: Error | null = null
  async count(auth: CarrierAuth, formId: string) {
    this.check(auth, 'count', formId, { formId })
    this.calls.push({ op: 'count', formId, by: auth.by })
    if (this.countThrows) throw this.countThrows
    const f = this.form(formId)
    return { count: f.count, read: this.readOf(f) }
  }
  pullBytes: Uint8Array | null = null
  /** the next pulls throw this (a timeout, a stop, a sign-in) */
  pullThrows: Error | null = null
  /** where the workbook is said to be: a test moves it */
  pullPath = '/sites/RecWell/Shared Documents/Esports/x.xlsx'
  /** what each pull was asked */
  asks: PullAsk[] = []
  async pull(auth: CarrierAuth, formId: string, ask: PullAsk) {
    this.check(auth, 'pull', formId, { formId, siteUrl: ask.siteUrl, folder: ask.folderServerPath })
    this.calls.push({ op: 'pull', formId, by: auth.by })
    this.asks.push(ask)
    if (this.pullThrows) throw this.pullThrows
    if (!this.pullBytes) return { unchanged: true as const }
    return { workbook: { uniqueId: 'fce429aa-7efc-4bac-93c5-6219e85183f4', parentId: 'parent-1', serverPath: this.pullPath, name: this.pullPath.split('/').pop()! }, bytes: this.pullBytes, modified: '2026-11-24T17:22:33Z' }
  }
  async prefill(auth: CarrierAuth, formId: string, values: Record<string, string>) {
    this.calls.push({ op: 'prefill', formId, by: auth.by })
    const q = Object.entries(values)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    return { link: `https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=${formId}&${q}` }
  }
}
