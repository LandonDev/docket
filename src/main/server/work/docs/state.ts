import type { DatabaseSync } from 'node:sqlite'
import type { DocMode, DocsPush, DocWritten } from '@shared/contract-work-docs'
import type { WorkCtx } from '../modules'
import { createRelay, type Relay } from './relay'

/**
 * What the docs pillar keeps on a host (docs/agents/work-docs.md): each
 * document's mode in `work_docs_mode`, the agent's last direct write for the
 * bar's Undo line (in memory: after a restart the line is gone and History
 * still has the version), and the relayed sockets. One per context.
 */

export interface DocsState {
  relay: Relay
  written: Map<string, DocWritten>
  /** to every window, or for a file only those whose caller could name it (`PushTo.path`) */
  push(p: DocsPush, path?: string): void
  /** LifeOS thread subscriptions held while a document has a socket open */
  watching: Map<string, () => void>
}

// Keyed by the host's database: a tool's context is a fresh object each call, over the same host.
const states = new WeakMap<object, DocsState>()

export function ensureModeTable(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS work_docs_mode (doc TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('suggests', 'writes')))")
}

export function docsOf(ctx: WorkCtx): DocsState {
  let s = states.get(ctx.db)
  if (!s) {
    const state: DocsState = {
      relay: createRelay({ onDocs: (docs) => watch(ctx, state, docs) }),
      written: new Map(),
      push: (p, path) => ctx.push(p, path ? { path } : undefined),
      watching: new Map()
    }
    states.set(ctx.db, state)
    s = state
  }
  return s
}

/** Stops what a context's state holds: its sockets and subscriptions. */
export function stopDocs(ctx: WorkCtx): void {
  const s = states.get(ctx.db)
  if (!s) return
  states.delete(ctx.db)
  s.relay.stop()
  for (const off of s.watching.values()) off()
  s.watching.clear()
}

/** A LifeOS document's threads change elsewhere too (LifeOS desktop, the phone): held while it is open here. */
function watch(ctx: WorkCtx, s: DocsState, docs: Set<string>): void {
  for (const [doc, off] of s.watching) {
    if (docs.has(doc)) continue
    off()
    s.watching.delete(doc)
  }
  for (const doc of docs) {
    if (s.watching.has(doc) || doc.startsWith('file:') || !ctx.lifeos.connected()) continue
    let first = true
    try {
      s.watching.set(
        doc,
        ctx.lifeos.subscribe('docs:threads', { docId: doc }, () => {
          if (first) return void (first = false)
          s.push({ push: 'work.docs', doc, threads: true })
        })
      )
    } catch (err) {
      ctx.log(`[docs] could not watch ${doc}'s threads: ${(err as Error).message}`)
    }
  }
}

export function modeOf(ctx: WorkCtx, doc: string): DocMode {
  const row = ctx.db.prepare('SELECT mode FROM work_docs_mode WHERE doc = ?').get(doc) as { mode: DocMode } | undefined
  return row?.mode ?? 'writes'
}

export function setMode(ctx: WorkCtx, doc: string, mode: DocMode, path?: string): void {
  ctx.db.prepare('INSERT INTO work_docs_mode (doc, mode) VALUES (?, ?) ON CONFLICT(doc) DO UPDATE SET mode = excluded.mode').run(doc, mode)
  docsOf(ctx).push({ push: 'work.docs', doc, mode }, path)
}

/** The agent wrote directly: the bar shows it, with Undo, until it is undone or dismissed. */
export function wrote(ctx: WorkCtx, doc: string, written: DocWritten, path?: string): void {
  const s = docsOf(ctx)
  s.written.set(doc, written)
  s.push({ push: 'work.docs', doc, written }, path)
}

/** The line goes; with `after`, only while it is still the line of that write (a newer write's line stays). */
export function dismissWritten(ctx: WorkCtx, doc: string, path?: string, after?: string): void {
  const s = docsOf(ctx)
  if (after !== undefined && s.written.get(doc)?.after !== after) return
  if (!s.written.delete(doc)) return
  s.push({ push: 'work.docs', doc, written: null }, path)
}
