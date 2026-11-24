import type { MsQuestion } from '@shared/work/msforms'

/**
 * A Microsoft form from a document (docs/agents/work-msforms.md "The makers"): pure, so the grammar is tested on its
 * own. Forms' own Quick import is not used: it typed two of three dummy questions wrong and takes only an upload
 * from the device.
 *
 * The grammar, one paragraph at a time:
 *  - a numbered paragraph ("1. Which night?") or a heading is a question; a first heading of level 1 with questions
 *    after it is the form's title, and plain words before the first question its description;
 *  - a bullet under a question, or a numbered item deeper than it, is one of its options: a question with options
 *    is a Choice (a numbered item at the margin is always a question of its own);
 *  - in a question's words, "(required)" or a trailing `*` makes it Required, and "(date)", "(rating)" and "(long)"
 *    set its kind (Date, Rating 1 to 5, Text with a long answer; "(rating 10)" rates 1 to 10); the marks are dropped
 *    from its title;
 *  - any other paragraph is left out.
 */

export interface DocParagraph {
  text: string
  kind: 'heading' | 'numbered' | 'bullet' | 'plain'
  /** a heading's level (1 to 6); a list item's depth (0 at the margin) */
  level: number
}

export interface DocumentForm {
  title?: string
  description?: string
  questions: MsQuestion[]
}

/** The most questions one form takes (`MsFormMakeSchema`). */
export const DOCUMENT_QUESTIONS_MOST = 100
const TITLE_MOST = 500
const OPTION_MOST = 200
const OPTIONS_MOST = 50

/** Inline markdown as plain words: emphasis, code, links and the reader's escapes. */
function plain(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A document's markdown (work-kit's `writeMarkdown`, a .tcdoc's own) as paragraphs. */
export function paragraphsOfMarkdown(markdown: string): DocParagraph[] {
  const out: DocParagraph[] = []
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim()) continue
    const indent = raw.match(/^[ \t]*/)![0].replace(/\t/g, '    ').length
    const line = raw.trim()
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      out.push({ kind: 'heading', level: heading[1]!.length, text: plain(heading[2]!) })
      continue
    }
    const depth = Math.floor(indent / 2)
    const numbered = /^(?:\(?\d{1,3}[.)]|[Qq]\d{1,3}[.):])\s+(.*)$/.exec(line)
    if (numbered) {
      out.push({ kind: 'numbered', level: depth, text: plain(numbered[1]!) })
      continue
    }
    const bullet = /^(?:[-*+•◦▪○●☐□]|\[[ xX]?\]|\(?[a-zA-Z][.)])\s+(.*)$/.exec(line)
    if (bullet) {
      // a ticked or unticked box stays an option, without its box
      out.push({ kind: 'bullet', level: depth, text: plain(bullet[1]!.replace(/^\[[ xX]?\]\s*/, '').replace(/^[☐□○]\s*/, '')) })
      continue
    }
    out.push({ kind: 'plain', level: 0, text: plain(line) })
  }
  return out.filter((p) => p.text)
}

const MARK = /\(\s*(required|date|rating(?:\s*(?:1\s*-\s*)?(?:5|10))?|long(?:\s+answer)?)\s*\)/gi

/** A question's words, its marks read and dropped. */
export function questionOf(words: string, options: readonly string[]): MsQuestion | null {
  let required = false
  let kind: 'date' | 'rating' | 'long' | null = null
  let scale: 5 | 10 = 5
  let title = words.replace(MARK, (_, mark: string) => {
    const m = mark.toLowerCase()
    if (m === 'required') required = true
    else if (m === 'date') kind = 'date'
    else if (m.startsWith('rating')) {
      kind = 'rating'
      if (/10$/.test(m)) scale = 10
    } else kind = 'long'
    return ' '
  })
  title = title.replace(/\s+/g, ' ').trim()
  if (/\*$/.test(title)) {
    required = true
    title = title.replace(/\s*\*+$/, '').trim()
  }
  title = title.slice(0, TITLE_MOST).trim()
  if (!title) return null
  if (kind === 'date') return { title, type: 'date', required }
  if (kind === 'rating') return { title, type: 'rating', scale, required }
  if (kind === 'long') return { title, type: 'text', long: true, required }
  const kept = [...new Set(options.map((o) => o.slice(0, OPTION_MOST).trim()).filter(Boolean))].slice(0, OPTIONS_MOST)
  if (kept.length) return { title, type: 'choice', options: kept, required }
  return { title, type: 'text', required }
}

/** A document's paragraphs as a form: its questions in order, at most `DOCUMENT_QUESTIONS_MOST`. */
export function questionsOfDocument(paragraphs: readonly DocParagraph[]): DocumentForm {
  const asks = (p: DocParagraph): boolean => p.kind === 'numbered' || p.kind === 'heading'
  let start = 0
  let title: string | undefined
  const first = paragraphs[0]
  if (first?.kind === 'heading' && first.level === 1 && paragraphs.slice(1).some(asks)) {
    title = first.text.slice(0, 90).trim()
    start = 1
  }
  const firstAsk = paragraphs.findIndex((p, i) => i >= start && asks(p))
  const lead = paragraphs.slice(start, firstAsk < 0 ? paragraphs.length : firstAsk).filter((p) => p.kind === 'plain')
  const description = lead.length ? lead.map((p) => p.text).join('\n').slice(0, 1000) : undefined

  const questions: MsQuestion[] = []
  let open: { words: string; level: number; options: string[] } | null = null
  const close = (): void => {
    if (!open) return
    const q = questionOf(open.words, open.options)
    if (q && questions.length < DOCUMENT_QUESTIONS_MOST) questions.push(q)
    open = null
  }
  for (const p of paragraphs.slice(firstAsk < 0 ? paragraphs.length : firstAsk)) {
    // A list item deeper than its question is an option, numbered or not.
    if (open && (p.kind === 'bullet' || (p.kind === 'numbered' && p.level > Math.max(open.level, 0)))) {
      ;(open as { options: string[] }).options.push(p.text)
      continue
    }
    if (asks(p)) {
      close()
      open = { words: p.text, level: p.kind === 'numbered' ? p.level : -1, options: [] }
    }
  }
  close()
  return { ...(title ? { title } : {}), ...(description ? { description } : {}), questions }
}
