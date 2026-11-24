import { createHash } from 'node:crypto'
import type { MsAnyQuestion, MsChange, MsFormSettings, MsQuestion } from '@shared/work/msforms'

/**
 * The carrier's terms (docs/agents/work-msforms.md "The carrier"): the only
 * hands on Microsoft Forms. Each operation is a fixed program on the box
 * browser, and each runs only with an authorization bound to the host, the
 * workspace, the form (or the folder for `make`), the operation, its payload
 * and the form's `rev`. Nothing a model writes reaches a click.
 */

export const CARRIER_OPS = ['make', 'write', 'settings', 'collect', 'audience', 'close', 'count', 'pull', 'prefill'] as const
export type CarrierOp = (typeof CARRIER_OPS)[number]

/** Who granted the run: his press through the owner RPC, a claimed held act's execute, the pillar under "Agent writes" on a draft, or the poller. */
export type CarrierBy = 'owner' | 'act' | 'pillar' | 'poller'

/** Which operations each grantor may authorize. The pillar writes only a draft's questions and settings, sets a closing end date, and closes (never reopens); the poller only reads. */
export const OPS_BY: Record<CarrierBy, readonly CarrierOp[]> = {
  owner: ['make', 'write', 'settings', 'collect', 'audience', 'close', 'count', 'pull', 'prefill'],
  act: ['make', 'write', 'settings', 'collect', 'audience', 'close'],
  pillar: ['write', 'settings', 'close'],
  poller: ['count', 'pull']
}

export type CarrierTarget = { formId: string } | { folder: { libraryId: string; path: string } }

export interface CarrierAuth {
  host: string
  workspaceId: string
  target: CarrierTarget
  op: CarrierOp
  /** sha256 of the payload as the grantor saw it */
  digest: string
  rev: number
  by: CarrierBy
}

/** A stable JSON of a value: keys in order, so the same payload always digests the same. */
export function stable(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
}

export const digestOf = (payload: unknown): string => createHash('sha256').update(stable(payload)).digest('hex')

export class CarrierRefused extends Error {}

/** Makes an authorization; refuses an operation its grantor may not grant. */
export function authorize(o: Omit<CarrierAuth, 'digest'> & { payload: unknown }): CarrierAuth {
  if (!OPS_BY[o.by].includes(o.op)) throw new CarrierRefused(`The carrier does not run ${o.op} for ${o.by}.`)
  const { payload, ...rest } = o
  return { ...rest, digest: digestOf(payload) }
}

const sameTarget = (a: CarrierTarget, b: CarrierTarget): boolean =>
  'formId' in a ? 'formId' in b && a.formId === b.formId : 'folder' in b && a.folder.libraryId === b.folder.libraryId && a.folder.path === b.folder.path

/**
 * The check every operation makes before its first step: the authorization
 * names this host, this workspace, this form or folder, this operation, this
 * exact payload and this rev, from a grantor allowed it.
 */
export function checkAuth(auth: CarrierAuth | null | undefined, want: { host: string; workspaceId: string; target: CarrierTarget; op: CarrierOp; payload: unknown; rev: number }): void {
  const no = (why: string): never => {
    throw new CarrierRefused(`The carrier refused: ${why}. Nothing was done in Forms.`)
  }
  if (!auth) return no('no one authorized this')
  if (!OPS_BY[auth.by]?.includes(auth.op)) no(`${auth.by} may not authorize ${auth.op}`)
  if (auth.op !== want.op) no(`it was authorized to ${auth.op}, not ${want.op}`)
  if (auth.host !== want.host) no('it was authorized on another computer')
  if (auth.workspaceId !== want.workspaceId) no('it was authorized for another job')
  if (!sameTarget(auth.target, want.target)) no('it was authorized for another form')
  if (auth.rev !== want.rev) no('the form changed since it was authorized')
  if (auth.digest !== digestOf(want.payload)) no('what it was asked to do is not what was authorized')
}

/** A fresh read of a form's page, from its accessibility tree (read.ts `formOf`). */
export interface FormRead {
  formId: string
  title: string
  description: string
  questions: MsAnyQuestion[]
  settings: MsFormSettings
  /** the Responses view's count, when that view was read */
  count: number | null
  /** the account the page says is signed in */
  signedInAs: string | null
  /** the response link, when the Collect responses dialog was read */
  link: string | null
}

/** An operation that stopped part way: what it had done, in a sentence, and the page as it stood. */
export class CarrierStop extends Error {
  constructor(
    message: string,
    readonly read: FormRead | null,
    readonly formId: string | null = read?.formId ?? null
  ) {
    super(message)
  }
}

/** The page asked for Microsoft's sign-in: Connections reads "Needs you" until a pass gets through. */
export class CarrierSignIn extends Error {
  constructor() {
    super('Microsoft asked for a sign-in in the box browser. Sign in there, then try again.')
  }
}

/** The box browser is his for now, or another carrier run holds it. */
export class CarrierBusy extends Error {}

export interface MakeAsk {
  /** the job the form is made for: the authorization must name it */
  workspaceId: string
  /** the folder's SharePoint page (the library's web address and the folder) */
  folderUrl: string
  title: string
  description: string
  questions: MsQuestion[]
  settings: MsFormSettings
}

/** Where the workbook is, as the place check passes it. */
export interface PulledWorkbook {
  uniqueId: string
  parentId: string
  /** the server-relative path SharePoint answers for the file */
  serverPath: string
  name: string
}

export interface PullAsk {
  siteUrl: string
  /** the folder's server-relative path, which the workbook's parent must be */
  folderServerPath: string
  /** known once the first pull stored it */
  uniqueId: string | null
  /** the workbook's name in the folder, for the first pull: the form's title then */
  name: string
  /** what the last read saw, so a count unchanged with rows cached stops early */
  lastModified: string | null
}

/** The operations, each with its authorization. A carrier for a test fakes these; carrier/ops.ts runs them on the box browser. */
export interface MsCarrier {
  make(auth: CarrierAuth, ask: MakeAsk): Promise<{ read: FormRead }>
  read(auth: CarrierAuth, formId: string): Promise<FormRead>
  write(auth: CarrierAuth, formId: string, changes: readonly MsChange[], before: readonly MsAnyQuestion[]): Promise<{ read: FormRead }>
  settings(auth: CarrierAuth, formId: string, patch: Partial<MsFormSettings>): Promise<{ read: FormRead }>
  collect(auth: CarrierAuth, formId: string, settings: MsFormSettings): Promise<{ read: FormRead; link: string }>
  audience(auth: CarrierAuth, formId: string, settings: MsFormSettings): Promise<{ read: FormRead }>
  close(auth: CarrierAuth, formId: string, open: boolean): Promise<{ read: FormRead }>
  count(auth: CarrierAuth, formId: string): Promise<{ count: number; read: FormRead }>
  /** presses Open results in Excel (and its first-use Continue), then reads the workbook's bytes from the site page */
  pull(auth: CarrierAuth, formId: string, ask: PullAsk): Promise<{ workbook: PulledWorkbook; bytes: Uint8Array; modified: string } | { unchanged: true }>
  prefill(auth: CarrierAuth, formId: string, values: Record<string, string>): Promise<{ link: string }>
}

let carrier: MsCarrier | null = null
/** Set once at boot on a host with the box browser (carrier/wire.ts); null takes it back. */
export function configureMsCarrier(next: MsCarrier | null): void {
  carrier = next
}
export const msCarrier = (): MsCarrier | null => carrier

export const NO_CARRIER = 'Microsoft forms are made and read from the box browser, and this computer has none.'
