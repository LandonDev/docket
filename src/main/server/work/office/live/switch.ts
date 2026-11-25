import { rmSync, statSync } from 'node:fs'
import type { FileTab } from '@shared/contract-work-files'
import { APP_CANVAS, type OfficeLiveApp, type OfficeLiveMode, type OfficeLiveSet } from '@shared/contract-work-office'
import { canvasSourcePath, filesPaneOf, type CanvasSource } from '@shared/work'
import { refKey } from '@shared/work/files'
import { isLiveSource } from '@shared/work/officeLive'
import { copyWaits } from '../../files/copyKept'
import { copyKeep, copyRecord, copyRowOf, sendBack } from '../../files/copies'
import { doorPlace, filesState, reseat } from '../../files/handle'
import type { Seat, SeatAsk } from '../../files/hooks'
import { libraryKey } from '../../files/places/teams'
import { locate } from '../../files/policy'
import { uploadOwed } from '../../files/uploads'
import { keptDoc, recordWord, wordsAllInFile, type WordRow } from '../../files/word'
import { versionOf } from '../../files/write'
import type { Caller, WorkCtx } from '../../modules'
import { isGuestPath, vmStat } from '../vm/files'
import { vmState } from '../vm/office'
import { appOf } from './address'
import { liveFileOf, tabFile } from './handle'
import { liveBase, modeOf, setLiveBase, setMode } from './memory'

/**
 * A Files tab between Edit here and Live (the plan's "Switching"): its item swapped in place, the tab and its key kept,
 * the mode remembered by that key. Nothing he changed is dropped on the way: a copy's send is awaited, a copy that could
 * not send asks, and a Word file's document with edits the Word file has not asks. And the seat chooser Files asks
 * before it opens a file (files/hooks.ts): a file remembered as Live opens on the web, with no copy and no VM woken.
 */

const SET = 'work.office.live.set'
const OPEN = 'work.files.open'
const DONE: OfficeLiveSet = { is: 'done' }
/** His window: what the host itself reads a file's version as. */
const HIS: Caller = { kind: 'local', caps: ['read', 'operate', 'approve'] }
/**
 * How long a switch waits: for a copy's send, for OneDrive to take that send up, for OneDrive to bring Word's edits
 * down, and between looks (a test shortens them).
 */
export const liveTiming = { send: 30_000, upload: 30_000, version: 60_000, look: 1_000 }

const mtimeOf = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}
const nameOf = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
const liveSource = (ctx: WorkCtx, app: OfficeLiveApp, name: string, url: string): CanvasSource => ({ at: 'microsoft', app, host: ctx.host, name, ref: { kind: 'url', url } })
const pause = (ms: number): Promise<void> =>
  new Promise((done) => {
    const timer = setTimeout(done, Math.max(0, ms))
    ;(timer as { unref?: () => void }).unref?.()
  })

/** A Word file's document holds edits the Word file has not, asked now (word.ts `wordsAllInFile`): never what the autosave saw last. */
const unsaved = async (ctx: WorkCtx, r: WordRow): Promise<boolean> => !(await wordsAllInFile(ctx, r))

// ── opening ───────────────────────────────────────────────────────────

/**
 * files/hooks.ts's seat chooser. A shared Office file whose remembered mode is Live, and that has an address on the
 * web, opens as its app's kind with a Microsoft source named by that address. The key is the one Files would give
 * the tab. Anything else is Files' own: a tab that holds the file already, an open that names its kind or a seat
 * beside, a copy whose changes wait, a Word file's document with edits the file has not.
 */
