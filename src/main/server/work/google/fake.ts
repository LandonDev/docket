import { GOOGLE_MIME } from './client'

/**
 * A fake Google for tests (docs/agents/work-google.md "Proven against the
 * fake"): LifeOS's `POST /google/token`, the desktop Picker's redirect, and
 * the Drive, Docs, Sheets and Slides calls this pillar makes, in the shapes
 * of Google's references. It is a `fetch`, so no port is opened.
 *
 * `drive.file` is kept: a token reaches only the files its account picked or
 * made. A Doc is held as characters, each with the suggestion that inserted
 * or deletes it and, on a paragraph's newline, that paragraph's style; the
 * JSON is drawn from them with the Docs API's indexes (the body starts at 1).
 */

interface Char {
  c: string
  ins?: string
  del?: string
  /** on a newline: its paragraph's named style */
  style?: string
}

interface FakeDoc {
  chars: Char[]
  rev: number
  comments: unknown[]
  commentAnchors: Record<string, unknown>
  suggestions: { suggestionId: string; author: string }[]
}

interface FakeSheet {
  tabs: { sheetId: number; title: string; cells: (string | number | boolean | null)[][] }[]
}

interface FakeDeck {
  rev: number
  slides: { objectId: string; texts: { objectId: string; text: string }[] }[]
}

interface FakeFile {
  id: string
  name: string
  mimeType: string
  version: number
  /** accounts that picked it or made it */
  reach: Set<string>
  doc?: FakeDoc
  sheet?: FakeSheet
  deck?: FakeDeck
  permissions: { id: string; emailAddress: string; role: string }[]
}

export const FAKE_TOKEN_URL = 'https://lifeos-mcp.test/google/token'

export class FakeGoogle {
  readonly files = new Map<string, FakeFile>()
  /** every API call, as `METHOD path` */
  readonly calls: string[] = []
  /** accounts and whether each allowed drive.file */
  readonly accounts = new Map<string, boolean>()
  jwt = 'owner-jwt'
  /** tokens LifeOS handed out, by token */
  private tokens = new Map<string, string>()
  private n = 0

  account(email: string, consented = true): this {
    this.accounts.set(email.toLowerCase(), consented)
    return this
  }

  private file(id: string, name: string, mimeType: string, owner: string): FakeFile {
    const f: FakeFile = { id, name, mimeType, version: 1, reach: new Set([owner.toLowerCase()]), permissions: [] }
    this.files.set(id, f)
    return f
  }

  /** A Doc of paragraphs `[style, text]`; `reach` false: in Drive but not yet picked. */
  addDoc(owner: string, id: string, name: string, paragraphs: [string, string][], opts: { picked?: boolean; comments?: unknown[]; commentAnchors?: Record<string, unknown> } = {}): void {
    const f = this.file(id, name, GOOGLE_MIME.doc, owner)
    if (opts.picked === false) f.reach.clear()
    f.doc = { chars: paragraphs.flatMap(([style, text]) => [...[...text].map((c) => ({ c })), { c: '\n', style }]), rev: 1, comments: opts.comments ?? [], commentAnchors: opts.commentAnchors ?? {}, suggestions: [] }
  }

  addSheet(owner: string, id: string, name: string, tabs: FakeSheet['tabs']): void {
    this.file(id, name, GOOGLE_MIME.sheet, owner).sheet = { tabs }
  }

  addDeck(owner: string, id: string, name: string, slides: FakeDeck['slides']): void {
    this.file(id, name, GOOGLE_MIME.slides, owner).deck = { rev: 1, slides }
  }

  /** Someone else changes a Doc in Google: text inserted at a document index. */
  editDoc(id: string, index: number, text: string): void {
    const d = this.files.get(id)!
    d.doc!.chars.splice(index - 1, 0, ...[...text].map((c) => ({ c })))
    this.bump(d)
  }

