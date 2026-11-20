import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { PublicForm, PublishedForm } from '@shared/contract-work-forms'
import type { A1Cell } from '../../sheets/host/wire'
import { HOSTED_CSP } from './hosted'
import { hostOf } from './internalSheet'
import { BASE_HEADERS, sendText, type PublicRoute, type RouteCtx } from './route'

/**
 * A published form's page (docs/agents/work-forms.md "The page"), on the
 * public listener behind the tunnel:
 *
 *   GET  /f/<publicId>        the page (out/hosted/form), which reads the next
 *   GET  /f/<publicId>/form   the questions, and whether the form takes answers
 *   POST /f/<publicId>        one answer: `{ answers: { <question id>: text } }`
 *
 * What a form is comes only from the copy main writes in the service's own
 * folder (`forms/<publicId>.json`, forms/forms.ts `writeCopy`), read on
 * every request, so a close stops answers on the next one. An answer is
 * written as the next row of the form's sheet through the service's sheet
 * host, then noted in `forms/<publicId>.answers.jsonl`, whose length is the
 * row count.
 */

// The service tree takes only types from @shared: a value would bring the contract (and zod) into its bundle.
/** A public id as `newPublicId` makes them (forms/store.ts): 12 random bytes, base64url. */
const PUBLIC_ID = /^[A-Za-z0-9_-]{16}$/
/** The longest answer the page takes: a short answer, then a long one. */
export const ANSWER_MAX = { short: 500, long: 5000 } as const
const BODY_MAX = 64 * 1024
/** Answers one caller may send one form in ten minutes, and every caller together. */
const PER_CALLER = 10
const PER_FORM = 600
const WINDOW_MS = 10 * 60_000

const copyPath = (ctx: RouteCtx, id: string): string => join(ctx.config().dataDir, 'forms', `${id}.json`)
const logPath = (ctx: RouteCtx, id: string): string => join(ctx.config().dataDir, 'forms', `${id}.answers.jsonl`)

