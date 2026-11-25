import { splitName } from './files'

/**
 * Save As… for a document (docs/agents/work-files.md "Save As…"): the formats a document is saved in, each one the
 * Work host writes itself, so a linked file can be written again by the host after every later edit with no window
 * open. Word, OpenDocument, Rich Text and Markdown are the exporter's own (formats/exporter.ts `EXPORT_FORMATS`); PDF
 * is the Word export drawn by the host's converter (LibreOffice), the picture Preview shows for Word.
 */
export const SAVE_AS_FORMATS = [
  { id: 'docx', label: 'Word', ext: 'docx' },
  { id: 'pdf', label: 'PDF', ext: 'pdf' },
  { id: 'odt', label: 'OpenDocument', ext: 'odt' },
  { id: 'rtf', label: 'Rich Text', ext: 'rtf' },
  { id: 'md', label: 'Markdown', ext: 'md' }
] as const

export type SaveAsFormat = (typeof SAVE_AS_FORMATS)[number]['id']
export const SAVE_AS_IDS = SAVE_AS_FORMATS.map((f) => f.id) as [SaveAsFormat, ...SaveAsFormat[]]

export const formatOf = (id: SaveAsFormat): (typeof SAVE_AS_FORMATS)[number] => SAVE_AS_FORMATS.find((f) => f.id === id)!

/** The file's name for a format: his name with any extension of ours dropped, then the format's own. */
export function saveAsName(name: string, format: SaveAsFormat): string {
  const trimmed = name.trim()
  const { stem, ext } = splitName(trimmed)
  const ours = SAVE_AS_FORMATS.some((f) => `.${f.ext}` === ext.toLowerCase()) || ext.toLowerCase() === '.tcdoc'
  return `${ours ? stem : trimmed}.${formatOf(format).ext}`
}

/**
 * The format a document made of a file is saved in at first: the file's own, where the host writes it; a `.doc` (no
 * writer makes one) as Word's `.docx`, with the line that says so. Null for any other file: the format he used last.
 */
export function formatForFile(name: string): { format: SaveAsFormat; note?: string } | null {
  const ext = splitName(name.trim()).ext.toLowerCase()
  if (ext === '.doc') return { format: 'docx', note: 'A .doc is saved as .docx' }
  if (ext === '.markdown') return { format: 'md' }
  const own = SAVE_AS_FORMATS.find((f) => `.${f.ext}` === ext)
  return own ? { format: own.id } : null
}

/** A linked file as the document's header shows it (`work.files.links`). */
export interface DocLink {
  id: string
  name: string
  format: SaveAsFormat
  /** the folder's name, as the header says it: "Esports" */
  place: string
  /** the computer it is on, when that is not the workspace's host ("MacBook", "Windows") */
  computer?: string
  /** the file, for Open; the folder, for Show in Files */
  ref: { at: 'file'; host: string; path: string }
  folder: { at: 'file'; host: string; path: string }
  /**
   * - `saved`: the file holds the document's live revision (`at` when it was written)
   * - `saving`: his newest words are not in it yet; the host writes them after a pause
   * - `waiting`: the place did not answer; the host tries again ("Not saved to Esports yet")
   * - `changed`: someone changed the file there since it was written: nothing is written until his press
   * - `gone`: the file was moved or deleted there
   * - `refused`: the place refused the write (`detail` says why)
   */
  state: 'saved' | 'saving' | 'waiting' | 'changed' | 'gone' | 'refused'
  /** `changed`: the version found there, which his Replace names */
  version?: string
  at?: number
  changedAt?: number
  detail?: string
}

/** What Save As… answers: the file made (and linked, unless he chose Just a copy), or that a file of that name is there. */
export type SavedAs = { saved: { name: string; ref: { at: 'file'; host: string; path: string }; linked: boolean } } | { exists: { name: string; version?: string } }

/** The one line under the form that says what Save will do. */
export function saveAsOutcome(o: { name: string; place: string | null; link: boolean }): string {
  if (!o.place) return 'Pick a folder'
  return o.link ? `Saves ${o.name} in ${o.place}, kept up to date` : `Saves a copy of ${o.name} in ${o.place}`
}

/** How a linked file stands, in the header's words. */
export function linkWords(l: Pick<DocLink, 'state' | 'place' | 'at'>, time: (at: number) => string): string {
  switch (l.state) {
    case 'saved':
      return l.at ? `Saved to ${l.place} ${time(l.at)}` : `Saved to ${l.place}`
    case 'saving':
      return `Saving to ${l.place}…`
    case 'waiting':
      return `Not saved to ${l.place} yet`
    case 'changed':
      return `Changed in ${l.place}`
    case 'gone':
      return `Moved or deleted in ${l.place}`
    case 'refused':
      return `Not saved to ${l.place}`
  }
}

/** Whether a link needs his press: the header takes the foreground for it. */
export const linkNeedsHim = (l: Pick<DocLink, 'state'>): boolean => l.state === 'changed' || l.state === 'gone' || l.state === 'refused'
