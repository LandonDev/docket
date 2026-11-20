import { DOCS_CAPS, type DocOpen, type DocToken } from '@shared/contract-work-docs'
import { handled, NOT_HANDLED } from '@shared/work'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { WORK_OWNER_NAME_SETTING } from '../preamble'
import { ServedElsewhere, TOKEN_SECONDS } from '../service/ctx'
import { dismissWritten, docsOf, ensureModeTable, modeOf, setMode, stopDocs } from './state'
import { lifeosRow, pathOf, targetOf, titleOf, type DocTarget } from './target'
import { changeThread, ensureThreadTables, readThreads } from './threads'
import { dropView, dropWorkspaceViews, ensureViewsTable, findDocs, listViews, saveView, workspaceOf } from './find'
import { docTools } from './tools'
import { guestNameOf } from '../guests/store'

/**
 * The docs pillar's server module (docs/agents/work-docs.md): the document
 * kind of canvas item and the Docs view. The live text is the Work service's
 * (M18); its history and branches are history's (M19). This module opens a
 * document for a screen (a token, a socket relayed over the host's own link,
 * its threads, its mode) and gives agents `doc_read`, `doc_write`,
 * `doc_suggest` and `doc_comment` (tools.ts), and finds what a workspace
 * holds for the Docs view and `doc_find` (find.ts).
 */

/** A screen at this host or a key that may operate edits; a read-only key views. */
const roleOf = (by: Caller): 'edit' | 'view' => (by.kind === 'local' || by.caps.includes('operate') ? 'edit' : 'view')

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
  const shared = !!row?.shared
  return {
    doc: t.doc,
    source: t.source,
    title: titleOf(t, row),
    role: roleOf(by),
    shared,
    mode: shared ? 'suggests' : modeOf(ctx, t.doc),
    written: docsOf(ctx).written.get(t.doc) ?? null,
    me: 'owner',
    names: namesFor(ctx, [])
  }
}

/** A collaboration token from this host's service; a LifeOS document served by another host says which. */
async function tokenFor(ctx: WorkCtx, by: Caller, t: DocTarget): Promise<DocToken> {
  try {
    const token = await ctx.service.token({ item: { doc: t.doc }, role: roleOf(by), principal: 'owner', source: t.source })
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
        return handled({ socket: s.relay.connect(ctx.service.url(`/w/doc/${encodeURIComponent(t.doc)}`), t.doc) })
      }
      case 'work.docs.send':
        s.relay.send(req.params.socket, req.params.frames)
        return handled({ ok: true as const })
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
        await ctx.lifeos.owner().mutation('docs:rename', { id: t.docId, title: req.params.title })
        return handled({ ok: true as const })
      }
      case 'work.docs.dismiss': {
        const t = await targetOf(ctx, by, req.method, req.params.source)
        dismissWritten(ctx, t.doc, pathOf(t))
        return handled({ ok: true as const })
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
        return handled(await findDocs(ctx, by, req.params))
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
    'Find a document, sheet or file of this workspace with `doc_find`. A document in the canvas is read with `doc_read` and changed with `doc_write` (its whole new text as markdown), `doc_suggest` or `doc_comment`. Say why you write: `because: "asked"` with the owner\'s words as `quote` when he asked for exactly this change, `"routine"` when a routine you run was granted it, else `"own"`. On a document others share, or one he set to suggest, your own idea waits as suggestions he steps through in the text.',
  start(ctx) {
    return () => stopDocs(ctx)
  },
  sessionsRemoved() {},
  workspaceRemoved(workspaceId, ctx) {
    dropWorkspaceViews(ctx.db, workspaceId)
  }
}
