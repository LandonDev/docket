import { closeSync, openSync, readSync } from 'node:fs'
import type { OfficeApp, OfficeAppState, OfficeCell } from '@shared/contract-work-office'

/**
 * What carries an Office tool out (docs/agents/work-office.md "Carriers"):
 * the Mac's osascript (mac.ts), Outlook on the web on the box (owa/) and
 * COM on Windows (com/). One interface, so the tools, the held acts and
 * Excel behind the grid never know which. The fake (fake.ts) is an Office in
 * memory for the box's tests.
 *
 * A workbook, document or presentation is named by its key: the full name
 * Office gives it, a path for a local file and a URL for one in OneDrive,
 * SharePoint or Teams.
 */

export interface OfficeFile {
  key: string
  name: string
}

export interface WorkbookInfo extends OfficeFile {
  /** each sheet with its used range: rows and columns from A1 to the last used cell */
  sheets: { name: string; rows: number; columns: number }[]
}

/** A block of cells: each cell's value, its formula ('' for none) and its number format. Rows first. */
export interface RangeGrid {
  values: OfficeCell[][]
  formulas: string[][]
  formats: string[][]
}

export interface SlideText {
  index: number
  texts: string[]
}

export interface MailSummary {
  id: string
  account: string
  from: string
  subject: string
  at: string
  read: boolean
}

export interface MailFull extends MailSummary {
  to: string[]
  cc: string[]
  /** the body as plain text */
  text: string
}

/** A mail to go out. `html` is the body; `replyTo` or `forward` names the mail it answers or passes on. */
export interface MailOut {
  account?: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  html: string
  replyTo?: string
  forward?: string
}

/** Who a mail goes to, by field. */
export interface Recipients {
  to: string[]
  cc: string[]
  bcc: string[]
}

const norm = (xs: readonly string[]): string[] => [...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))].sort()
const FIELD = { to: 'To', cc: 'Cc', bcc: 'Bcc' } as const
const listed = (r: Recipients): string =>
  (['to', 'cc', 'bcc'] as const)
    .filter((k) => norm(r[k]).length)
    .map((k) => `${FIELD[k]} ${norm(r[k]).join(', ')}`)
    .join('; ') || 'nobody'

/**
 * Whether the recipients Outlook built for a reply or forward are exactly the held ones (the hold review's 21.1): a
 * reply goes where the mail's Reply-To says unless told otherwise, so what Outlook made is read back before it goes.
 * Null when they match, field by field, case aside; else the refusal in words. The Mac's mail script says the same.
 */
export function recipientsOff(what: 'reply' | 'forward', held: Recipients, built: Recipients): string | null {
  const same = (['to', 'cc', 'bcc'] as const).every((k) => norm(held[k]).join('\n') === norm(built[k]).join('\n'))
  return same ? null : `Outlook made this ${what} for ${listed(built)}, not ${listed(held)} as held, so nothing was sent.`
}

export interface CalendarEvent {
  id: string
  subject: string
  start: string
  end: string
  location: string
  organizer: string
  attendees: string[]
  /** his answer to an invitation; '' when it is his own */
  response: string
}

/** One event by its Outlook id, read from his calendar a year either side of now; null when none has it. */
export async function eventById(carrier: Pick<OfficeCarrier, 'events'>, id: string): Promise<CalendarEvent | null> {
  const now = Date.now()
  const all = await carrier.events(new Date(now - 366 * 864e5).toISOString(), new Date(now + 366 * 864e5).toISOString())
  return all.find((e) => e.id === id) ?? null
}

export interface EventOut {
  account?: string
  subject: string
  start: string
  end: string
  location?: string
  body?: string
  attendees: string[]
}

export type EventAnswer = 'accept' | 'decline' | 'tentative'

/** The apps that render a file of theirs (docs/agents/work-office.md "Office as a renderer"). */
export type RenderApp = 'word' | 'excel' | 'powerpoint'

/** One render: a copy of his file, drawn by its own app. */
export interface RenderAsk {
  app: RenderApp
  /** a PDF of the whole file; one slide as a PNG; the deck as a video (PowerPoint's alone) */
  to: 'pdf' | 'png' | 'mp4'
  /** a copy in the job's own folder on this host: the carrier opens it read only, never the file he has open */
  input: string
  /** where the result goes, on this host */
  output: string
  /** a PNG's slide, from 1, and its width in pixels */
  slide?: number
  width?: number
  /** a video's seconds on each slide, and its height in pixels */
  seconds?: number
  height?: number
  /** may start the app, hidden, when none runs: the box's Windows VM, which is nobody's desktop. Never on his Mac or PC. */
  start?: boolean
  signal?: AbortSignal
}

