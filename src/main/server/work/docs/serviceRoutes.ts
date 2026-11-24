import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import * as Y from 'yjs'
import { DOCUMENT_FRAGMENT, findQuote, setThreadMark } from 'work-kit/collab'
import { fileDocName, readDocument, type CollabContext, type CollabFile } from 'work-kit/collab-server'
import { docIn, fenceOf, servingHere, str } from '../service/routes/internal'
import { RouteError, type InternalRoute, type RouteCtx } from '../service/routes/route'
import { documentStyleLines } from './formatDescription'
import { formatRouteFields } from './formatInput'

/**
 * The docs pillar's internal routes on the Work service
 * (docs/agents/work-docs.md): the Unix socket, behind the secret, beside
 * routes/internal.ts. Main's agent tools (work/docs/tools.ts) call them after
 * their own checks: the asked quote found in the owner's words, the path
 * fence, the mode. They take a LifeOS document (`docId`) or a `.tcdoc`
 * (`file`), and a principal main names, so they are main's alone: a call that
 * names a bot key is refused, as history's are.
 *
 * This file is loaded by the service's entry: it may import nothing of the
 * database, the store, Electron or `@shared/work` (service/boundary.test.ts).
 */

interface Target {
  name: string
  file?: CollabFile
  shared: boolean
}

const PRINCIPAL = /^(owner|agent:[A-Za-z0-9_.-]{1,80}:[A-Za-z0-9_.-]{1,80})$/

function filePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value) || !value.toLowerCase().endsWith('.tcdoc')) throw new RouteError(400, 'file is not a .tcdoc path')
  if (value.split(/[\\/]/).slice(1).some((p) => p === '' || p === '.' || p === '..')) throw new RouteError(400, 'file is not a plain path')
  return value
}

async function targetOf(body: Record<string, unknown>, ctx: RouteCtx): Promise<Target> {
  const fence = fenceOf(body)
  if (fence.botId !== undefined || fence.client !== undefined || fence.draftOnly) throw new RouteError(403, "these routes are main's: a bot key writes through /internal/doc/*")
  if (body.file !== undefined) {
    if (fence.sectors !== 'all') throw new RouteError(404, 'not found')
    const path = filePath(body.file)
    return { name: fileDocName(path), file: { path }, shared: body.shared === true }
  }
  servingHere(ctx)
  const docId = str(body, 'docId', 64)
  const row = await docIn(ctx, docId, fence)
  return { name: docId, shared: !!row.shared }
}

function principalOf(body: Record<string, unknown>): string {
  const p = body.principal
  if (typeof p !== 'string' || !PRINCIPAL.test(p)) throw new RouteError(400, 'principal is the owner or an agent')
  return p
}