  /** The words of a Doc as Google would show them with every suggestion still waiting. */
  docText(id: string): string {
    return this.files
      .get(id)!
      .doc!.chars.map((x) => x.c)
      .join('')
  }

  /** The Doc's suggestions: `+words` inserted, `-words` deleted, by suggestion. */
  docSuggestions(id: string): string[] {
    const out: string[] = []
    let cur = ''
    let key = ''
    for (const ch of this.files.get(id)!.doc!.chars) {
      const k = ch.ins ? `+${ch.ins}` : ch.del ? `-${ch.del}` : ''
      if (k !== key) {
        if (key) out.push(`${key[0]}${cur}`)
        cur = ''
        key = k
      }
      if (k) cur += ch.c
    }
    if (key) out.push(`${key[0]}${cur}`)
    return out
  }

  /** The browser at the Picker: he picks `ids` as `account`, and Google redirects to the loopback. */
  async pick(authUrl: string, account: string, ids: string[]): Promise<Response> {
    const u = new URL(authUrl)
    if (u.searchParams.get('scope') !== 'https://www.googleapis.com/auth/drive.file' || u.searchParams.get('trigger_onepick') !== 'true') throw new Error('not a desktop Picker URL')
    for (const id of ids) this.files.get(id)?.reach.add(account.toLowerCase())
    const back = new URL(u.searchParams.get('redirect_uri')!)
    back.searchParams.set('state', u.searchParams.get('state') ?? '')
    back.searchParams.set('code', 'fake-code-never-exchanged')
    back.searchParams.set('picked_file_ids', ids.join(','))
    return fetch(back)
  }

