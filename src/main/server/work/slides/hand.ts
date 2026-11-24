import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { CanvasItem } from '@shared/work'
import type { DeckVersion, SlideOp } from '@shared/contract-work-slides'
import { copyWhole } from '../pdf/file'
import { sweepAttached, withAttached } from './attach'
import { joinStep, splitStep, type DeckInfo } from './deck'
import { HAND_STEPS, hands, lineOf } from './handLine'
import { SlidesStore } from './store'
import { CHANGED_WHILE, deckDir, deckKey, deckPath, handKey, hashFile, isFirstVersion, keepHistory, keepOutline, outlineAt, replaceKeeping, scratch, serial, sharedJob, versionAt, type Ctx } from './view'

/**
 * His own edits to a deck (docs/agents/work-slides.md "Edits by hand"). An
 * edit is written into the file at once, through the same script and the
 * same byte rule as an accepted suggestion. Undo and Redo walk his edits by
 * packs: with each edit the script hands back what turns the new deck into
 * the old one, part for part, and taking an edit back hands back what puts
 * it in again. The packs are files in the deck's `undo/` folder; which
 * comes next is kept here in memory, so his undo ends when the app does, as
 * it does in PowerPoint.
 *
 * The line of edits holds only while the file is what his last edit, undo
 * or redo left: an accepted suggestion, an agent's write, a restored
 * version or a save from another program ends it, and both are then off.
 */

const drop = (dir: string, names: ReadonlyArray<string | null>): void => {
  for (const name of names) if (name) rmSync(join(dir, name), { force: true })
}
const packName = (): string => `${Date.now().toString().padStart(15, '0')}-${randomUUID().slice(0, 8)}.pack`

/** Whether the shape a box's edit names still holds the words its `from`s were read from (`was`). */
function sameWords(info: DeckInfo, op: Extract<SlideOp, { op: 'runs' }>): boolean {
  const shape = info.slides.find((s) => s.id === op.slide)?.shapes.find((s) => s.id === op.shape)
  return !!shape && JSON.stringify((shape.paragraphs ?? []).map((p) => p.runs.map((r) => r.text).join(''))) === JSON.stringify(op.was)
}

/**
 * Writes his edits into the file, whole or not at all, and keeps the pack that takes them back. The file is
 * replaced only while it is still what was read; a copy from before is kept once a minute (`keepHistory`).
 */
export async function handEdit(ctx: Ctx, item: CanvasItem, ops: SlideOp[], signal?: AbortSignal): Promise<void> {
  await serial(ctx, item, async () => {
    const path = await deckPath(ctx, item)
    const dir = await deckDir(ctx, item, 'undo')
    const [base, out, next, pack, info] = await Promise.all(['hand', 'step', 'next', 'pack', 'info'].map((what) => scratch(ctx, item, what)))
    let used: string[] = []
    try {
      copyWhole(path, base)
      const was = hashFile(base)
      // A box's words go only over the words it was opened on: saved over since (in PowerPoint, from another window),
      // the edit is refused before it is made, and his window keeps the words for Reload.
      const boxes = ops.filter((op): op is Extract<SlideOp, { op: 'runs' }> => op.op === 'runs' && op.was !== undefined && op.row === undefined)
      if (boxes.length) {
        const info = await outlineAt(ctx, item, base, was, signal)
        if (!boxes.every((op) => sameWords(info, op))) throw new Error(CHANGED_WHILE)
      }
      const hand = lineOf(handKey(ctx, item), dir, was)
      // The files his edit brings (a picture, a video) ride with the deck as one input, and go once they are in the file.
      const attach = await deckDir(ctx, item, 'attach')
      const job = withAttached(attach, await scratch(ctx, item, 'plus'), base, ops)
      try {
        await ctx.convert({ from: job.from, to: 'pptxstep', input: job.input, output: out, options: { ops: job.ops, ...(job.files.length ? { files: job.files } : {}) }, ...sharedJob(ctx, item), ...(signal ? { signal } : {}) })
      } finally {
        job.done()
      }
      used = ops.flatMap((op) => (op.op === 'insert' && op.file ? [op.file] : []))
      splitStep(out, [next, pack, info])
      await keepHistory(ctx, item, base, true)
      const name = packName()
      renameSync(pack, join(dir, name))
      try {
        replaceKeeping(path, next, was)
      } catch (err) {
        rmSync(join(dir, name), { force: true })
        throw err
      }
      // What he had taken back is gone once he edits again.
      drop(dir, hand.steps.splice(hand.at).flatMap((s) => [s.undo, s.redo]))
      hand.steps.push({ undo: name, redo: null })
      drop(dir, hand.steps.splice(0, Math.max(0, hand.steps.length - HAND_STEPS)).flatMap((s) => [s.undo, s.redo]))
      hand.at = hand.steps.length
      hand.hash = hashFile(path)
      // The tool read the new deck's outline in the same run: kept, so the view is not read again.
      await keepOutline(ctx, item, hand.hash, info)
      sweepAttached(attach, new SlidesStore(ctx.db).pending(deckKey(item)).map((p) => p.op), used)
    } finally {
      for (const f of [base, out, next, pack, info]) rmSync(f, { force: true })
    }
  })
}