export const docsRoutes: InternalRoute[] = [
  {
    // The document's live revision: a hash of its state vector and its delete set as the collab server holds them
    // now, which moves with every edit whether or not the file has been written (files/word.ts: a Word file's autosave
    // and its header). The delete set too: taking out a letter moves no client's clock, only what is deleted.
    path: '/internal/docs/rev',
    milestone: 20,
    async run(body, ctx) {
      const t = await targetOf(body, ctx)
      let snapshot: Uint8Array = new Uint8Array()
      await ctx.collab.edit(t.name, 'owner', (doc) => void (snapshot = Y.encodeSnapshot(Y.snapshot(doc))), t.file)
      return { rev: createHash('sha256').update(snapshot).digest('hex').slice(0, 32) }
    }
  },
  {
    path: '/internal/docs/read',
    milestone: 20,
    async run(body, ctx) {
      const t = await targetOf(body, ctx)
      if (body.with === 'styles') {
        const context: CollabContext = { principal: 'owner', role: 'edit', exp: Infinity, by: 'internal', ...(t.file ? { file: t.file } : {}) }
        const direct = await ctx.collab.hocuspocus.openDirectConnection(t.name, context)
        try {
          const doc = direct.document!
          return { ...readDocument(doc.getXmlFragment(DOCUMENT_FRAGMENT)), shared: t.shared, styles: documentStyleLines(doc) }
        } finally {
          await direct.disconnect({ unloadImmediately: false })
        }
      }
      if (body.with !== undefined) throw new RouteError(400, 'with is styles')
      const live = await ctx.collab.read(t.name, t.file)
      return { markdown: live.markdown, plain: live.plain, shared: t.shared }
    }
  },
  {
    path: '/internal/docs/write',
    milestone: 20,
    /**
     * `because` is main's verdict, not the model's word: `asked` only once main found the quote
     * among the owner's words in the thread, `routine` only for a routine's run. `suggest` makes
     * any write a branch of suggestions, as on a shared document (the owner's "Agent suggests").
     */
    async run(body, ctx) {
      const t = await targetOf(body, ctx)
      const markdown = body.markdown
      if (typeof markdown !== 'string' || markdown.length > 900_000) throw new RouteError(400, 'markdown is missing or too long')
      const because = body.because
      if (because !== 'asked' && because !== 'routine' && because !== 'own') throw new RouteError(400, 'because is asked, routine or own')
      const suggest = body.suggest === true
      const file = t.file ? { file: t.file } : {}
      const verdict = suggest ? 'own' : because
      const shared = suggest || t.shared
      // A write that goes straight in: the version just before it is what its Undo goes back to
      // (the one history.write answers is cut after it). Nothing changed since the last version: that one.
      const before = verdict === 'own' && shared ? null : await ctx.history.cut(t.name, 'before-agent', file)
      const done = await ctx.history.write(t.name, principalOf(body), markdown, { because: verdict, shared, ...file })
      return { ...done, shared: t.shared, ...(before && done.mode === 'direct' ? { beforeVersionId: before.id } : {}) }
    }
  },
  {
    path: '/internal/docs/format',
    milestone: 20,
    async run(body, ctx) {
      const { change, because, paper } = formatRouteFields(body)
      const principal = principalOf(body)
      const t = await targetOf(body, ctx)
      const suggest = body.suggest === true
      return { ...await ctx.history.format(t.name, principal, change, {
        because: suggest ? 'own' : because,
        shared: suggest || t.shared,
        ...(t.file ? { file: t.file } : {}),
        ...(paper ? { paper } : {})
      }), shared: t.shared }
    }
  },
  {
    path: '/internal/docs/stored',
    milestone: 20,
    /**
     * A tab's close (work.docs.send with `stored`): every frame a window's socket sent this document is applied, then
     * the document is stored, so the file says what he left before anything judges it; a store that fails is said.
     */
    async run(body, ctx) {
      const fence = fenceOf(body)
      if (fence.botId !== undefined || fence.client !== undefined || fence.draftOnly) throw new RouteError(403, "these routes are main's: a bot key writes through /internal/doc/*")
      const name = str(body, 'name', 600)
      // The relay wrote its frames before this was asked: one turn of the loop reads them into each socket's queue.
      await new Promise((resolve) => setImmediate(resolve))
      const document = ctx.collab.hocuspocus.documents.get(name)
      // Not in memory: an unload stores first, so nothing it held waits to be stored.
      if (!document) return { ok: true }
      await Promise.all(document.getConnections().map((c) => c.waitForPendingMessages()))
      // This document alone, in its own save turn, its store's answer read back (docs/storeBook.ts): ok only once its
      // state is on disk. A store that merged another writer's first is stored again.
      const payload = { clientsCount: document.getConnectionsCount(), document, documentName: name, instance: ctx.collab.hocuspocus, lastContext: {}, lastTransactionOrigin: { source: 'local', context: {} } }
      for (let tries = 0; tries < 3; tries++) {
        ctx.stores?.take(name)
        try {
          await document.saveMutex.runExclusive(() => ctx.collab.hocuspocus.hooks('onStoreDocument', payload as never))
        } catch (err) {
          throw new RouteError(503, `the document was not stored: ${err instanceof Error ? err.message : String(err)}`)
        }
        const got = ctx.stores?.take(name)
        if (!got || 'ok' in got) return { ok: true }
        if ('failed' in got) throw new RouteError(503, `the document was not stored: ${got.failed}`)
      }
      throw new RouteError(503, 'the document was not stored: another writer kept storing first')
    }
  },
  {
    path: '/internal/docs/mark',
    milestone: 20,
    /** A comment thread's mark on the first place the words stand (a table's cell included). */
    async run(body, ctx) {
      const t = await targetOf(body, ctx)
      const quote = str(body, 'quote', 2000)
      const threadId = str(body, 'threadId', 64)
      let marked = false
      await ctx.collab.edit(
        t.name,
        principalOf(body),
        (doc) => {
          const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT)
          const at = findQuote(fragment, quote)
          if (at) marked = setThreadMark(fragment, at, threadId)
        },
        t.file
      )
      return { marked }
    }
  }
]
