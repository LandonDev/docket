import type { DriveFile } from './client'
import type { Google } from './google'

/**
 * Google Slides (docs/agents/work-google.md "Slides"). A deck is read
 * through the Slides API, its words slide by slide. Slides has no suggest
 * mode, so an agent never changes a deck he has: it revises a copy
 * (`files.copy` with the comments), which he opens in Google and takes or
 * leaves.
 */

interface TextShape {
  objectId: string
  text: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const textOf = (el: any): string => (el?.shape?.text?.textElements ?? []).map((t: { textRun?: { content?: string } }) => t.textRun?.content ?? '').join('').replace(/\n$/, '')

/** Each slide's shapes with words, in order. */
export async function readDeck(g: Google, account: string, fileId: string): Promise<{ title: string; slides: TextShape[][] }> {
  const deck = await g.api(account).deck(fileId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slides = (deck.slides ?? []).map((s: any) => (s.pageElements ?? []).map((el: any) => ({ objectId: el.objectId as string, text: textOf(el) })).filter((x: TextShape) => x.text))
  return { title: deck.title ?? 'Deck', slides }
}

export function deckText(d: { title: string; slides: TextShape[][] }): string {
  return [`# ${d.title}`, ...d.slides.map((s, i) => [`\n## Slide ${i + 1}`, ...s.map((x) => `[${x.objectId}] ${x.text}`)].join('\n'))].join('\n')
}

export type DeckEdit = { find: string; replace: string } | { shape: string; text: string }

/** A copy of the deck with the agent's edits made in it, in one batchUpdate; the deck itself is not touched. */
export async function reviseCopy(g: Google, account: string, fileId: string, name: string, edits: readonly DeckEdit[]): Promise<DriveFile> {
  if (!edits.length) throw new Error('Name at least one edit.')
  const api = g.api(account)
  const copy = await api.copy(fileId, name)
  const deck = await api.deck(copy.id)
  if (!deck.revisionId) throw new Error('Google lets this account read the deck but not change a copy of it.')
  const requests = edits.flatMap((e): Record<string, unknown>[] =>
    'find' in e
      ? [{ replaceAllText: { containsText: { text: e.find, matchCase: true }, replaceText: e.replace } }]
      : [{ deleteText: { objectId: e.shape, textRange: { type: 'ALL' } } }, ...(e.text ? [{ insertText: { objectId: e.shape, text: e.text, insertionIndex: 0 } }] : [])]
  )
  await api.deckUpdate(copy.id, requests, { requiredRevisionId: deck.revisionId })
  return copy
}