/** Takes his last edit back, or puts back the one he took back, while the file is still what his edits left. */
export async function handStep(ctx: Ctx, item: CanvasItem, dir: 'undo' | 'redo', signal?: AbortSignal): Promise<void> {
  await serial(ctx, item, async () => {
    const path = await deckPath(ctx, item)
    const folder = await deckDir(ctx, item, 'undo')
    const [base, joined, out, next, back, info] = await Promise.all(['hand', 'in', 'step', 'next', 'pack', 'info'].map((what) => scratch(ctx, item, what)))
    try {
      copyWhole(path, base)
      const was = hashFile(base)
      const hand = hands.get(handKey(ctx, item))
      const step = hand && hand.hash === was ? (dir === 'undo' ? hand.steps[hand.at - 1] : hand.steps[hand.at]) : undefined
      const pack = dir === 'undo' ? step?.undo : step?.redo
      if (!hand || !step || !pack || !existsSync(join(folder, pack))) throw new Error(dir === 'undo' ? 'There is nothing to undo: the deck has changed since your last edit.' : 'There is nothing to redo.')
      joinStep([base, join(folder, pack)], joined)
      await ctx.convert({ from: 'pptxstep', to: 'pptxstep', input: joined, output: out, ...sharedJob(ctx, item), ...(signal ? { signal } : {}) })
      splitStep(out, [next, back, info])
      const name = packName()
      renameSync(back, join(folder, name))
      try {
        replaceKeeping(path, next, was)
      } catch (err) {
        rmSync(join(folder, name), { force: true })
        throw err
      }
      rmSync(join(folder, pack), { force: true })
      if (dir === 'undo') Object.assign(step, { undo: null, redo: name })
      else Object.assign(step, { undo: name, redo: null })
      hand.at += dir === 'undo' ? -1 : 1
      hand.hash = hashFile(path)
      await keepOutline(ctx, item, hand.hash, info)
    } finally {
      for (const f of [base, joined, out, next, back, info]) rmSync(f, { force: true })
    }
  })
}

/** The kept copies of the deck, newest first. */
export async function versionsOf(ctx: Ctx, item: CanvasItem): Promise<DeckVersion[]> {
  const dir = await deckDir(ctx, item, 'history')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.pptx'))
    .sort()
    .reverse()
    .flatMap((id) => {
      try {
        return [{ id, at: versionAt(id), size: statSync(join(dir, id)).size, first: isFirstVersion(id) }]
      } catch {
        return []
      }
    })
}

/** Puts a kept copy in the file's place. The deck as it is now is kept first, so a restore can itself be taken back from the list. */
export async function restoreVersion(ctx: Ctx, item: CanvasItem, version: string): Promise<void> {
  await serial(ctx, item, async () => {
    const dir = await deckDir(ctx, item, 'history')
    // A name of the list and nothing else: never a path.
    if (!/^[0-9]{15}-[0-9a-f]{4}(\.first)?\.pptx$/.test(version) || !existsSync(join(dir, version))) throw new Error('That version is no longer kept.')
    const path = await deckPath(ctx, item)
    const base = await scratch(ctx, item, 'restore')
    try {
      copyWhole(path, base)
      const was = hashFile(base)
      if (hashFile(join(dir, version)) === was) return
      // The deck as it is now joins the list; the copy he picked is not let go to make room, even the oldest of thirty.
      await keepHistory(ctx, item, base, false, version)
      replaceKeeping(path, join(dir, version), was)
    } finally {
      rmSync(base, { force: true })
    }
  })
}
