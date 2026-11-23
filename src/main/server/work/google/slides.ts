import type { GoogleDeckJson } from './client'
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
const textOf = (el: any): string => (el?.shape?.text?.textElements ?? []).map((t: { textRun?: { content?: string } }) => t.textRun?.content ?? '').join('').replace(/\n$/, '')

/** Each slide's shapes with words, in order. */
export async function readDeck(g: Google, account: string, fileId: string): Promise<{ title: string; slides: TextShape[][]; revisionId?: string }> {
  return slidesOf(await g.api(account).deck(fileId))
}

function slidesOf(deck: GoogleDeckJson): { title: string; slides: TextShape[][]; revisionId?: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slides = (deck.slides ?? []).map((s: any) => (s.pageElements ?? []).map((el: any) => ({ objectId: el.objectId as string, text: textOf(el) })).filter((x: TextShape) => x.text))
  return { title: deck.title ?? 'Deck', slides, ...(deck.revisionId ? { revisionId: deck.revisionId as string } : {}) }
}

export function deckText(d: { title: string; slides: TextShape[][] }): string {
  return [`# ${d.title}`, ...d.slides.map((s, i) => [`\n## Slide ${i + 1}`, ...s.map((x) => `[${x.objectId}] ${x.text}`)].join('\n'))].join('\n')
}

export type DeckEdit = { find: string; replace: string } | { shape: string; text: string }
/** An edit as it waits: a shape's with its slide and the words it held, so the press can tell it moved. */
export type HeldDeckEdit = { find: string; replace: string } | { shape: string; text: string; slide: number; was: string }

/**
 * Where a deck stands for these edits: each `find` on some slide, each shape there with what it holds now. An
 * edit that does not fit answers why, in words for the agent (when held) or for him (at the press).
 */
function judge(d: { slides: TextShape[][] }, edits: readonly DeckEdit[]): { held: HeldDeckEdit[] } | { error: string } {
  const held: HeldDeckEdit[] = []
  for (const e of edits) {
    if ('find' in e) {
      if (!d.slides.some((s) => s.some((x) => x.text.includes(e.find)))) return { error: `"${e.find}" is on no slide.` }
      held.push(e)
      continue
    }
    const slide = d.slides.findIndex((s) => s.some((x) => x.objectId === e.shape))
    if (slide < 0) return { error: `There is no shape ${e.shape} with words: take its id from google_slides_read.` }
    held.push({ ...e, slide: slide + 1, was: d.slides[slide]!.find((x) => x.objectId === e.shape)!.text })
  }
  return { held }
}

const requestsOf = (edits: readonly DeckEdit[]): Record<string, unknown>[] =>
  edits.flatMap((e): Record<string, unknown>[] =>
    'find' in e
      ? [{ replaceAllText: { containsText: { text: e.find, matchCase: true }, replaceText: e.replace } }]
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
  const d = slidesOf(await api.deck(fileId))
  if (!d.revisionId) return { stale: 'Google lets this account read the deck but not change it.' }
  const now = judge(d, edits)
  if ('error' in now) return { stale: now.error }
  const edited = edits.find((e, i) => 'was' in e && (now.held[i] as { was?: string }).was !== e.was)
  if (edited) return { stale: `A shape on slide ${'slide' in edited ? edited.slide : '?'} holds other words than it did.` }
  await api.deckUpdate(fileId, requestsOf(edits), { requiredRevisionId: d.revisionId })
  return { moved: d.revisionId !== judgedOn }
}