const RENDER_APP_NAME: Record<RenderApp, string> = { word: 'Word', excel: 'Excel', powerpoint: 'PowerPoint' }
/** What a render of a password-locked file answers, on every carrier, before any app opens it. */
export const lockedWords = (app: RenderApp): string => `This file is locked with a password; open it in ${RENDER_APP_NAME[app]} to check it.`
const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
/**
 * Whether a .docx, .xlsx or .pptx is locked with a password: such a file is an OLE compound file (its first 8 bytes
 * D0 CF 11 E0 A1 B1 1A E1) where the format is a zip. Its app would ask for the password in a dialog inside Open,
 * and in the Windows VM every Office call would wait behind it.
 */
export function isPasswordLocked(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const head = Buffer.alloc(8)
    return readSync(fd, head, 0, 8, 0) === 8 && head.equals(CFB)
  } finally {
    closeSync(fd)
  }
}

/** What the app said of what it drew: a PDF's pages as the app counts them, a picture's size, a video's length. */
export interface RenderDone {
  pages?: number
  width?: number
  height?: number
  seconds?: number
}

/** A change to a document: text put at its start or end, or every match of `find` replaced. */
export type DocEdit = { insert: string; at: 'start' | 'end' } | { find: string; replace: string }

export interface OfficeCarrier {
  readonly kind: 'mac' | 'owa' | 'com' | 'fake' | 'addin'
  apps(): Promise<OfficeAppState[]>
  /** Why this host's Outlook cannot carry mail or invitations at all, in words the status shows; null or absent: nothing known against it. Must not start Outlook. */
  outlookProblem?(): Promise<string | null>

  workbooks(): Promise<WorkbookInfo[]>
  /** `address` is A1 without a sheet (B2:D9) */
  readRange(book: string, sheet: string, address: string): Promise<RangeGrid>
  /** writes the block at `address`, whose size is the grid's; a string starting with `=` is a formula, null empties a cell */
  writeRange(book: string, sheet: string, address: string, grid: OfficeCell[][]): Promise<void>

  documents(): Promise<OfficeFile[]>
  /** the document's paragraphs as text */
  readDocument(doc: string): Promise<string[]>
  /** `tracked`: made with Track Changes on, so it waits as a revision he accepts or rejects. Answers how many places changed. */
  editDocument(doc: string, edit: DocEdit, tracked: boolean): Promise<number>

  presentations(): Promise<OfficeFile[]>
  readSlides(pres: string): Promise<SlideText[]>
  /** answers how many text runs changed */
  replaceSlideText(pres: string, find: string, replace: string): Promise<number>

  /** the addresses of Outlook's mail accounts */
  accounts(): Promise<string[]>
  listMail(q: { folder: 'inbox' | 'sent' | 'drafts'; limit: number; query?: string }): Promise<MailSummary[]>
  readMail(id: string): Promise<MailFull>
  /** a draft left in Outlook's Drafts for him; answers its id */
  draftMail(m: MailOut): Promise<string>
  /** only ever from a held act's execute, after his press */
  sendMail(m: MailOut): Promise<{ id: string | null }>
  events(from: string, to: string): Promise<CalendarEvent[]>
  /** only from a held act's execute, or a plain hold on his own calendar */
  createEvent(e: EventOut): Promise<string>
  /** only from a held act's execute */
  answerEvent(id: string, answer: EventAnswer, comment?: string): Promise<void>
  /** the event whose calendar UID is `uid` (Outlook's iCalUId), from a week back to half a year on; null if none */
  eventByUid(uid: string): Promise<string | null>

  /** brings the app forward with the file (the switch) */
  open(app: OfficeApp, ref: { kind: 'path'; path: string } | { kind: 'url'; url: string }): Promise<void>

  /** A carrier the app itself tells of changes (Windows' Excel): `address` changed on `sheet`, or, with `sheet` '', a co-author's edits were merged somewhere in the book. Returns its off. */
  changes?(fn: (book: string, sheet: string, address: string) => void): () => void
  /** Let go of what the carrier keeps running (Windows' helper process) when the module stops. */
  stop?(): void

  /** Office as a renderer: the app draws a copy of a file (render.ts); absent where the carrier cannot. */
  render?(ask: RenderAsk): Promise<RenderDone>
}

/** A refusal in words the agent and the screen show as they are. */
export class OfficeError extends Error {
  constructor(
    message: string,
    /**
     * `busy`: the app turned the step away for now (a dialog open, a cell in edit); that step was not done, and trying again may work.
     * `refused`: the app would not make what was asked (a mail, an invitation) before anything was sent.
     * `failed`: anything else, a send among them that may or may not have gone.
     */
    readonly code: 'not-installed' | 'not-running' | 'not-allowed' | 'needs-consent' | 'not-found' | 'busy' | 'refused' | 'failed' = 'failed'
  ) {
    super(message)
  }
}

export const APP_NAMES: Record<OfficeApp, string> = {
  excel: 'Microsoft Excel',
  word: 'Microsoft Word',
  powerpoint: 'Microsoft PowerPoint',
  outlook: 'Microsoft Outlook'
}