export async function liveSeat(ctx: WorkCtx, by: Caller, ask: SeatAsk, signal?: AbortSignal): Promise<Seat | null> {
  if (by.kind === 'model' || ask.as || ask.beside || ask.side) return null
  const path = canvasSourcePath(ask.ref)
  if (path === null) return null
  const name = ask.name ?? nameOf(path)
  const app = appOf(name)
  if (!app) return null
  const host = (ask.ref as { host: string }).host
  // Another host's file and one in this host's VM open as copies in Files, keyed as `openCopy` keys them.
  const far = host !== ctx.host || (isGuestPath(path) && process.platform !== 'win32')
  try {
    let key: string
    if (far) {
      key = ask.key ?? refKey({ at: 'file', host, path })
      // Remembered as Edit here (the fallback answers only where no row does): nothing is asked of the other host.
      if (modeOf(ctx.db, ask.workspaceId, key, null, 'live') === 'here') return null
    } else {
      const at = locate(ctx, by, ask.workspaceId, ask.ref, OPEN)
      if (at.in !== 'library') return null
      key = libraryKey(doorPlace(ctx, by, at).library!, at.path)
      // A file of this host that opens here asks nothing of another host.
      if (modeOf(ctx.db, ask.workspaceId, key, at.library.id) !== 'live') return null
    }
    if (filesState(ctx).tabs.tabOf(ask.workspaceId, key)) return null
    if (far) {
      const copy = copyRecord(ctx, ask.workspaceId, host, path)
      const word = keptDoc(ctx, ask.workspaceId, host, path)
      if ((copy && copyWaits(copy)) || (word && (await unsaved(ctx, word)))) return null
    }
    const of = await liveFileOf(ctx, by, ask.workspaceId, { host, path }, key, { signal })
    if (of.mode !== 'live' || !of.address) return null
    const copyOf = far ? { copyOf: { host, path, ...(host === ctx.host ? { vm: true } : {}) } } : {}
    // Opened live, a saved document made of the Word file goes, as on a switch: a later Edit here reads the file afresh.
    if (far) await forgetKept(ctx, ask.workspaceId, { copyOf: { host, path } } as FileTab)
    await keepBase(ctx, ask.workspaceId, key, { host, path }, signal)
    return { key, name, kind: APP_CANVAS[app], source: liveSource(ctx, app, name, of.address), file: { host, path }, ...copyOf }
  } catch {
    // Files' own open says what is wrong with it.
    return null
  }
}

// ── switching ─────────────────────────────────────────────────────────

const COPY_WORDS = {
  changed: (name: string) => `${name} changed on its computer since you opened it. Keep Both saves your changes beside it.`,
  gone: (name: string) => `${name} was moved or deleted on its computer. Keep Both saves your changes beside where it was.`,
  away: (name: string) => `Your changes to ${name} have not reached its computer, which is not answering. They are sent when it answers.`,
  refused: (name: string, detail: string | null) => `Your changes to ${name} were refused${detail ? `: ${detail}` : '.'}`
}

/**
 * What waits in a tab before it goes Live: a copy's send (awaited, 30 s at most), a copy that could not send (asked,
 * or Keep Both with `keep-both`), a Word file's document with edits the file has not (asked). Null: nothing waits.
 */
async function waiting(ctx: WorkCtx, by: Caller, workspaceId: string, tab: FileTab, choice: 'keep-both' | undefined): Promise<OfficeLiveSet | null> {
  const of = tab.copyOf
  if (!of) return null
  const r = copyRecord(ctx, workspaceId, of.host, of.path)
  if (r) {
    // What his kind saved last goes first, or the send under way lands; a send never throws.
    await Promise.race([sendBack(ctx, r.id), pause(liveTiming.send)])
    const now = copyRowOf(ctx, r.id)
    const why = !now || now.state === 'ok' ? null : now.state === 'sending' ? 'away' : now.state
    if (why && choice !== 'keep-both') return { is: 'ask', why, words: why === 'refused' ? COPY_WORDS.refused(r.name, now!.detail) : COPY_WORDS[why](r.name) }
    // Over a file that did not answer nothing can go beside it: the copy is kept and sent once it answers (copiesLeft).
    if (why && why !== 'away') await copyKeep(ctx, by, { workspaceId, tabId: tab.id })
  }
  const word = keptDoc(ctx, workspaceId, of.host, of.path)
  if (word && (await unsaved(ctx, word))) return { is: 'ask', why: 'word', words: `Your edits to ${word.name} are not in the Word file yet.` }
  return null
}

/**
 * A Word file's document whose edits are all in the Word file goes once the tab is Live: a later Edit here reads the
 * Word file again, never this document over a newer file. One he changed since (`unsaved`) stays.
 */
