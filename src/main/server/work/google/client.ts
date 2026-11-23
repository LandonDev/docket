/**
 * Google's REST APIs (Drive, Docs, Sheets, Slides), reached with the
 * short-lived `drive.file` access tokens LifeOS's worker mints
 * (`POST /google/token`, M24): TempCode holds no Google client of its own and
 * no refresh token, ever. A token lives in this process's memory until a
 * minute before it ends, and is asked for again after a 401
 * (docs/agents/work-google.md "Tokens").
 */

export const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file'

export const GOOGLE_BASES = {
  drive: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
  docs: 'https://docs.googleapis.com/v1',
  sheets: 'https://sheets.googleapis.com/v4',
  slides: 'https://slides.googleapis.com/v1'
} as const

export type GoogleErrorCode = 'needs-consent' | 'no-account' | 'signed-out' | 'too-wide' | 'not-found' | 'refused' | 'conflict' | 'bad-request' | 'unreachable'

/** A refusal in words a screen can show; `code` for code that must tell them apart. */
export class GoogleError extends Error {
  constructor(
    message: string,
    readonly code: GoogleErrorCode
  ) {
    super(message)
  }
}

export interface TokenDeps {
  fetch: typeof fetch
  /** LifeOS's `/google/token` on its MCP listener */
  tokenUrl: string
  /** the owner's LifeOS sign-in (`ctx.lifeos.jwt`) */
  jwt(): Promise<string>
  now?: () => number
}

/** The token route's address, beside LifeOS's MCP endpoint. */
export const tokenUrlOf = (mcpUrl: string): string => new URL('/google/token', mcpUrl).toString()

/** Access tokens by account, in memory only. */
export class GoogleTokens {
  private held = new Map<string, { token: string; until: number }>()
  private asking = new Map<string, Promise<string>>()
  constructor(private deps: TokenDeps) {}

  private now = (): number => (this.deps.now ?? Date.now)()

  async get(account: string): Promise<string> {
    const key = account.toLowerCase()
    const hit = this.held.get(key)
    if (hit && hit.until > this.now()) return hit.token
    const pending = this.asking.get(key)
    if (pending) return pending
    const ask = this.ask(account).finally(() => this.asking.delete(key))
    this.asking.set(key, ask)
    return ask
  }

  /** Google said the token is no good: the next call asks LifeOS again. */
  drop(account: string): void {
    this.held.delete(account.toLowerCase())
  }

  private async ask(account: string): Promise<string> {
    let res: Response
    try {
      res = await this.deps.fetch(this.deps.tokenUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await this.deps.jwt()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, scope: DRIVE_FILE })
      })
    } catch {
      throw new GoogleError('LifeOS did not answer for a Google token. Try again in a moment.', 'unreachable')
    }
    const body = (await res.json().catch(() => ({}))) as { accessToken?: unknown; expiresAt?: unknown; error?: unknown }
    if (res.status === 401 || res.status === 403) throw new GoogleError('LifeOS refused this host\'s sign-in. Sign in to LifeOS again in Settings → Work.', 'signed-out')
    if (res.status === 404) throw new GoogleError(`LifeOS has no Google account ${account}.`, 'no-account')
    if (res.status === 409) throw new GoogleError(`${account} has not allowed Drive files yet. Reconnect it in LifeOS and tick every box on Google's page.`, 'needs-consent')
    if (res.status === 502 && body.error === 'too-wide') throw new GoogleError('Google gave LifeOS a token wider than Drive files, so it was not used.', 'too-wide')
    if (!res.ok || typeof body.accessToken !== 'string') throw new GoogleError('LifeOS could not get a Google token. Try again in a moment.', 'unreachable')
    const raw = body.expiresAt
    const ends = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : typeof raw === 'string' ? Date.parse(raw) : NaN
    // A minute early, so a call never starts on a token about to end.
    const until = Number.isFinite(ends) ? ends - 60_000 : this.now() + 5 * 60_000
    this.held.set(account.toLowerCase(), { token: body.accessToken, until })
    return body.accessToken
  }
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  /** Drive's counter, moved by every change to the file */
  version: string
  modifiedTime?: string
  webViewLink?: string
}

export const GOOGLE_MIME = {
  doc: 'application/vnd.google-apps.document',
  sheet: 'application/vnd.google-apps.spreadsheet',
  slides: 'application/vnd.google-apps.presentation'
} as const

type Bases = Record<keyof typeof GOOGLE_BASES, string>

/** One account's calls. */
export class GoogleApi {
  constructor(
    private tokens: GoogleTokens,
    readonly account: string,
    private deps: { fetch: typeof fetch; bases?: Partial<Bases> }
  ) {}

  private url(base: keyof Bases, path: string): string {
    return `${this.deps.bases?.[base] ?? GOOGLE_BASES[base]}${path}`
  }