  private bump(f: FakeFile): void {
    f.version++
    if (f.doc) f.doc.rev++
    if (f.deck) f.deck.rev++
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    if (url.toString() === FAKE_TOKEN_URL) return this.token(auth, body)
    this.calls.push(`${method} ${url.pathname}`)
    const account = this.tokens.get(auth.replace(/^Bearer /, ''))
    if (!account) return reply(401, { error: { message: 'Invalid Credentials' } })
    const reach = (id: string): FakeFile | null => {
      const f = this.files.get(id)
      return f && f.reach.has(account) ? f : null
    }
    const path = url.pathname
    let m: RegExpMatchArray | null
    if (url.host === 'www.googleapis.com' && (m = path.match(/^\/drive\/v3\/files\/([^/]+)$/)) && method === 'GET') {
      const f = reach(decodeURIComponent(m[1]))
      return f ? reply(200, { id: f.id, name: f.name, mimeType: f.mimeType, version: String(f.version), webViewLink: `https://docs.google.com/open?id=${f.id}` }) : notFound()
    }
    if ((m = path.match(/^\/drive\/v3\/files\/([^/]+)\/export$/))) {
      const f = reach(decodeURIComponent(m[1]))
      return f ? new Response(new Uint8Array(Buffer.from(`%fake ${url.searchParams.get('mimeType')} of ${f.name}`))) : notFound()
    }
    if ((m = path.match(/^\/drive\/v3\/files\/([^/]+)\/copy$/))) {
      const f = reach(decodeURIComponent(m[1]))
      if (!f) return notFound()
      const copy = this.file(`${f.id}-copy${++this.n}`, body.name, f.mimeType, account)
      copy.doc = f.doc && structuredClone(f.doc)
      copy.sheet = f.sheet && structuredClone(f.sheet)
      copy.deck = f.deck && structuredClone(f.deck)
      return reply(200, { id: copy.id, name: copy.name, mimeType: copy.mimeType, version: '1', webViewLink: `https://docs.google.com/open?id=${copy.id}` })
    }
    if ((m = path.match(/^\/drive\/v3\/files\/([^/]+)\/permissions$/)) && method === 'POST') {
      const f = reach(decodeURIComponent(m[1]))
      if (!f) return notFound()
      const p = { id: `perm${++this.n}`, emailAddress: body.emailAddress, role: body.role }
      f.permissions.push(p)
      return reply(200, { id: p.id })
    }
    if (path === '/upload/drive/v3/files' && method === 'POST') {
      const raw = Buffer.from(init!.body as Uint8Array).toString('latin1')
      const meta = JSON.parse(raw.match(/\r\n\r\n(\{.*?\})\r\n/)![1]) as { name: string; mimeType: string }
      const f = this.file(`up${++this.n}`, meta.name, meta.mimeType, account)
      if (meta.mimeType === GOOGLE_MIME.doc) f.doc = { chars: [...'Uploaded\n'].map((c) => ({ c, ...(c === '\n' ? { style: 'NORMAL_TEXT' } : {}) })), rev: 1, comments: [], commentAnchors: {}, suggestions: [] }
      return reply(200, { id: f.id, name: f.name, mimeType: f.mimeType, version: '1', webViewLink: `https://docs.google.com/open?id=${f.id}` })
    }
    if (url.host === 'docs.googleapis.com' && (m = path.match(/^\/v1\/documents\/([^/:]+)(:batchUpdate)?$/))) {
      const f = reach(decodeURIComponent(m[1]))
      if (!f?.doc) return notFound()
      if (!m[2]) return reply(200, renderDoc(f))
      return this.docUpdate(f, body, account)
    }
    if (url.host === 'sheets.googleapis.com' && (m = path.match(/^\/v4\/spreadsheets\/([^/]+?)(\/values:batchUpdate)?$/))) {
      const f = reach(decodeURIComponent(m[1]))
      if (!f?.sheet) return notFound()
      if (!m[2]) return reply(200, renderSheet(f))
      for (const d of body.data as { range: string; values: unknown[][] }[]) {
        const r = d.range.match(/^'((?:[^']|'')+)'!([A-Z]+)(\d+)$/)
        const tab = r && f.sheet.tabs.find((t) => t.title === r[1].replace(/''/g, "'"))
        if (!r || !tab) return reply(400, { error: { message: `Unable to parse range: ${d.range}` } })
        const row = Number(r[3]) - 1
        const col = [...r[2]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
        d.values.forEach((vals, dy) =>
          vals.forEach((v, dx) => {
            const line = (tab.cells[row + dy] ??= [])
            line[col + dx] = v === '' ? null : (v as string | number | boolean)
          })
        )
      }
      this.bump(f)
      return reply(200, { totalUpdatedCells: (body.data as { values: unknown[][] }[]).reduce((n, d) => n + d.values.flat().length, 0) })
    }
    if (url.host === 'slides.googleapis.com' && (m = path.match(/^\/v1\/presentations\/([^/:]+)(:batchUpdate)?$/))) {
      const f = reach(decodeURIComponent(m[1]))
      if (!f?.deck) return notFound()
      const deck = f.deck
      if (!m[2]) return reply(200, renderDeck(f))
      if (body.writeControl?.requiredRevisionId !== `srev${deck.rev}`) return reply(400, { error: { message: 'The required revision ID does not match the latest revision.' } })
      for (const r of body.requests as Record<string, { containsText?: { text: string; matchCase?: boolean }; replaceText?: string; objectId?: string; text?: string; insertionIndex?: number; textRange?: { type: string } }>[]) {
        if (r.replaceAllText) {
          const { containsText, replaceText } = r.replaceAllText
          for (const s of deck.slides) for (const t of s.texts) t.text = t.text.split(containsText!.text).join(replaceText ?? '')
        } else if (r.deleteText) {
          const t = deck.slides.flatMap((s) => s.texts).find((x) => x.objectId === r.deleteText.objectId)
          if (!t) return reply(400, { error: { message: 'object not found' } })
          t.text = ''
        } else if (r.insertText) {
          const t = deck.slides.flatMap((s) => s.texts).find((x) => x.objectId === r.insertText.objectId)
          if (!t) return reply(400, { error: { message: 'object not found' } })
          const at = r.insertText.insertionIndex ?? 0
          t.text = t.text.slice(0, at) + r.insertText.text + t.text.slice(at)
        } else return reply(400, { error: { message: `unknown request ${Object.keys(r)[0]}` } })
      }
      this.bump(f)
      return reply(200, { presentationId: f.id, replies: [] })
    }
    return reply(404, { error: { message: `fake google has no ${method} ${path}` } })
  }

  private token(auth: string, body: { account?: string; scope?: string }): Response {
    if (auth !== `Bearer ${this.jwt}`) return reply(401, { error: 'unauthorized' })
    if (body.scope !== 'https://www.googleapis.com/auth/drive.file') return reply(400, { error: 'scope-refused' })
    const account = (body.account ?? '').toLowerCase()
    if (!this.accounts.has(account)) return reply(404, { error: 'no-account' })
    if (!this.accounts.get(account)) return reply(409, { error: 'needs-consent' })
    const token = `tok-${account}-${++this.n}`
    this.tokens.set(token, account)
    return reply(200, { account, scope: body.scope, accessToken: token, expiresAt: Date.now() + 3600_000 })
  }

  /** Revokes every token handed out: the next call gets 401, as an expired token does. */
  expireTokens(): void {
    this.tokens.clear()
  }

  private docUpdate(f: FakeFile, body: { requests: Record<string, Record<string, unknown>>[]; writeControl?: { requiredRevisionId?: string; writeMode?: string } }, account: string): Response {
    const d = f.doc!
    if (body.writeControl?.requiredRevisionId !== `rev${d.rev}`) return reply(400, { error: { message: 'The required revision ID does not match the latest revision of the document.', status: 'INVALID_ARGUMENT' } })
    const suggest = body.writeControl?.writeMode === 'SUGGEST'
    const work = structuredClone(d.chars)
    for (const r of body.requests) {
      const [kind, a] = Object.entries(r)[0] as [string, Record<string, unknown>]
      // One suggestion per insertion or deletion, as Google names them.
      const sid = suggest ? `suggest.tc${++this.n}` : undefined
      if (sid) d.suggestions.push({ suggestionId: sid, author: account })
      if (kind === 'insertText') {
        const at = (a.location as { index: number }).index
        if (at < 1 || at > work.length) return reply(400, { error: { message: `Index ${at} must be less than the end index of the referenced segment, ${work.length + 1}.` } })
        const style = work.slice(at - 1).find((c) => c.c === '\n')?.style ?? 'NORMAL_TEXT'
        work.splice(at - 1, 0, ...[...(a.text as string)].map((c) => ({ c, ...(sid ? { ins: sid } : {}), ...(c === '\n' ? { style } : {}) })))
      } else if (kind === 'deleteContentRange') {
        const { startIndex, endIndex } = a.range as { startIndex: number; endIndex: number }
        if (startIndex < 1 || endIndex > work.length || endIndex <= startIndex) return reply(400, { error: { message: `Invalid deletion range ${startIndex}-${endIndex}.` } })
        if (endIndex === work.length + 1) return reply(400, { error: { message: 'The range cannot include the newline character at the end of the segment.' } })
        if (sid) for (let i = startIndex - 1; i < endIndex - 1; i++) work[i] = { ...work[i], del: sid }
        else work.splice(startIndex - 1, endIndex - startIndex)
      } else if (kind === 'updateParagraphStyle') {
        const { startIndex, endIndex } = a.range as { startIndex: number; endIndex: number }
        const style = (a.paragraphStyle as { namedStyleType: string }).namedStyleType
        // Every paragraph the range touches: from the one holding its start to the one holding its last unit.
        const newlineFrom = (i: number) => work.findIndex((c, k) => k >= i && c.c === '\n')
        const first = newlineFrom(startIndex - 1)
        const last = newlineFrom(Math.max(startIndex, endIndex - 1) - 1)
        for (let j = first; j >= 0 && j <= last; j++) if (work[j].c === '\n') work[j] = { ...work[j], style }
      } else return reply(400, { error: { message: `fake docs has no ${kind}` } })
    }
    d.chars = work
    this.bump(f)
    return reply(200, { documentId: f.id, replies: [], writeControl: { requiredRevisionId: `rev${d.rev}` } })
  }
}