const cache = new Map<string, { mtime: number; form: PublishedForm }>()
function readForm(ctx: RouteCtx, id: string): PublishedForm | null {
  const path = copyPath(ctx, id)
  let mtime: number
  try {
    mtime = statSync(path).mtimeMs
  } catch {
    return null
  }
  const had = cache.get(path)
  if (had?.mtime === mtime) return had.form
  try {
    const form = JSON.parse(readFileSync(path, 'utf8')) as PublishedForm
    cache.set(path, { mtime, form })
    return form
  } catch {
    return null
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

const publicOf = (f: PublishedForm): PublicForm => ({ title: f.title, description: f.description, questions: f.questions, open: f.open })

/** Who is sending: the tunnel's `CF-Connecting-IP`, else the peer, as serve.ts counts sockets. */
const callerOf = (req: IncomingMessage): string => String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? '?')

const sent = new Map<string, number[]>()
/** Callers past this many, those with nothing in the window are let go: a caller that keeps changing address leaves nothing behind. */
const KEYS_MAX = 5000
function recent(key: string, now: number): number[] {
  if (sent.size > KEYS_MAX) for (const [k, times] of sent) if (!times.some((t) => now - t < WINDOW_MS)) sent.delete(k)
  return (sent.get(key) ?? []).filter((t) => now - t < WINDOW_MS)
}
/** Whether `key` has room under `max`, and counts this one when it has. */
function allowed(key: string, max: number, now: number): boolean {
  const times = recent(key, now)
  if (times.length >= max) {
    sent.set(key, times)
    return false
  }
  times.push(now)
  sent.set(key, times)
  return true
}
const full = (key: string, max: number, now: number): boolean => recent(key, now).length >= max

/** The answers checked against the form; a refusal names the question in the filler's words. */
export function checkAnswers(form: Pick<PublicForm, 'questions'>, raw: unknown): { ok: Record<string, string> } | { error: string; question?: string } {
  const answers = (raw && typeof raw === 'object' ? (raw as { answers?: unknown }).answers : null) as Record<string, unknown> | null
  if (!answers || typeof answers !== 'object') return { error: 'Nothing was sent.' }
  const ok: Record<string, string> = {}
  for (const q of form.questions) {
    if (q.type === 'section') continue
    const v = answers[q.id]
    const text = typeof v === 'string' ? v.trim() : ''
    if (!text) {
      if (q.required) return { error: 'This question needs an answer.', question: q.id }
      continue
    }
    if (text.length > (q.type === 'long' ? ANSWER_MAX.long : ANSWER_MAX.short)) return { error: 'This answer is too long.', question: q.id }
    if ((q.type === 'choice' || q.type === 'dropdown') && !q.options?.includes(text)) return { error: 'Pick one of the answers.', question: q.id }
    ok[q.id] = text
  }
  return { ok }
}

const pad = (n: number): string => String(n).padStart(2, '0')
/** When it came in, in the host's own time: a sheet reads it as text a person can scan. */
export const submittedAt = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`

const letter = (i: number): string => {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** A page's id for one sending of one set of answers: a resend of the same answers carries it again. */
const SUBMISSION = /^[A-Za-z0-9_-]{16,64}$/

/** Rows written per form, read from its log once; answers to one form are written one after another. */
const rows = new Map<string, number>()
/** The submissions each form has taken, read from its log once: a reply that was lost and sent again is the row it already has. */
const taken = new Map<string, Set<string>>()
function takenOf(ctx: RouteCtx, id: string): Set<string> {
  const had = taken.get(id)
  if (had) return had
  const path = logPath(ctx, id)
  const seen = new Set<string>()
  if (existsSync(path))
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const s = (JSON.parse(line) as { submission?: unknown }).submission
        if (typeof s === 'string') seen.add(s)
      } catch {
        // A line that does not read is no submission.
      }
    }
  taken.set(id, seen)
  return seen
}
const queue = new Map<string, Promise<unknown>>()
function countOf(ctx: RouteCtx, id: string): number {
  const had = rows.get(id)
  if (had !== undefined) return had
  const path = logPath(ctx, id)
  const n = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0
  rows.set(id, n)
  return n
}

/** Writes one answer as the form's next row; a submission already taken writes nothing ("again"). */
async function record(ctx: RouteCtx, form: PublishedForm, ok: Record<string, string>, submission?: string): Promise<'new' | 'again'> {
  const run = (queue.get(form.publicId) ?? Promise.resolve()).catch(() => undefined).then(async (): Promise<'new' | 'again'> => {
    // Asked inside the queue: two sendings of one submission that crossed are one row.
    if (submission && takenOf(ctx, form.publicId).has(submission)) return 'again'
    const row = countOf(ctx, form.publicId) + 2
    const at = submittedAt(new Date())
    const cells: A1Cell[] = [{ at: `A${row}`, v: at }, ...form.columns.flatMap((id, i) => (ok[id] ? [{ at: `${letter(i + 1)}${row}`, v: ok[id] }] : []))]
    await hostOf(ctx).cells(form.sheet, cells, `form:${form.publicId}`, false)
    // The row is taken once the sheet has it, whatever happens to the note of it.
    rows.set(form.publicId, row - 1)
    if (submission) takenOf(ctx, form.publicId).add(submission)
    try {
      appendFileSync(logPath(ctx, form.publicId), `${JSON.stringify(submission ? { row, at, submission } : { row, at })}\n`, { mode: 0o600 })
    } catch (err) {
      ctx.log(`form ${form.publicId}: row ${row} was written but not noted: ${String(err)}`)
    }
    return 'new'
  })
  queue.set(form.publicId, run)
  return run
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0
    const parts: Buffer[] = []
    req.on('data', (b: Buffer) => {
      size += b.length
      if (size > BODY_MAX) {
        resolve(null)
        req.destroy()
      } else parts.push(b)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

export const formRoute: PublicRoute = {
  name: 'published forms',
  milestone: 36,
  match: /^\/f(\/.*)?$/,
  async http(req, res, ctx, m) {
    const parts = /^\/([^/]+)(\/form)?$/.exec(m[1] ?? '')
    const id = parts?.[1] ?? ''
    const form = PUBLIC_ID.test(id) ? readForm(ctx, id) : null
    if (!form) return sendText(res, 404, 'There is no form here.')
    const method = req.method ?? 'GET'
    if (parts?.[2]) {
      if (method !== 'GET') return sendText(res, 405, 'Not allowed.')
      return send(res, 200, publicOf(form))
    }
    if (method === 'GET' || method === 'HEAD') {
      const page = join(ctx.config().hostedDir, 'form', 'index.html')
      if (!existsSync(page)) return sendText(res, 503, 'The form page is not built on this host.')
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': HOSTED_CSP })
      return void res.end(method === 'HEAD' ? undefined : readFileSync(page))
    }
    if (method !== 'POST') return sendText(res, 405, 'Not allowed.')
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'Send the answers as JSON.' })
    // One caller's every post counts against it; the form's own limit counts only answers it takes, so junk cannot use it up.
    const now = Date.now()
    if (full(form.publicId, PER_FORM, now)) return send(res, 429, { error: 'This form is taking too many answers. Try again in a few minutes.' })
    if (!allowed(`${form.publicId}|${callerOf(req)}`, PER_CALLER, now)) return send(res, 429, { error: 'Too many answers from here. Try again in a few minutes.' })
    const text = await readBody(req)
    if (text === null) return send(res, 413, { error: 'That is too much to send.' })
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return send(res, 400, { error: 'Nothing was sent.' })
    }
    // The same submission again (its reply was lost on the way back): the answer it already wrote, first of all. The form
    // may have closed or changed its questions since, and that answer is saved all the same; not a second row nor a second count.
    const sent = (raw as { submission?: unknown } | null)?.submission
    const submission = typeof sent === 'string' && SUBMISSION.test(sent) ? sent : undefined
    if (submission && takenOf(ctx, id).has(submission)) return send(res, 201, { ok: true })
    // Read again: the form may have closed while the answer came in.
    const now2 = readForm(ctx, id)
    if (!now2?.open) return send(res, 410, { error: 'This form is closed.' })
    const checked = checkAnswers(now2, raw)
    if ('error' in checked) return send(res, 400, checked)
    if (!allowed(form.publicId, PER_FORM, Date.now())) return send(res, 429, { error: 'This form is taking too many answers. Try again in a few minutes.' })
    try {
      await record(ctx, now2, checked.ok, submission)
    } catch (err) {
      ctx.log(`form ${id}: an answer was not written: ${String(err)}`)
      return send(res, 503, { error: 'Your answer was not saved. Try again in a minute.' })
    }
    return send(res, 201, { ok: true })
  }
}