  /** One request; a 401 asks LifeOS for a fresh token and tries once more. */
  private async call(method: string, url: string, body?: { json: unknown } | { raw: BodyInit; type: string }, retry = true): Promise<Response> {
    const token = await this.tokens.get(this.account)
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    let payload: BodyInit | undefined
    if (body && 'json' in body) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body.json)
    } else if (body) {
      headers['Content-Type'] = body.type
      payload = body.raw
    }
    let res: Response
    try {
      res = await this.deps.fetch(url, { method, headers, ...(payload !== undefined ? { body: payload } : {}) })
    } catch {
      throw new GoogleError('Google did not answer. Try again in a moment.', 'unreachable')
    }
    if (res.status === 401 && retry) {
      this.tokens.drop(this.account)
      return this.call(method, url, body, false)
    }
    if (!res.ok) throw await googleFailure(res)
    return res
  }

  private async json<T>(method: string, url: string, body?: unknown): Promise<T> {
    return (await (await this.call(method, url, body === undefined ? undefined : { json: body })).json()) as T
  }

  /** One Drive call by its path under `/drive/v3` (google/drive.ts): the Files place's listing and verbs. */
  driveCall<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.json(method, this.url('drive', path), body)
  }

  file(id: string): Promise<DriveFile> {
    return this.json('GET', this.url('drive', `/files/${enc(id)}?fields=id,name,mimeType,version,modifiedTime,webViewLink&supportsAllDrives=true`))
  }

  async export(id: string, mime: string): Promise<Buffer> {
    const res = await this.call('GET', this.url('drive', `/files/${enc(id)}/export?mimeType=${encodeURIComponent(mime)}`))
    return Buffer.from(await res.arrayBuffer())
  }

  /** A copy with its open comments and suggestions: where an agent works on a deck (Slides has no suggest mode). */
  copy(id: string, name: string): Promise<DriveFile> {
    return this.json('POST', this.url('drive', `/files/${enc(id)}/copy?copyComments=true&supportsAllDrives=true&fields=id,name,mimeType,version,webViewLink`), { name })
  }

  /** A new file in his Drive from bytes; a Google `mimeType` converts them (a .docx becomes a Doc, its tracked changes suggestions). */
  async create(name: string, mimeType: string, bytes: Buffer, from: string): Promise<DriveFile> {
    const boundary = `tc${Math.random().toString(36).slice(2)}`
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType })}\r\n--${boundary}\r\nContent-Type: ${from}\r\n\r\n`
    const raw = Buffer.concat([Buffer.from(head), bytes, Buffer.from(`\r\n--${boundary}--`)])
    const res = await this.call('POST', this.url('upload', '/files?uploadType=multipart&fields=id,name,mimeType,version,webViewLink'), { raw: new Uint8Array(raw), type: `multipart/related; boundary=${boundary}` })
    return (await res.json()) as DriveFile
  }

  /** Lets someone in: a held act's `execute` and nothing else calls this. */
  share(id: string, email: string, role: 'reader' | 'commenter' | 'writer', notify: boolean): Promise<{ id: string }> {
    return this.json('POST', this.url('drive', `/files/${enc(id)}/permissions?sendNotificationEmail=${notify}&supportsAllDrives=true`), { type: 'user', role, emailAddress: email })
  }

  unshare(id: string, permissionId: string): Promise<unknown> {
    return this.call('DELETE', this.url('drive', `/files/${enc(id)}/permissions/${enc(permissionId)}?supportsAllDrives=true`))
  }

  /** A Doc with every tab, suggestions inline (the only mode whose indexes are right) and its comments. */
  doc(id: string): Promise<GoogleDocJson> {
    return this.json('GET', this.url('docs', `/documents/${enc(id)}?includeTabsContent=true&suggestionsViewMode=SUGGESTIONS_INLINE&commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED`))
  }

  docUpdate(id: string, requests: unknown[], writeControl: { requiredRevisionId: string; writeMode?: 'SUGGEST' }): Promise<{ writeControl?: { requiredRevisionId?: string } }> {
    return this.json('POST', this.url('docs', `/documents/${enc(id)}:batchUpdate`), { requests, writeControl })
  }

  /** A spreadsheet's sheets, each with what was typed in its cells and what they show. */
  sheet(id: string): Promise<GoogleSheetJson> {
    const fields = 'properties.title,sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue))))'
    return this.json('GET', this.url('sheets', `/spreadsheets/${enc(id)}?includeGridData=true&fields=${encodeURIComponent(fields)}`))
  }

  /** Every range in one request: one revision of the file. */
  sheetWrite(id: string, data: { range: string; values: unknown[][] }[]): Promise<{ totalUpdatedCells?: number }> {
    return this.json('POST', this.url('sheets', `/spreadsheets/${enc(id)}/values:batchUpdate`), { valueInputOption: 'USER_ENTERED', data })
  }

  deck(id: string): Promise<GoogleDeckJson> {
    return this.json('GET', this.url('slides', `/presentations/${enc(id)}?commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED`))
  }

  deckUpdate(id: string, requests: unknown[], writeControl: { requiredRevisionId: string }): Promise<unknown> {
    return this.json('POST', this.url('slides', `/presentations/${enc(id)}:batchUpdate`), { requests, writeControl })
  }
}

const enc = encodeURIComponent

async function googleFailure(res: Response): Promise<GoogleError> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } }
  const said = body.error?.message ?? ''
  if (res.status === 404) return new GoogleError('Google has no such file, or it was not picked for TempCode. Pick it again.', 'not-found')
  if (res.status === 403) return new GoogleError(said.includes('comment') ? 'Google will not show this file\'s comments to this account.' : 'Google refused: this account cannot open or change that file.', 'refused')
  if (res.status === 400 && /revision/i.test(said)) return new GoogleError('The file changed in Google since it was read.', 'conflict')
  if (res.status === 400) return new GoogleError(`Google refused the change${said ? `: ${said.slice(0, 200)}` : '.'}`, 'bad-request')
  if (res.status === 429) return new GoogleError('Google asks to slow down. Try again in a minute.', 'unreachable')
  return new GoogleError(`Google answered ${res.status}. Try again in a moment.`, 'unreachable')
}

// The JSON shapes read here, loosely: the mapper and the grid read what they use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GoogleDocJson = { documentId: string; title: string; revisionId?: string } & Record<string, any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GoogleSheetJson = { properties?: { title?: string }; sheets?: any[] }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GoogleDeckJson = { presentationId: string; title?: string; revisionId?: string; slides?: any[] } & Record<string, any>
