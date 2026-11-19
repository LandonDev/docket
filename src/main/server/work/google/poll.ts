import type { TriggerSource } from '@shared/work'
import { errorText } from '@shared/work/ids'
import type { WorkCtx } from '../modules'
import { googleOf } from './google'

/**
 * The Drive version poll (docs/agents/work-google.md "Changes"): while a
 * Google file is open in a canvas, its Drive `version` is read once a minute.
 * A version this host's own write made passes quietly; any other is someone
 * else's change, which tells the file's open items (a sheet's grid reads it
 * again, a Doc says Google moved) and fires the routines watching it. Nothing
 * is polled for a file no item has open: Google has no live feed for Docs
 * and this is not a mirror.
 */

export const POLL_MS = 60_000

interface Watched {
  account: string
  fileId: string
  name: string
  /** the canvas items showing it */
  items: Set<string>
  /** the version last heard */
  heard: string | null
}

const watched = new Map<string, Watched>()
/** what wants to hear of someone else's change, by file */
const listeners = new Map<string, Set<(name: string) => void>>()
const keyOf = (account: string, fileId: string) => `${account.toLowerCase()}/${fileId}`

/** An item shows this file: poll it while that item is open. */
export function watch(account: string, fileId: string, name: string, itemId: string): void {
  const key = keyOf(account, fileId)
  let w = watched.get(key)
  if (!w) watched.set(key, (w = { account, fileId, name, items: new Set(), heard: null }))
  w.items.add(itemId)
  w.name = name
}

/** Hears someone else's change to a file while it is polled. Returns the off. */
export function onChange(account: string, fileId: string, fn: (name: string) => void): () => void {
  const key = keyOf(account, fileId)
  let set = listeners.get(key)
  if (!set) listeners.set(key, (set = new Set()))
  set.add(fn)
  return () => void set.delete(fn)
}

export const watchedFiles = (): Watched[] => [...watched.values()]

/** One pass: each watched file whose items are all closed is dropped; the rest are read. */
export async function pollOnce(ctx: WorkCtx, told: (w: Watched) => void): Promise<void> {
  const g = googleOf(ctx)
  for (const [key, w] of watched) {
    for (const id of w.items) if (ctx.canvas.get(id)?.state !== 'open') w.items.delete(id)
    if (!w.items.size) {
      watched.delete(key)
      continue
    }
    try {
      const { version, name } = await g.api(w.account).file(w.fileId)
      const row = g.files.get(w.account, w.fileId)
      const was = w.heard ?? row?.version ?? null
      w.heard = version
      w.name = name
      if (was === null || version === was || version === row?.ours) continue
      told(w)
      for (const fn of listeners.get(key) ?? []) fn(name)
    } catch (err) {
      ctx.log(`google: version poll of ${w.name}: ${errorText(err)}`)
    }
  }
}

/** Starts the poll; its return stops it. */
export function startPoll(ctx: WorkCtx, told: (w: Watched) => void): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    void pollOnce(ctx, told).finally(() => (running = false))
  }, POLL_MS)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    watched.clear()
  }
}

/** A routine's `file` trigger on a Google file: fires on someone else's change, heard while the file is open. */
export const googleChanges: TriggerSource = {
  on: 'file',
  at: 'google',
  words: (t) => (t.on === 'file' && t.source.at === 'google' ? 'When someone changes it in Google' : 'When the file changes'),
  arm(t, fire) {
    if (t.on !== 'file' || t.source.at !== 'google') return () => {}
    return onChange(t.source.account, t.source.fileId, (name) => fire(`${name} changed in Google`))
  }
}