const reply = (status: number, json: unknown): Response => new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } })
const notFound = (): Response => reply(404, { error: { message: 'File not found.' } })

function renderDoc(f: FakeFile): unknown {
  const d = f.doc!
  const content: unknown[] = [{ startIndex: 0, endIndex: 1, sectionBreak: { sectionStyle: { sectionType: 'CONTINUOUS' } } }]
  let start = 1
  let i = 0
  while (i < d.chars.length) {
    let j = i
    while (j < d.chars.length && d.chars[j].c !== '\n') j++
    const end = j + 1
    const elements: unknown[] = []
    let k = i
    while (k < end) {
      let l = k
      while (l < end && d.chars[l].ins === d.chars[k].ins && d.chars[l].del === d.chars[k].del) l++
      const run = d.chars.slice(k, l)
      elements.push({
        startIndex: start + k - i,
        endIndex: start + l - i,
        textRun: { content: run.map((c) => c.c).join(''), textStyle: {}, ...(run[0].ins ? { suggestedInsertionIds: [run[0].ins] } : {}), ...(run[0].del ? { suggestedDeletionIds: [run[0].del] } : {}) }
      })
      k = l
    }
    content.push({ startIndex: start, endIndex: start + end - i, paragraph: { elements, paragraphStyle: { namedStyleType: d.chars[j]?.style ?? 'NORMAL_TEXT' } } })
    start += end - i
    i = end
  }
  return {
    documentId: f.id,
    title: f.name,
    revisionId: `rev${d.rev}`,
    tabs: [{ tabProperties: { tabId: 't.0', title: 'Tab 1' }, documentTab: { body: { content }, commentAnchors: d.commentAnchors } }],
    comments: d.comments,
    suggestions: d.suggestions.map((s) => ({ suggestionId: s.suggestionId, status: 'OPEN', headPost: { postId: s.suggestionId, author: { displayName: s.author, me: true } } }))
  }
}

