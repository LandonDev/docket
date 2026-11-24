import { DOCS_CAPS, type DocOpen, type DocToken } from '@shared/contract-work-docs'
import { handled, NOT_HANDLED } from '@shared/work'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { WORK_OWNER_NAME_SETTING } from '../preamble'
import { ServedElsewhere, TOKEN_SECONDS } from '../service/ctx'
import { DOCUMENT_SCHEMA, SCHEMA_PARAM } from 'work-kit/collab-server'
import { dismissWritten, docsOf, ensureModeTable, modeOf, setMode, stopDocs } from './state'
import { lifeosRow, othersOpen, pathOf, serviceTarget, targetOf, titleOf, type DocTarget } from './target'
import { changeThread, ensureThreadTables, readThreads } from './threads'
import { dropView, dropWorkspaceViews, ensureViewsTable, findDocs, listViews, saveView, workspaceOf } from './find'
import { docTools } from './tools'
import { guestNameOf } from '../guests/store'
import { fetchedItemOfPath } from '../canvas/fetch'
import { NEEDS_PRESS, pressesFor } from '../files/policy'

/**
 * The docs pillar's server module (docs/agents/work-docs.md): the document
 * kind of canvas item. The live text is the Work service's
 * (M18); its history and branches are history's (M19). This module opens a
 * document for a screen (a token, a socket relayed over the host's own link,
 * its threads, its mode) and gives agents `doc_read`, `doc_write`,
 * `doc_format`, `doc_suggest` and `doc_comment` (tools.ts), and finds what a workspace
 * holds for `doc_find` and a project's link picker (find.ts). The saved
 * views it keeps are the Files place's saved searches (files/search.ts); the
 * `work.docs.find` and view methods stay for a window a release behind.
 */

/**
 * A screen at this host or a key that may operate edits; a read-only key views. A document others can read is edited
 * by his press alone (`pressesFor`: his window or a key that may approve), as Files' door asks of any change in such a
 * place. A mail's attachment read as a document is viewed by everyone until he keeps it.
 */
export const roleOf = (by: Caller, ctx?: WorkCtx, t?: DocTarget, shared = false): 'edit' | 'view' =>
  ctx && t?.at === 'file' && fetchedItemOfPath(ctx, t.path) ? 'view' : shared && !pressesFor(by) ? 'view' : by.kind === 'local' || by.caps.includes('operate') ? 'edit' : 'view'

/** A change from a key to a document others can read: only his press. */
async function pressOn(ctx: WorkCtx, by: Caller, t: DocTarget): Promise<void> {
  if (!pressesFor(by) && othersOpen(ctx, t, await lifeosRow(ctx, t))) throw new Error(NEEDS_PRESS)
}

/** Words for each principal a document's rows and carets name. */
export function namesFor(ctx: WorkCtx, principals: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {}
  let owner = 'You'
  try {
    owner = (ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(WORK_OWNER_NAME_SETTING) as { value?: string } | undefined)?.value?.trim() || 'You'
  } catch {
    // No settings table (a test's database): "You" will do.
  }
  const title = ctx.db.prepare('SELECT title FROM sessions WHERE id = ?')
  for (const p of new Set(['owner', ...principals])) {
    if (p === 'owner' || (p.startsWith('lifeos:') && !p.startsWith('lifeos:bot:'))) out[p] = owner
    else if (p.startsWith('lifeos:bot:')) out[p] = 'LifeOS'
    else if (p.startsWith('external:')) out[p] = p.slice('external:'.length) || 'Someone'
    else if (p.startsWith('guest:')) out[p] = guestNameOf(ctx.db, p) ?? 'A guest'
    else if (p.startsWith('agent:')) {
      const [, host, thread] = p.split(':')
      let row: { title?: string } | undefined
      try {
        row = host === ctx.host && thread ? (title.get(thread) as { title?: string } | undefined) : undefined
      } catch {
        row = undefined
      }
      out[p] = row?.title?.trim() || 'An agent'
    } else out[p] = 'Someone'
  }
  return out
}

async function opened(ctx: WorkCtx, by: Caller, t: DocTarget): Promise<DocOpen> {
  const row = await lifeosRow(ctx, t)
  const shared = othersOpen(ctx, t, row)
  return {
    doc: t.doc,
    source: t.source,
    title: titleOf(t, row),
    role: roleOf(by, ctx, t, shared),
    shared,
    mode: shared ? 'suggests' : modeOf(ctx, t.doc),
    written: docsOf(ctx).written.get(t.doc) ?? null,
    me: 'owner',
    names: namesFor(ctx, []),
    schema: DOCUMENT_SCHEMA
  }
}

/** A collaboration token from this host's service; a LifeOS document served by another host says which. */
async function tokenFor(ctx: WorkCtx, by: Caller, t: DocTarget): Promise<DocToken> {
  try {
    // Whether others read it is asked only of a caller that is not his press: his window edits whatever it is.
    const shared = !pressesFor(by) && othersOpen(ctx, t, await lifeosRow(ctx, t))
    const token = await ctx.service.token({ item: { doc: t.doc }, role: roleOf(by, ctx, t, shared), principal: 'owner', source: t.source })
    return { token, expiresAt: Date.now() + TOKEN_SECONDS * 1000 }
  } catch (err) {
    if (err instanceof ServedElsewhere) throw new Error(`served elsewhere: ${err.host}`)
    throw err
  }
}

