import { createHash } from 'node:crypto'
import { elsewhereWords, quoted, reachWords } from '@shared/work/changeWords'
import { GoogleError, type GoogleDeckJson } from './client'
import type { Google } from './google'

/**
 * Google Slides (docs/agents/work-google.md "Slides"). A deck is read
 * through the Slides API, its words slide by slide. Slides has no suggest
 * mode, and an agent never changes a deck he has on its own: its edits wait
 * on his host as a held `google.edit`, and his press makes them in the deck.
 * No copy is made: Drive puts a copy in the deck's own folders, where
 * everyone who shares them would see it.
 */

interface TextShape {
  objectId: string
  text: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wordsOf = (text: any): string => (text?.textElements ?? []).map((t: { textRun?: { content?: string } }) => t.textRun?.content ?? '').join('').replace(/\n$/, '')

/**
 * Every box of words on a page, as replace-all reaches them: a shape's, each cell of a table (`<table>:<row>:<col>`,
 * counted and changed by find and replace, never set whole), and the shapes and tables inside a group.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function boxesOf(el: any): TextShape[] {
  if (el?.elementGroup) return (el.elementGroup.children ?? []).flatMap(boxesOf)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (el?.table) return (el.table.tableRows ?? []).flatMap((r: any, i: number) => (r.tableCells ?? []).map((c: any, j: number) => ({ objectId: `${el.objectId}:${i}:${j}`, text: wordsOf(c.text) })))
  return [{ objectId: el?.objectId as string, text: wordsOf(el?.shape?.text) }]
}

/** Each slide's shapes with words, in order. */
export async function readDeck(g: Google, account: string, fileId: string): Promise<{ title: string; slides: TextShape[][]; revisionId?: string }> {
  return slidesOf(await g.api(account).deck(fileId))
}

function slidesOf(deck: GoogleDeckJson): { title: string; slides: TextShape[][]; revisionId?: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slides = (deck.slides ?? []).map((s: any) => (s.pageElements ?? []).flatMap(boxesOf).filter((x: TextShape) => x.text))
  return { title: deck.title ?? 'Deck', slides, ...(deck.revisionId ? { revisionId: deck.revisionId as string } : {}) }
}

export function deckText(d: { title: string; slides: TextShape[][] }): string {
  return [`# ${d.title}`, ...d.slides.map((s, i) => [`\n## Slide ${i + 1}`, ...s.map((x) => `[${x.objectId}] ${x.text}`)].join('\n'))].join('\n')
}

export type DeckEdit = { find: string; replace: string } | { shape: string; text: string }
/** An edit as it waits: a replace with how many boxes held the words, a shape's with its slide and the words it held, so the press can tell it moved. */
export type HeldDeckEdit = { find: string; replace: string; boxes?: number; on?: number[]; count?: number; spots?: string } | { shape: string; text: string; slide: number; was: string }

/**
 * Where a deck stands for these edits, run in order on a copy of its words as Google runs a batch: each replace-all
 * counts its boxes and slides on the words as the edits before it left them, and each box its words then. So the card
 * names exactly what the press changes. An edit that does not fit answers why twice: for the agent when held (`error`),
 * and in his words at the press (`owner`).
 */
function judge(d: { slides: TextShape[][] }, edits: readonly DeckEdit[]): { held: HeldDeckEdit[] } | { error: string; owner: string } {
  const held: HeldDeckEdit[] = []
  // A replace-all over words another edit of the batch writes would change more than either shows: refused, to be sent as two.
  for (const e of edits) {
    if (!('find' in e)) continue
    const other = edits.find((x) => x !== e && ('find' in x ? x.replace : x.text).includes(e.find))
    if (other) return { error: `"${e.find}" stands in what another edit of this batch writes: send them as two calls.`, owner: `two of its changes touch ${quoted(e.find)}` }
  }
  const state = d.slides.map((s) => s.map((x) => ({ ...x })))
  for (const e of edits) {
    if ('find' in e) {
      const on = state.flatMap((s, i) => (s.some((x) => x.text.includes(e.find)) ? [i + 1] : []))
      const boxes = state.flat().filter((x) => x.text.includes(e.find)).length
      // how many times the words stand in all, so a second match inside a box already counted is seen too
      const count = state.flat().reduce((n, x) => n + x.text.split(e.find).length - 1, 0)
      if (!boxes) return { error: `"${e.find}" is on no slide.`, owner: `${quoted(e.find)} is on no slide now` }
      // which boxes hold the words, with each one's words whole, as one short digest: totals alike but moved, to
      // another box or to another bullet of the same box, are told apart
      const spots = createHash('sha256').update(JSON.stringify(state.flat().filter((x) => x.text.includes(e.find)).map((x) => [x.objectId, x.text]))).digest('hex').slice(0, 16)
      held.push({ find: e.find, replace: e.replace, boxes, on, count, spots })
      for (const x of state.flat()) x.text = x.text.split(e.find).join(e.replace)
      continue
    }
    const slide = state.findIndex((s) => s.some((x) => x.objectId === e.shape))
    if (e.shape.includes(':')) return { error: `${e.shape} is a table's cell: change its words with find and replace.`, owner: 'a table cell cannot be set whole' }
    if (slide < 0) return { error: `There is no shape ${e.shape} with words: take its id from google_slides_read.`, owner: 'slide' in e ? `the box on slide ${(e as { slide: number }).slide} is gone` : 'a box this changes is gone' }
    const box = state[slide]!.find((x) => x.objectId === e.shape)!
    held.push({ ...e, slide: slide + 1, was: box.text })
    box.text = e.text
  }
  return { held }
}

/**
 * The batch his press sends. A replace-all names the slides it may change (`pageObjectIds`): with none, Google matches
 * every page, a slide's speaker notes, its layout and its master included, which the card never counted. The slides are
 * the ones the card named (`on`), by the ids of the deck just read; a hold from before `on` was kept names every slide.
 */
const requestsOf = (edits: readonly HeldDeckEdit[], pages: readonly string[]): Record<string, unknown>[] =>
  edits.flatMap((e): Record<string, unknown>[] =>
    'find' in e
      ? [{ replaceAllText: { containsText: { text: e.find, matchCase: true }, replaceText: e.replace, pageObjectIds: e.on ? e.on.map((n) => pages[n - 1]!).filter(Boolean) : [...pages] } }]
      : [{ deleteText: { objectId: e.shape, textRange: { type: 'ALL' } } }, ...(e.text ? [{ insertText: { objectId: e.shape, text: e.text, insertionIndex: 0 } }] : [])]
  )

/** The agent's edits judged on the deck as it is now, to be held: answers them with what each shape held, and the revision. */
export async function checkDeckEdits(g: Google, account: string, fileId: string, edits: readonly DeckEdit[]): Promise<{ held: HeldDeckEdit[]; revisionId: string }> {
  if (!edits.length) throw new Error('Name at least one edit.')
  const d = await readDeck(g, account, fileId)
  if (!d.revisionId) throw new Error('Google lets this account read the deck but not change it.')
  const got = judge(d, edits)
  if ('error' in got) throw new Error(got.error)
  return { held: got.held, revisionId: d.revisionId }
}

/**
 * His press on a held deck edit: made in the deck itself, in one batchUpdate bound to the revision just read.
 * `stale` when the words are gone or a shape holds other words than it did; `moved` when the deck changed since,
 * though every edit still fits.
 */
export async function writeDeckEdits(g: Google, account: string, fileId: string, edits: readonly HeldDeckEdit[], judgedOn: string): Promise<{ stale: string } | { moved: boolean }> {
  const api = g.api(account)
  const deck = await api.deck(fileId)
  const d = slidesOf(deck)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pages = (deck.slides ?? []).map((s: any) => String(s.objectId))
  // the account may no longer change it: nothing was written, and the file did not change
  if (!d.revisionId) throw new GoogleError('Google no longer lets this account change the deck.', 'refused')
  const now = judge(d, edits)
  if ('error' in now) return { stale: now.owner }
  const edited = edits.find((e, i) => 'was' in e && (now.held[i] as { was?: string }).was !== e.was)
  if (edited) return { stale: `the box on slide ${'slide' in edited ? edited.slide : '?'} holds other words than it did` }
  // a box moved to another slide is not the one he was shown
  const moved = edits.findIndex((e, i) => 'slide' in e && (now.held[i] as { slide?: number }).slide !== e.slide)
  if (moved >= 0) return { stale: `a box on slide ${(edits[moved] as { slide: number }).slide} is on slide ${(now.held[moved] as { slide: number }).slide} now` }
  // Replace-all reaches every box with the words: more or fewer, or other slides, than he was shown is not what he approved.
  type Reach = { boxes?: number; on?: number[]; count?: number; spots?: string }
  const spread = edits.findIndex((e, i) => {
    if (!('find' in e)) return false
    const n = now.held[i] as Reach
    return (e.boxes !== undefined && n.boxes !== e.boxes) || (e.on !== undefined && JSON.stringify(n.on) !== JSON.stringify(e.on)) || (e.count !== undefined && n.count !== e.count) || (e.spots !== undefined && n.spots !== e.spots)
  })
  if (spread >= 0) {
    const e = edits[spread] as { find: string } & Reach
    const n = now.held[spread] as Reach
    // places first, as the card counts them; then slides; then boxes, for words that moved with the totals alike
    if (e.count !== undefined && n.count !== e.count) return { stale: reachWords(e.find, n.count ?? 0, e.count, 'place') }
    if (e.on !== undefined && JSON.stringify(n.on) !== JSON.stringify(e.on)) return { stale: elsewhereWords(e.find, 'slides') }
    return { stale: elsewhereWords(e.find, 'boxes') }
  }
  await api.deckUpdate(fileId, requestsOf(edits, pages), { requiredRevisionId: d.revisionId })
  return { moved: d.revisionId !== judgedOn }
}
