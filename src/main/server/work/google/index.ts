import type { GoogleAccounts, GoogleFileState, GooglePicked, GoogleWritten } from '@shared/contract-work-google'
import { handled, NOT_HANDLED, type CanvasItem, type CanvasKind } from '@shared/work'
import { errorText } from '@shared/work/ids'
import type { ActKindDef, Caller, WorkCtx, WorkModule } from '../modules'
import { GOOGLE_MIME } from './client'
import { rereadDoc, unsentEdits, writeDoc, type GoogleSource } from './docs'
import { ensureGoogleTables, googleOf } from './google'
import { bump, unfollowAll } from './grid'
import { googleShare } from './held'
import { clientIdOf, pick, setClientId } from './picker'
import { googleChanges, startPoll, watch } from './poll'
import { GOOGLE_TOOLS } from './tools'

/**
 * The google pillar's server module (docs/agents/work-google.md): Google
 * Docs, Sheets and Slides through LifeOS's Google client. The Picker hands
 * a file to TempCode; a Doc opens on a mirror in the document canvas, a
 * Sheet in the grid, a deck stays in Google and agents revise a copy. The
 * Drive version poll runs while a file is open and is a routine trigger.
 * Letting someone into a file is held (`share.google`).
 */

const KIND_OF: Record<string, { canvas: CanvasKind; kind: GooglePicked['kind'] }> = {
  [GOOGLE_MIME.doc]: { canvas: 'document', kind: 'doc' },
  [GOOGLE_MIME.sheet]: { canvas: 'sheet', kind: 'sheet' },
  [GOOGLE_MIME.slides]: { canvas: 'slides', kind: 'slides' }
}

let openBrowser: (url: string) => Promise<void> = async (url) => {
  if (!process.versions.electron) throw new Error('This host has no browser to show the Picker in.')
  const { shell } = await import('electron')
  await shell.openExternal(url)
}
/** A test stands in for the system browser. */
export const setOpenBrowser = (fn: (url: string) => Promise<void>): void => {
  openBrowser = fn
}

function googleItem(ctx: WorkCtx, itemId: string): CanvasItem & { source: GoogleSource } {
  const item = ctx.canvas.get(itemId)
  if (!item || item.source.at !== 'google') throw new Error('That item is not a Google file.')
  return item as CanvasItem & { source: GoogleSource }
}

const urlOf = (s: GoogleSource): string =>
  s.mime === GOOGLE_MIME.sheet
    ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(s.fileId)}/edit`
    : s.mime === GOOGLE_MIME.slides
      ? `https://docs.google.com/presentation/d/${encodeURIComponent(s.fileId)}/edit`
      : `https://docs.google.com/document/d/${encodeURIComponent(s.fileId)}/edit`

/** An open item's state; asking keeps the file in the version poll. */
async function stateOf(ctx: WorkCtx, item: CanvasItem & { source: GoogleSource }): Promise<GoogleFileState> {
  const s = item.source
  watch(s.account, s.fileId, item.title, item.id)
  const row = googleOf(ctx).files.get(s.account, s.fileId)
  const unsent = row?.mirror && s.mime === GOOGLE_MIME.doc ? await unsentEdits(ctx, googleOf(ctx), row.mirror, row.base) : 0
  return { behind: !!row?.behind, unsent, url: urlOf(s) }
}

async function tell(ctx: WorkCtx, item: CanvasItem & { source: GoogleSource }): Promise<void> {
  ctx.push({ push: 'work.google', sessionId: item.sessionId, itemId: item.id, state: await stateOf(ctx, item) })
}

/** A call from a person, not a thread: the owner's own edits and picks. */
const person = (by: Caller): boolean => by.kind !== 'model'