export const docs: WorkModule = {
  id: 'docs',
  ensure(db) {
    ensureModeTable(db)
    ensureThreadTables(db)
    ensureViewsTable(db)
  },
  async handle(req, ctx, by, signal) {
    if (!(req.method in DOCS_CAPS)) return NOT_HANDLED
    const s = docsOf(ctx)
    switch (req.method) {
      case 'work.docs.open':
        return handled(await opened(ctx, by, await targetOf(ctx, by, req.method, req.params.source)))
      case 'work.docs.token':
        return handled(await tokenFor(ctx, by, await targetOf(ctx, by, req.method, req.params.source)))
      case 'work.docs.connect': {
        const t = await targetOf(ctx, by, req.method, req.params.source)
        // Asked first, so a document another host serves says so before a socket is made.
        await tokenFor(ctx, by, t)
        // The window's editor says what schema it knows; this socket says it for it (work-kit's schema gate).
        const said: unknown = req.params.schema
        const known = typeof said === 'number' && Number.isInteger(said) && said > 0 && said <= 1000 ? `?${SCHEMA_PARAM}=${said}` : ''
        return handled({ socket: s.relay.connect(ctx.service.url(`/w/doc/${encodeURIComponent(t.doc)}${known}`), t.doc) })
      }
      case 'work.docs.send': {
        s.relay.send(req.params.socket, req.params.frames)
        // A tab's close waits for this: the file holds what the window sent before anything judges it.
        if (req.params.stored) await ctx.service.internal('/internal/docs/stored', { name: await s.relay.sent(req.params.socket), fence: { sectors: 'all' } })
        return handled({ ok: true as const })
      }
      case 'work.docs.recv':
        return handled(await s.relay.recv(req.params.socket, signal))
      case 'work.docs.close':
        s.relay.close(req.params.socket)
        return handled({ ok: true as const })
      case 'work.docs.threads': {
        const t = await targetOf(ctx, by, req.method, req.params.source)
        const rows = await readThreads(ctx, t)
        return handled({ rows, names: namesFor(ctx, rows.flatMap((r) => r.comments.map((c) => c.authorMemberId))) })
      }
      case 'work.docs.thread': {
        const t = await targetOf(ctx, by, req.method, req.params.source)
        // A comment on a document others read reaches them at once.
        await pressOn(ctx, by, t)
        const done = await changeThread(ctx, t, req.params.change, 'owner')
        s.push({ push: 'work.docs', doc: t.doc, threads: true }, pathOf(t))
        return handled(done)
      }
      case 'work.docs.mode': {
        const t = await targetOf(ctx, by, req.method, req.params.source)
        setMode(ctx, t.doc, req.params.mode, pathOf(t))
        return handled(await opened(ctx, by, t))
      }
      case 'work.docs.rename': {
        const t = await targetOf(ctx, by, req.method, req.params.source)
        if (t.at !== 'lifeos') throw new Error('a .tcdoc is named by its file')
        await pressOn(ctx, by, t)
        await ctx.lifeos.owner().mutation('docs:rename', { id: t.docId, title: req.params.title })
        return handled({ ok: true as const })
      }
      case 'work.docs.dismiss': {
        const t = await targetOf(ctx, by, req.method, req.params.source)
        let undone = false
        if (req.params.undo) {
          // The bar's Undo: the write the line names, put back by the service only while the document is as the agent
          // left it (its `after` version), the check and the restore in one turn. A line with no `after` offers none.
          const row = await lifeosRow(ctx, t)
          const shared = othersOpen(ctx, t, row)
          await pressOn(ctx, by, t)
          const w = s.written.get(t.doc)
          if (w?.after) undone = ((await ctx.service.internal('/internal/docs/undo', { ...serviceTarget(t, shared), versionId: w.versionId, after: w.after })) as { undone: boolean }).undone
        }
        dismissWritten(ctx, t.doc, pathOf(t))
        return handled({ ok: true as const, ...(req.params.undo ? { undone } : {}) })
      }
      case 'work.docs.create': {
        const { sector, projectId, title } = req.params
        if (!ctx.lifeos.connected()) throw new Error('LifeOS is not signed in on this host')
        // A project is named by a client: it must be one of the sector the call names, as a link's is (work/projects).
        if (projectId && !(await ctx.lifeos.owner().query<{ _id: string }[]>('projects:list', { sector })).some((p) => p._id === projectId)) throw new Error('LifeOS has no such project in this sector')
        const id = await ctx.lifeos.owner().mutation<string>('docs:create', { ...(projectId ? { projectId } : { sector }), title })
        return handled({ source: { at: 'lifeos' as const, table: 'docs' as const, id }, title })
      }
      case 'work.docs.find':
        return handled(await findDocs(ctx, by, { ...req.params, view: true }))
      case 'work.docs.views':
        workspaceOf(ctx, req.params.workspaceId)
        return handled({ views: listViews(ctx.db, req.params.workspaceId) })
      case 'work.docs.saveView': {
        const { workspaceId, ...view } = req.params
        workspaceOf(ctx, workspaceId)
        return handled(saveView(ctx.db, workspaceId, view))
      }
      case 'work.docs.dropView':
        dropView(ctx.db, req.params.workspaceId, req.params.id)
        return handled({ ok: true as const })
    }
    return NOT_HANDLED
  },
  tools: () => docTools,
  preamble: () =>
    'Find a document, sheet or file of this workspace with `doc_find`. A document in the canvas is read with `doc_read` and changed with `doc_write` (its whole new text as markdown), `doc_format` (formatting and page setup), `doc_suggest` or `doc_comment`. Say why you write: `because: "asked"` with the owner\'s words as `quote` when he asked for exactly this change, `"routine"` when a routine you run was granted it, else `"own"`. On a document others share, or one he set to suggest, your own idea waits as suggestions he steps through in the text.',
  start(ctx) {
    return () => stopDocs(ctx)
  },
  sessionsRemoved() {},
  workspaceRemoved(workspaceId, ctx) {
    dropWorkspaceViews(ctx.db, workspaceId)
  }
}