async function forgetKept(ctx: WorkCtx, workspaceId: string, tab: FileTab): Promise<void> {
  const r = tab.copyOf ? keptDoc(ctx, workspaceId, tab.copyOf.host, tab.copyOf.path) : null
  if (!r) return
  const at = mtimeOf(r.doc!)
  if (await unsaved(ctx, r)) return
  // Asked again after the wait: saved, made again or written meanwhile, it stays.
  const now = keptDoc(ctx, workspaceId, r.host, r.path)
  if (!now || now.doc !== r.doc || now.saved_rev !== r.saved_rev || mtimeOf(r.doc!) !== at) return
  recordWord(ctx, { workspaceId, host: r.host, path: r.path, vm: !!r.vm, name: r.name, version: r.version, sha: r.sha as string })
  rmSync(r.doc!, { force: true })
}

/**
 * The file's version on its own computer, by one look; null when it does not answer. Never wakes the VM for it: Edit
 * here does. `now`: the holder's own clock as it looked, which its change time is read against; none from the VM's
 * guest (its helper does not say it yet) or a host a build behind.
 */
async function versionNow(ctx: WorkCtx, workspaceId: string, ref: { host: string; path: string }, signal?: AbortSignal): Promise<{ word: string; changed: number; now?: number } | null> {
  try {
    if (ref.host !== ctx.host) {
      const far = ctx.peer.call({ scope: { sessionId: filesPaneOf(workspaceId), workspaceId }, signal } as never, ref.host)
      const got = (await far.call('files', 'stat', { workspaceId, refs: [{ at: 'file', host: ref.host, path: ref.path }] })) as { entries: ({ size?: number; changed?: number } | null)[]; now?: number }
      const e = got.entries[0]
      return typeof e?.changed === 'number' ? { word: `${e.size ?? 0}:${e.changed}`, changed: e.changed, ...(typeof got.now === 'number' ? { now: got.now } : {}) } : null
    }
    const at = locate(ctx, HIS, workspaceId, { at: 'file', host: ref.host, path: ref.path }, SET)
    if (at.in === 'library' && at.library.vm) {
      if (vmState()?.state !== 'awake') return null
      const e = await vmStat(at.library.id, at.path, signal)
      return { word: `${e.size}:${e.modified}`, changed: e.modified }
    }
    if (at.in !== 'library' && at.in !== 'folder') return null
    // By its bytes where this host can hash them: a new time alone (a restamp, a sync touching it) is no change.
    const v = await versionOf(at.path)
    return { word: v.sha256 ? `sha256:${v.sha256}` : `${v.size}:${Math.round(v.mtimeMs)}`, changed: Math.round(v.mtimeMs), now: Date.now() }
  } catch {
    return null
  }
}

/** The file's version as its tab goes live, kept for Edit here (memory.ts `liveBase`). */
async function keepBase(ctx: WorkCtx, workspaceId: string, key: string, ref: { host: string; path: string }, signal?: AbortSignal): Promise<void> {
  setLiveBase(ctx.db, workspaceId, key, (await versionNow(ctx, workspaceId, ref, signal))?.word ?? null)
}

/**
 * He typed in the live view: OneDrive brings Word's edits down to the file's computer. Waits until the file holds a
 * change made after his last key there (`quiet` ms before the press), 60 s at most, its time read by the holder's own
 * clock (this host's, or his desktop's as its look answers it): one already there, else the next one seen whose time
 * is after his last key. A sync of a save from before his last key, early or late, is not that change. Where the
 * holder gives no clock (the VM's guest), the next change seen after the press. A window that does not say `quiet`
 * waits for any change since the tab went live (`base`). Answers whether it moved; when it did not, nothing proves the
 * file holds his typing, and the live seat stays.
 */
async function versionMoved(ctx: WorkCtx, workspaceId: string, ref: { host: string; path: string }, base: string | null, since: number, quiet: number | undefined, signal?: AbortSignal): Promise<boolean> {
  const first = await versionNow(ctx, workspaceId, ref, signal)
  if (first && quiet === undefined && base !== null && first.word !== base) return true
  // His last key by the holder's clock; for a tab live from before its version was kept, the live view's opening by this host's.
  const ownClock = ref.host === ctx.host && !(isGuestPath(ref.path) && process.platform !== 'win32')
  const after = quiet !== undefined && first?.now !== undefined ? first.now - quiet : quiet === undefined && ownClock ? since : null
  if (first && after !== null && (quiet !== undefined || base === null) && (base === null || first.word !== base) && first.changed > after) return true
  const from = quiet === undefined ? (base ?? first?.word ?? null) : (first?.word ?? base)
  const end = Date.now() + liveTiming.version
  while (Date.now() < end && !signal?.aborted) {
    await pause(Math.min(liveTiming.look, end - Date.now()))
    const now = await versionNow(ctx, workspaceId, ref, signal)
    if (now && now.word !== from && (quiet === undefined || after === null || now.changed > after)) return true
  }
  return false
}