export const google: WorkModule = {
  id: 'google',
  ensure(db) {
    ensureGoogleTables(db)
  },
  async handle(req, ctx, by, signal) {
    if (!req.method.startsWith('work.google.')) return NOT_HANDLED
    switch (req.method) {
      case 'work.google.accounts': {
        let rows: { account?: string; files?: boolean }[] = []
        if (ctx.lifeos.connected()) rows = await ctx.lifeos.owner().query<typeof rows>('calendarOps:accounts', {})
        const out: GoogleAccounts = { accounts: rows.filter((r) => typeof r.account === 'string').map((r) => ({ account: r.account!, files: r.files === true })), picker: !!clientIdOf(ctx.db) }
        return handled(out)
      }
      case 'work.google.setup': {
        setClientId(ctx.db, req.params.clientId)
        return handled({ ok: true as const })
      }
      case 'work.google.pick': {
        const clientId = clientIdOf(ctx.db)
        if (!clientId) throw new Error("This host does not know LifeOS's Google client id yet: set it in Settings → Work.")
        const ids = await pick({ clientId, account: req.params.account, kinds: req.params.kinds, open: openBrowser, signal })
        const api = googleOf(ctx).api(req.params.account)
        const files: GooglePicked[] = []
        for (const id of ids) {
          const f = await api.file(id)
          files.push({ fileId: f.id, name: f.name, mime: f.mimeType, kind: KIND_OF[f.mimeType]?.kind ?? null })
        }
        return handled({ files })
      }
      case 'work.google.open': {
        if (!ctx.scopeOf(req.params.sessionId)) throw new Error('Google files open in a Work thread.')
        const f = await googleOf(ctx).api(req.params.account).file(req.params.fileId)
        const kind = KIND_OF[f.mimeType]
        if (!kind) throw new Error(`${f.name} is not a Doc, a Sheet or a Slides deck.`)
        const source: GoogleSource = { at: 'google', account: req.params.account.toLowerCase(), fileId: f.id, mime: f.mimeType }
        const item = ctx.canvas.open(ctx.canvas.paneOf(req.params.sessionId), kind.canvas, source, f.name)
        if (!googleOf(ctx).files.get(source.account, f.id)) googleOf(ctx).files.put({ account: source.account, fileId: f.id, kind: kind.kind!, name: f.name, version: f.version, behind: null, mirror: null, base: null })
        watch(source.account, f.id, f.name, item.id)
        return handled({ itemId: item.id })
      }
      case 'work.google.watch':
        return handled(await stateOf(ctx, googleItem(ctx, req.params.itemId)))
      case 'work.google.write': {
        if (!person(by)) throw new Error('Agents suggest in Google with google_doc_suggest.')
        const item = googleItem(ctx, req.params.itemId)
        if (item.source.mime !== GOOGLE_MIME.doc) throw new Error('Only a Doc is written from its mirror: a Sheet writes as he edits it.')
        const done: GoogleWritten = await writeDoc(ctx, googleOf(ctx), item.source)
        if (done.changed + done.added + done.removed) ctx.results.add({ sessionId: item.sessionId, kind: 'google.doc.write', summary: `Wrote ${item.title} to Google`, account: item.source.account, ref: { at: 'google', fileId: item.source.fileId } })
        await tell(ctx, item)
        return handled(done)
      }
      case 'work.google.reload': {
        const item = googleItem(ctx, req.params.itemId)
        const g = googleOf(ctx)
        const row = g.files.get(item.source.account, item.source.fileId)
        if (item.source.mime === GOOGLE_MIME.sheet) bump(item.source)
        else if (row?.mirror) {
          const state = await stateOf(ctx, item)
          if (state.unsent && !req.params.discard) throw new Error(`${state.unsent} of your edits are not in Google yet: write them first, or read again and drop them.`)
          await rereadDoc(ctx, g, item.source)
        }
        await tell(ctx, item)
        return handled(await stateOf(ctx, item))
      }
      case 'work.google.upload': {
        const item = ctx.canvas.get(req.params.itemId)
        if (!item || item.kind !== 'document') throw new Error('Only a document becomes a Google Doc.')
        if (item.source.at === 'google') throw new Error(`${item.title} is a Google Doc already.`)
        const { exportDoc } = await import('../formats/exporter')
        const out = await exportDoc(ctx, by, { source: item.source, format: 'docx' })
        const made = await googleOf(ctx).api(req.params.account).create(item.title, GOOGLE_MIME.doc, Buffer.from(out.data, 'base64'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        const url = made.webViewLink ?? urlOf({ at: 'google', account: req.params.account, fileId: made.id, mime: GOOGLE_MIME.doc })
        ctx.results.add({ sessionId: item.sessionId, kind: 'google.doc.upload', summary: `Made ${item.title} a Google Doc`, account: req.params.account, ref: { at: 'google', fileId: made.id, url } })
        return handled({ fileId: made.id, url })
      }
    }
    return NOT_HANDLED
  },
  tools: () => GOOGLE_TOOLS,
  acts: [googleShare as ActKindDef],
  triggers: [googleChanges],
  preamble: () =>
    "A Google file open in the canvas is reached with the `google_*` tools. A Doc is read with `google_doc_read` and changed only by `google_doc_suggest`, which leaves Google suggestions for the owner; a Sheet with `google_sheet_read` and `google_sheet_suggest`; a Slides deck with `google_slides_read`, and `google_slides_revise` works on a copy, never the deck. `google_share` waits for the owner's press.",
  start(ctx) {
    const stop = startPoll(ctx, (w) => {
      // Someone else changed it: each open item hears, a grid reads it again.
      const g = googleOf(ctx)
      const row = g.files.get(w.account, w.fileId)
      if (row?.kind === 'sheet') bump(w)
      for (const id of w.items) {
        const item = ctx.canvas.get(id)
        if (!item || item.source.at !== 'google') continue
        if (row?.kind === 'doc') g.files.update(w.account, w.fileId, { behind: 'poll' })
        void tell(ctx, item as CanvasItem & { source: GoogleSource }).catch((err) => ctx.log(`google: ${errorText(err)}`))
      }
    })
    return () => {
      stop()
      unfollowAll()
    }
  },
  sessionsRemoved() {},
  workspaceRemoved() {}
}
