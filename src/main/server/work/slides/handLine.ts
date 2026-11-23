import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The line of his own edits to each deck (hand.ts), kept in memory: which
 * pack takes the last edit back and which puts back the one he took back.
 * It holds only while the file is what his last edit, undo or redo left.
 */

/** How many of his edits can be taken back. */
export const HAND_STEPS = 100

export interface Step {
  /** the pack that takes this edit back; null once it was taken back */
  undo: string | null
  /** the pack that puts it in again; null until it is taken back */
  redo: string | null
}
export interface Hand {
  /** sha256 of the file as his last edit, undo or redo left it */
  hash: string
  steps: Step[]
  /** how many of `steps` are in the file: steps[at - 1] is the one Undo takes back, steps[at] the one Redo puts back */
  at: number
}
export const hands = new Map<string, Hand>()

/** Forgets every line of edits (Work turned off). The packs go with their decks' folders. */
export const forgetHands = (): void => hands.clear()
/** A file was renamed under its deck: its line of edits goes with it. */
export function handMoved(from: string, to: string): void {
  const hand = hands.get(from)
  if (!hand) return
  hands.delete(from)
  hands.set(to, hand)
}

/** Whether one of his edits can be taken back or put back, for a file whose bytes hash to `hash`. */
export function handState(deck: string, hash: string): { undo: boolean; redo: boolean } {
  const hand = hands.get(deck)
  if (!hand || hand.hash !== hash) return { undo: false, redo: false }
  return { undo: hand.at > 0, redo: hand.at < hand.steps.length }
}

/** The deck's line of edits while the file is still what it left; a file that moved on starts a new one, and the old packs go. */
export function lineOf(deck: string, dir: string, hash: string): Hand {
  const hand = hands.get(deck)
  if (hand && hand.hash === hash) return hand
  for (const f of readdirSync(dir)) if (f.endsWith('.pack')) rmSync(join(dir, f), { force: true })
  const fresh: Hand = { hash, steps: [], at: 0 }
  hands.set(deck, fresh)
  return fresh
}