/**
 * Live shows the file in Teams, so a send of ours goes up first (files/uploads.ts): waits while OneDrive on the file's
 * computer still owes it, 30 s at most. A file no send of ours wrote, or one on a computer that cannot say, waits for
 * nothing. Answers whether nothing is owed.
 */
async function uploaded(workspaceId: string, ref: { host: string; path: string }, signal?: AbortSignal): Promise<boolean> {
  const end = Date.now() + liveTiming.upload
  while (uploadOwed(workspaceId, ref.host, ref.path)) {
    if (Date.now() >= end || signal?.aborted) return false
    await pause(Math.min(liveTiming.look, end - Date.now()))
  }
  return true
}

/** `work.office.live.set`: his press on the tab's mode. */
export async function liveSet(ctx: WorkCtx, by: Caller, p: { workspaceId: string; tabId: string; mode: OfficeLiveMode; typed?: number; quiet?: number; choice?: 'keep-both' }, signal?: AbortSignal): Promise<OfficeLiveSet> {
  if (by.kind === 'model') throw new Error('A Files tab is switched from his window.')
  const { tab, item, ref } = tabFile(ctx, by, p.workspaceId, p.tabId)
  if (tab.kind !== 'file' || !item || !ref || !appOf(ref.path)) throw new Error('That tab shows no shared Office file.')
  const live = isLiveSource(item.source)
  if (p.mode === 'here') {
    if (live) {
      if (p.typed && !(await versionMoved(ctx, p.workspaceId, ref, liveBase(ctx.db, p.workspaceId, tab.key ?? ''), item.createdAt, p.quiet, signal)))
        throw new Error(`What you typed in ${nameOf(ref.path)} has not come down from OneDrive yet, so it stays live. Try again in a moment.`)
      await reseat(ctx, p.workspaceId, tab.id, by, signal)
    }
    setMode(ctx.db, p.workspaceId, tab.key ?? '', 'here')
    return DONE
  }
  if (!live) {
    // An address first, so nothing is asked, or kept beside, for a file that cannot open live.
    let of = await liveFileOf(ctx, by, p.workspaceId, ref, tab.key ?? '', { signal })
    if (!of.address) throw new Error(of.why ?? 'This file has no address on the web.')
    const asked = await waiting(ctx, by, p.workspaceId, tab, p.choice)
    if (asked) return asked
    // Keep Both moves the tab to the file it made beside the one that changed: that file is the one shown live.
    const now = tabFile(ctx, by, p.workspaceId, p.tabId)
    if (!now.item || !now.ref) throw new Error('That Files tab is closed.')
    if (now.tab.key !== tab.key) of = await liveFileOf(ctx, by, p.workspaceId, now.ref, now.tab.key ?? '', { signal })
    if (!of.address || !of.app) throw new Error(of.why ?? 'This file has no address on the web.')
    const name = nameOf(now.ref.path)
    // The copy's send went up to Teams, or Live would show the file without it.
    if (!(await uploaded(p.workspaceId, now.ref, signal))) throw new Error(`Your changes to ${name} are still uploading to OneDrive. Try Live again in a moment.`)
    ctx.canvas.replace(now.item.sessionId, now.item.id, APP_CANVAS[of.app], liveSource(ctx, of.app, name, of.address), name)
    await forgetKept(ctx, p.workspaceId, now.tab)
    setMode(ctx.db, p.workspaceId, now.tab.key ?? '', 'live')
    await keepBase(ctx, p.workspaceId, now.tab.key ?? '', now.ref, signal)
    return DONE
  }
  setMode(ctx.db, p.workspaceId, tab.key ?? '', 'live')
  return DONE
}
