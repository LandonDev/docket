import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import * as Y from 'yjs'
import { DOCUMENT_FRAGMENT, findQuote, setThreadMark } from 'work-kit/collab'
import { fileDocName, readDocument, writeMarkdown, type CollabContext, type CollabFile } from 'work-kit/collab-server'
import type { BlockDiff } from 'work-kit/formats/diff'
import { docIn, fenceOf, servingHere, str } from '../service/routes/internal'
import { RouteError, type InternalRoute, type RouteCtx } from '../service/routes/route'
import { documentStyleLines } from './formatDescription'
import { formatRouteFields } from './formatInput'
import { revisionOf } from './revision'

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

/** A document's state as one word: its Yjs snapshot (state vector and delete set) hashed; any edit moves it, a deletion alone included. */
const stateRev = (doc: Y.Doc): string => createHash('sha256').update(Y.encodeSnapshot(Y.snapshot(doc))).digest('hex').slice(0, 32)

/** The live document's state word now. */
async function liveRev(ctx: RouteCtx, t: Target): Promise<string> {
  let rev = ''
  await ctx.collab.edit(t.name, 'owner', (doc) => void (rev = stateRev(doc)), t.file)
  return rev
}

/**
 * Whether a direct format's after-version holds formatting alone over its before-version: no words put in, taken out
 * or moved, in a block or a table's cell. Anything else in it is someone's edit landed between the format and its
 * cut, which an Undo of the format would take back too. A change of his that is formatting too, made in the same
 * instant, is not told apart (work-kit makes the edit and both cuts with no point at which the host can take the state).
 */
function formattingAlone(diff: BlockDiff): boolean {
  const words = (ops: readonly { op: string }[] | null | undefined): boolean => !!ops?.some((op) => op.op !== '=')
  return diff.stats.added + diff.stats.removed + diff.stats.moved === 0 && diff.rows.every((row) => !words(row.inline) && !row.cells?.some((cells) => cells.some((cell) => words(cell))))
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
      return { rev: await liveRev(ctx, t) }
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
          const text = readDocument(doc.getXmlFragment(DOCUMENT_FRAGMENT))
          // The revision of this very text: an agent's rewrite is checked against it (docs/revision.ts).
          return { ...text, shared: t.shared, styles: documentStyleLines(doc), revision: revisionOf(text.markdown) }
        } finally {
          await direct.disconnect({ unloadImmediately: false })
        }
      }
      if (body.with !== undefined) throw new RouteError(400, 'with is styles')
      const live = await ctx.collab.read(t.name, t.file)
      return { markdown: live.markdown, plain: live.plain, shared: t.shared, revision: revisionOf(live.markdown) }
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
      const revision = body.revision === undefined ? undefined : str(body, 'revision', 64)
      const principal = principalOf(body)
      const suggest = body.suggest === true
      const file = t.file ? { file: t.file } : {}
      const verdict = suggest ? 'own' : because
      const shared = suggest || t.shared
      // In the document's turn: no restore, accept or other write lands between the check and the write.
      return ctx.history.inTurn(t.name, async (raw) => {
        if (verdict === 'own' && shared) {
          // A suggestion: the text it was drafted from, checked just before the branch is made; what lands after is
          // his to see in the suggestion, never written into the document.
          if (revision !== undefined && revisionOf((await ctx.collab.read(t.name, t.file)).markdown) !== revision) return { stale: true }
          return { ...(await raw.write(t.name, principal, markdown, { because: verdict, shared, ...file })), shared: t.shared }
        }
        // A write that goes straight in: the version just before it is what its Undo goes back to. Nothing changed
        // since the last version: that one. The live state on each side of the cut says whether the version is it.
        const ahead = await liveRev(ctx, t)
        const before = await raw.cut(t.name, 'before-agent', file)
        const cutAt = await liveRev(ctx, t)
        // The revision is checked on the live text in the very tick the rewrite is made of it (collab.edit's copy):
        // a word he typed after the agent read is never written over.
        let stale = false
        let changed = 0
        // The states just before and just after the rewrite, taken in the same tick it is made: the two versions its
        // Undo goes between must be them.
        let prior = ''
        let left = ''
        await ctx.collab.edit(
          t.name,
          principal,
          (doc) => {
            const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT)
            if (revision !== undefined && revisionOf(readDocument(fragment).markdown) !== revision) return void (stale = true)
            prior = stateRev(doc)
            changed = writeMarkdown(fragment, markdown).changed
            left = stateRev(doc)
          },
          t.file
        )
        if (stale) return { stale: true }
        if (changed === 0) return { mode: 'direct', versionId: null, shared: t.shared }
        const row = await raw.cut(t.name, 'agent-turn', file)
        // The version before is the state the rewrite was made on only if nothing changed across its cut or between it
        // and the edit (his margins, a word); the version after is the rewrite's own state only if nothing changed since.
        // Else an Undo between them would take his change back too: none is offered.
        const undoable = ahead === cutAt && prior === cutAt && (await liveRev(ctx, t)) === left
        return { mode: 'direct', versionId: row.id, beforeVersionId: before.id, shared: t.shared, undoable }
      })
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
      return ctx.history.inTurn(t.name, async (raw) => {
        const done = await raw.format(t.name, principal, change, {
          because: suggest ? 'own' : because,
          shared: suggest || t.shared,
          ...(t.file ? { file: t.file } : {}),
          ...(paper ? { paper } : {})
        })
        // Its Undo is offered only while its after-version holds the format alone (`formattingAlone`).
        const direct = done.mode === 'direct' && done.versionId && done.beforeVersionId
        const undoable = direct ? formattingAlone(await raw.compare(t.name, done.beforeVersionId!, done.versionId!, t.file)) : false
        return { ...done, shared: t.shared, undoable }
      })
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
    path: '/internal/docs/undo',
    milestone: 20,
    /**
     * The bar's Undo of an agent's write (work.docs.dismiss with `undo`): the version before it is restored only while
     * the live document is still the write's own version (`after`), the check and the restore in the document's turn,
     * so no restore, accept or write lands between them. Anyone's change since: nothing is restored.
     */
    async run(body, ctx) {
      const t = await targetOf(body, ctx)
      const versionId = str(body, 'versionId', 64)
      const after = str(body, 'after', 64)
      const file = t.file ? { file: t.file } : {}
      return ctx.history.inTurn(t.name, async (raw) => {
        const diff = await raw.compare(t.name, after, 'live', t.file)
        const { added, removed, changed, moved } = diff.stats
        if (added + removed + changed + moved > 0 || diff.page?.length) return { undone: false }
        await raw.restore(t.name, versionId, { principal: 'owner', shared: t.shared, ...file })
        return { undone: true }
      })
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