function value(v: string | number | boolean | null): Record<string, unknown> | undefined {
  if (v === null || v === undefined) return undefined
  if (typeof v === 'number') return { numberValue: v }
  if (typeof v === 'boolean') return { boolValue: v }
  return v.startsWith('=') ? { formulaValue: v } : { stringValue: v }
}

function renderSheet(f: FakeFile): unknown {
  return {
    properties: { title: f.name },
    sheets: f.sheet!.tabs.map((t, index) => ({
      properties: { sheetId: t.sheetId, title: t.title, index, gridProperties: { rowCount: Math.max(1000, t.cells.length), columnCount: 26 } },
      data: [
        {
          rowData: t.cells.map((row) => ({
            values: (row ?? []).map((v) => {
              const typed = value(v)
              // A formula shows its typed text here; the fake does not calculate.
              return typed ? { userEnteredValue: typed, effectiveValue: 'formulaValue' in typed ? { stringValue: '' } : typed } : {}
            })
          }))
        }
      ]
    }))
  }
}

function renderDeck(f: FakeFile): unknown {
  return {
    presentationId: f.id,
    title: f.name,
    revisionId: `srev${f.deck!.rev}`,
    slides: f.deck!.slides.map((s) => ({
      objectId: s.objectId,
      pageElements: s.texts.map((t) => ({ objectId: t.objectId, shape: { text: { textElements: [{ textRun: { content: `${t.text}\n` } }] } } }))
    }))
  }
}
