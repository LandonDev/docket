import { emptySidecar, everyBlock, type Block, type Imported, type Inline, type SidecarChange, type SidecarThread, type Styles, type TextRange, type TextRun } from 'work-kit/formats'

/**
 * A Google Doc as the Docs API answers it (`documents.get` with every tab,
 * suggestions inline and comments included) mapped to the import pipeline's
 * shapes (docs/agents/work-google.md "Docs"): blocks on the editor's schema,
 * comment threads and suggestions in the sidecar, and a count of what has no
 * place in blocks. Ported from the formats research's mapper sketch
 * (harness/google/docs-to-blocknote.ts); its three fixtures are this file's tests.
 *
 * Beside the import it answers each body paragraph's place in Google
 * (`paragraphs`): the range a write to that block goes to, and whether the
 * block's words are Google's one for one (`exact`). A paragraph holding a
 * chip, a footnote, a soft break or a waiting suggestion is not: its words
 * are written in Google, not from here.
 */

// The API's JSON is wide and loose; each field is read where it is used.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any

export interface DocParagraph {
  blockId: string
  /** '' for a document read without tabs */
  tabId: string
  /** the paragraph's range in its tab's body, its newline included */
  start: number
  end: number
  /** its words as the block holds them */
  text: string
  /** the block's words are the paragraph's, index for index */
  exact: boolean
}

export interface MappedDoc {
  imported: Imported
  paragraphs: DocParagraph[]
  /** every block the import made: a block not among them was added here */
  known: string[]
}

const PX = 96 / 72
const MONO = /mono|courier|consolas|menlo|source code/i
const HEADINGS: Record<string, number> = { HEADING_1: 1, HEADING_2: 2, HEADING_3: 3, HEADING_4: 4, HEADING_5: 5, HEADING_6: 6, TITLE: 1, SUBTITLE: 2 }
const ALIGN: Record<string, string> = { CENTER: 'center', END: 'right', JUSTIFIED: 'justify' }
/** What the Docs API puts in a run for anything that is not text. */
const NOT_TEXT = ''

const css = (c: J): string | undefined => {
  const rgb = c?.color?.rgbColor
  if (!rgb) return undefined
  const f = (v?: number) => Math.round((v ?? 0) * 255)
  return `rgb(${f(rgb.red)}, ${f(rgb.green)}, ${f(rgb.blue)})`
}

/** Every tab in reading order (child tabs after their parent), or the legacy body as one tab. */
function tabsOf(doc: J): { tabId: string; title: string; depth: number; tab: J }[] {
  if (!doc.tabs?.length) return [{ tabId: '', title: doc.title ?? '', depth: 0, tab: doc }]
  const out: { tabId: string; title: string; depth: number; tab: J }[] = []
  const walk = (tabs: J[], depth: number) => {
    for (const t of tabs) {
      out.push({ tabId: t.tabProperties?.tabId ?? '', title: t.tabProperties?.title ?? '', depth, tab: t.documentTab ?? {} })
      walk(t.childTabs ?? [], depth + 1)
    }
  }
  walk(doc.tabs, 0)
  return out
}

const runText = (inl: Inline): string => (inl.type === 'text' ? inl.text : inl.type === 'link' ? inl.content.map((t) => t.text).join('') : '￼')

/** The whole document as one flow: the first tab, then each other tab under a heading of its title. */
export function mapGoogleDoc(doc: J): MappedDoc {
  let n = 0
  const id = () => `g${++n}`
  const sidecar = emptySidecar()
  const drop = (k: string, by = 1) => void (sidecar.dropped[k] = (sidecar.dropped[k] ?? 0) + by)
  const paragraphs: DocParagraph[] = []
  const blocks: Block[] = []
  const sugMeta = new Map<string, J>((doc.suggestions ?? []).map((s: J) => [s.suggestionId, s]))
  const tabs = tabsOf(doc)
  tabs.forEach((t, i) => {
    const mapped = mapTab(t.tab, t.tabId, id, drop, sidecar.notes, paragraphs, sugMeta, doc.comments ?? [], tabs.length > 1)
    if (i > 0) blocks.push({ id: id(), type: 'heading', props: { level: Math.min(3, t.depth + 1) }, content: [{ type: 'text', text: t.title || 'Tab', styles: {} }], children: [] })
    blocks.push(...mapped.blocks)
    sidecar.threads.push(...mapped.threads)
    sidecar.changes.push(...mapped.changes)
    sidecar.page.headers.push(...mapped.headers)
    sidecar.page.footers.push(...mapped.footers)
    sidecar.page.sections.push(...mapped.sections)
  })
  if (tabs.length > 1) drop('tabs->headings', tabs.length - 1)
  return { imported: { blocks, sidecar }, paragraphs, known: [...everyBlock(blocks)].map((b) => b.id) }
}

function mapTab(
  tab: J,
  tabId: string,
  id: () => string,
  drop: (k: string, by?: number) => void,
  notes: Imported['sidecar']['notes'],
  paragraphs: DocParagraph[],
  sugMeta: Map<string, J>,
  comments: J[],
  tabbed: boolean
) {
  // Document index -> where that UTF-16 unit landed, for comment anchors.
  const spans: { segment: string; start: number; end: number; blockId: string; at: number; len: number }[] = []
  const suggestion = new Map<string, { sid: string; kind: SidecarChange['kind']; ranges: TextRange[]; text: string }>()
  const lists = tab.lists ?? {}
  const objects = tab.inlineObjects ?? {}
  const sections: { columns: number }[] = []

  const textStyles = (ts: J = {}): Styles => {
    const s: Styles = {}
    if (ts.bold) s.bold = true
    if (ts.italic) s.italic = true
    if (ts.underline && !ts.link) s.underline = true
    if (ts.strikethrough) s.strike = true
    const fg = css(ts.foregroundColor)
    const bg = css(ts.backgroundColor)
    if (fg) s.textColor = fg
    if (bg) s.backgroundColor = bg
    if (MONO.test(ts.weightedFontFamily?.fontFamily ?? '')) s.code = true
    if (ts.baselineOffset && ts.baselineOffset !== 'NONE') drop(`baselineOffset:${ts.baselineOffset}`)
    if (ts.smallCaps) drop('smallCaps')
    if (ts.fontSize) drop('fontSize')
    if (ts.weightedFontFamily && !s.code) drop('fontFamily')
    return s
  }

  const image = (props: J, how: string): Block => {
    const eo = props?.embeddedObject ?? {}
    const w = eo.size?.width?.magnitude
    if (how === 'positioned') drop('positionedObject->inline image')
    if (eo.imageProperties?.cropProperties && Object.keys(eo.imageProperties.cropProperties).length) drop('imageCrop')
    if (!eo.imageProperties) drop(`embeddedObject:${eo.embeddedDrawingProperties ? 'drawing' : eo.linkedContentReference ? 'linkedChart' : 'other'}`)
    // contentUri lives 30 minutes and carries the reader's access: the opener fetches it at once (docs.ts).
    return { id: id(), type: 'image', props: { url: eo.imageProperties?.contentUri ?? '', name: eo.title ?? '', caption: eo.description ?? '', ...(w ? { previewWidth: Math.round(w * PX) } : {}) }, children: [] }
  }

  /** One paragraph -> one block, plus images and breaks split out after it. */
  const paragraph = (p: J, segment: string, inCell: boolean, range: { start: number; end: number } | null): { block: Block; extra: Block[] } => {
    const block: Block = { id: id(), type: 'paragraph', props: {}, content: [], children: [] }
    const extra: Block[] = []
    const ps = p.paragraphStyle ?? {}
    const level = HEADINGS[ps.namedStyleType]
    if (level && !inCell) Object.assign(block, { type: 'heading', props: { level } })
    if (ps.namedStyleType === 'TITLE' || ps.namedStyleType === 'SUBTITLE') drop(`namedStyle:${ps.namedStyleType}`)
    if (ALIGN[ps.alignment]) block.props.textAlignment = ALIGN[ps.alignment]
    if (ps.indentStart?.magnitude && !p.bullet) drop('indentStart')
    if (ps.shading?.backgroundColor?.color) drop('paragraphShading')
    if (ps.borderTop?.width?.magnitude || ps.borderBottom?.width?.magnitude) drop('paragraphBorder')
    if (p.bullet && !inCell) {
      const lvl = lists[p.bullet.listId]?.listProperties?.nestingLevels?.[p.bullet.nestingLevel ?? 0] ?? {}
      const numbered = lvl.glyphType && !['GLYPH_TYPE_UNSPECIFIED', 'NONE'].includes(lvl.glyphType)
      block.type = numbered ? 'numberedListItem' : lvl.glyphSymbol ? 'bulletListItem' : 'checkListItem'
      if (numbered && lvl.startNumber > 1) block.props.start = lvl.startNumber
      if (numbered && !['DECIMAL', 'ZERO_DECIMAL'].includes(lvl.glyphType)) drop(`listGlyph:${lvl.glyphType}`)
      if (block.type === 'checkListItem') drop('checkState(not in API)')
    }
    for (const oid of p.positionedObjectIds ?? []) extra.push(image(tab.positionedObjects?.[oid]?.positionedObjectProperties, 'positioned'))
    const runs = block.content as Inline[]
    let at = 0
    // Exact while every element is a plain run whose words are the document's, unit for unit.
    let exact = true
    const push = (text: string, styles: Styles, href: string | undefined, el: J) => {
      if (!text) return
      spans.push({ segment, start: el.startIndex ?? 0, end: el.endIndex ?? (el.startIndex ?? 0) + text.length, blockId: block.id, at, len: text.length })
      // Suggestion ids sit on the inner object (textRun, person, richLink…), not on the element.
      const inner = Object.values<J>(el).find((v) => v && typeof v === 'object' && ('textStyle' in v || 'suggestedInsertionIds' in v)) ?? {}
      const kinds = [
        ['insert', inner.suggestedInsertionIds],
        ['delete', inner.suggestedDeletionIds],
        ['format', Object.keys(inner.suggestedTextStyleChanges ?? {})]
      ] as const
      for (const [kind, ids] of kinds)
        for (const sid of (ids ?? []) as string[]) {
          exact = false
          const key = `${kind}:${sid}`
          const s = suggestion.get(key) ?? { sid, kind, ranges: [], text: '' }
          s.ranges.push({ blockId: block.id, from: at, to: at + text.length })
          s.text += text
          suggestion.set(key, s)
        }
      const t: TextRun = { type: 'text', text, styles }
      runs.push(href ? { type: 'link', href, content: [t] } : t)
      at += text.length
    }
    for (const el of p.elements ?? []) {
      if (el.textRun) {
        const ts = el.textRun.textStyle ?? {}
        let text: string = el.textRun.content ?? ''
        if (text.endsWith('\n')) text = text.slice(0, -1)
        // A vertical tab is a soft line break in Docs.
        if (text.includes('\u000b')) exact = false
        text = text.replace(/\u000b/g, '\n')
        if (text.includes(NOT_TEXT)) {
          drop('unsupportedInline(U+E907)')
          exact = false
        }
        let href: string | undefined = ts.link?.url
        if (!href && (ts.link?.headingId || ts.link?.bookmarkId || ts.link?.heading || ts.link?.bookmark)) {
          drop('internalLink')
          href = undefined
        }
        push(text, textStyles(ts), href, el)
        continue
      }
      exact = false
      if (el.inlineObjectElement) extra.push(image(objects[el.inlineObjectElement.inlineObjectId]?.inlineObjectProperties, 'inline'))
      else if (el.person) {
        const pp = el.person.personProperties ?? {}
        push(pp.name ?? pp.email ?? '', {}, pp.email ? `mailto:${pp.email}` : undefined, el)
        drop('personChip->mailto link')
      } else if (el.richLink) {
        const rp = el.richLink.richLinkProperties ?? {}
        const safe = typeof rp.uri === 'string' && /^https?:\/\//i.test(rp.uri)
        push(rp.title ?? rp.uri ?? '', {}, safe ? rp.uri : undefined, el)
        drop('richLinkChip->link')
      } else if (el.dateElement) {
        push(el.dateElement.dateElementProperties?.displayText ?? '', {}, undefined, el)
        drop('dateChip->text')
      } else if (el.footnoteReference) {
        const fid: string = el.footnoteReference.footnoteId
        const body = content(tab.footnotes?.[fid]?.content ?? [], `footnote:${fid}`, false)
        notes.push({ id: fid, kind: 'footnote', blocks: body })
        runs.push({ type: 'footnote', props: { id: fid, note: body.map((b) => (Array.isArray(b.content) ? b.content.map(runText).join('') : '')).join('\n') } })
        at += 1
      } else if (el.pageBreak) extra.push({ id: id(), type: 'pageBreak', props: {}, children: [] })
      else if (el.horizontalRule) extra.push({ id: id(), type: 'divider', props: {}, children: [] })
      else if (el.equation) drop('equation(content not in API)')
      else if (el.autoText) drop(`autoText:${el.autoText.type}`)
      else if (el.columnBreak) drop('columnBreak')
      else if (el.dropdown) drop('dropdownChip')
      else drop(`element:${Object.keys(el).find((k) => !/Index$/.test(k))}`)
    }
    // Links leave the document as the import allows them: the web, mail and phone only.
    const safe = runs.map((r): Inline => (r.type === 'link' && !/^(?:https?:\/\/|mailto:|tel:)/i.test(r.href) ? { type: 'text', text: r.content.map((c) => c.text).join(''), styles: r.content[0]?.styles ?? {} } : r))
    runs.splice(0, runs.length, ...safe)
    if (range && segment === 'body' && !inCell) paragraphs.push({ blockId: block.id, tabId, start: range.start, end: range.end, text: runs.map(runText).join(''), exact })
    return { block, extra }
  }

  const table = (t: J, segment: string): Block => {
    const widths: (number | null)[] = (t.tableStyle?.tableColumnProperties ?? []).map((c: J) => (c.width?.magnitude ? Math.round(c.width.magnitude * PX) : null))
    // Cells hidden under a merge still appear in the JSON.
    const covered = new Set<string>()
    const rows = (t.tableRows ?? []).map((r: J, ri: number) => {
      const cells: { type: 'tableCell'; props: Record<string, unknown>; content: Inline[] }[] = []
      ;(r.tableCells ?? []).forEach((c: J, ci: number) => {
        if (covered.has(`${ri}:${ci}`)) return
        const st = c.tableCellStyle ?? {}
        const rs = st.rowSpan ?? 1
        const cs = st.columnSpan ?? 1
        for (let y = 0; y < rs; y++) for (let x = 0; x < cs; x++) if (x || y) covered.add(`${ri + y}:${ci + x}`)
        const paras = (c.content ?? []).filter((e: J) => e.paragraph).map((e: J) => paragraph(e.paragraph, segment, true, null))
        if ((c.content ?? []).some((e: J) => e.table)) drop('nestedTable')
        if (paras.length > 1) drop('multiParagraphCell->joined')
        if (paras.some((p: { extra: Block[] }) => p.extra.length)) drop('imageInCell')
        const inl: Inline[] = []
        paras.forEach((p: { block: Block }, i: number) => {
          if (i) inl.push({ type: 'text', text: '\n', styles: {} })
          inl.push(...(p.block.content as Inline[]))
        })
        const bg = css(st.backgroundColor)
        if (st.contentAlignment && st.contentAlignment !== 'TOP') drop('cellVerticalAlign')
        cells.push({ type: 'tableCell', props: { ...(bg ? { backgroundColor: bg } : {}), ...(cs > 1 ? { colspan: cs } : {}), ...(rs > 1 ? { rowspan: rs } : {}) }, content: inl })
      })
      return { cells }
    })
    if ((t.tableRows ?? []).some((r: J) => r.tableCells?.some((c: J) => c.tableCellStyle?.borderLeft?.width?.magnitude))) drop('cellBorders')
    const columns = widths.length ? widths : (t.tableRows?.[0]?.tableCells ?? []).map(() => null)
    return { id: id(), type: 'table', props: {}, content: { type: 'tableContent', columnWidths: columns, rows }, children: [] }
  }

  /** Structural elements -> blocks, list items nested by their level. */
  function content(els: J[], segment: string, body = segment === 'body'): Block[] {
    const out: Block[] = []
    const stack: { level: number; block: Block }[] = []
    const place = (b: Block, level: number | null) => {
      if (level === null) {
        stack.length = 0
        out.push(b)
        return
      }
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      ;(stack.length ? stack[stack.length - 1].block.children : out).push(b)
      stack.push({ level, block: b })
    }
    els.forEach((el, i) => {
      if (el.paragraph) {
        const { block, extra } = paragraph(el.paragraph, segment, false, body ? { start: el.startIndex ?? 0, end: el.endIndex ?? 0 } : null)
        const empty = !(block.content as Inline[]).length && block.type === 'paragraph'
        if (!(empty && extra.length)) place(block, el.paragraph.bullet ? (el.paragraph.bullet.nestingLevel ?? 0) : null)
        for (const x of extra) place(x, null)
      } else if (el.table) place(table(el.table, segment), null)
      else if (el.sectionBreak) {
        const ss = el.sectionBreak.sectionStyle ?? {}
        if (body) sections.push({ columns: Math.max(1, ss.columnProperties?.length ?? 1) })
        if ((ss.columnProperties?.length ?? 1) > 1) drop('sectionColumns')
        if (i > 0 && ss.sectionType === 'NEXT_PAGE') place({ id: id(), type: 'pageBreak', props: {}, children: [] }, null)
      } else if (el.tableOfContents) drop('tableOfContents')
    })
    return out
  }

  const blocks = content(tab.body?.content ?? [], 'body')
  const textOf = (bs: Block[]) => bs.map((b) => (Array.isArray(b.content) ? b.content.map(runText).join('') : '')).join('\n')
  const headers = Object.values<J>(tab.headers ?? {}).map((h) => textOf(content(h.content ?? [], `header:${h.headerId}`)))
  const footers = Object.values<J>(tab.footers ?? {}).map((f) => textOf(content(f.content ?? [], `footer:${f.footerId}`)))
  if (tab.documentStyle?.pageSize) drop('pageSizeAndMargins')

  // Suggestions -> changes. Author and date are on the document's suggestion threads.
  const changes: SidecarChange[] = []
  for (const s of suggestion.values()) {
    const sid = s.sid
    const head = sugMeta.get(sid)?.headPost
    for (const range of s.ranges)
      changes.push({ id: `${tabId || 'b'}:${sid}:${changes.length}`, kind: s.kind, author: head?.author?.displayName || 'Someone', ...(head?.createTime ? { date: head.createTime } : {}), range, text: s.text })
  }

  // Comments: threads sit on the document; ranges on each tab's commentAnchors.
  const rangesOf = (r: J): TextRange[] => {
    const seg = r.segmentId ? (tab.footnotes?.[r.segmentId] ? `footnote:${r.segmentId}` : r.segmentId) : 'body'
    return spans
      .filter((s) => s.segment.endsWith(seg) && s.end > r.startIndex && s.start < r.endIndex)
      .map((s) =>
        s.len !== s.end - s.start
          ? { blockId: s.blockId, from: s.at, to: s.at + s.len }
          : { blockId: s.blockId, from: s.at + Math.max(0, r.startIndex - s.start), to: s.at + Math.min(s.end, r.endIndex) - s.start }
      )
      .reduce((acc: TextRange[], a) => {
        const l = acc[acc.length - 1]
        if (l && l.blockId === a.blockId && l.to === a.from) l.to = a.to
        else acc.push(a)
        return acc
      }, [])
  }
  const tabAnchors = tab.commentAnchors ?? {}
  const threads: SidecarThread[] = []
  for (const c of comments) {
    const a = tabAnchors[c.anchorId]
    // A thread anchored in another tab, or (with tabs) in none.
    if (!a) continue
    const posts = [c.headPost, ...(c.replies ?? [])].filter((p: J) => p && !p.deleted && (p.content || !p.commentAction))
    threads.push({
      id: c.commentId,
      quote: c.plainTextQuote ?? '',
      resolved: c.status === 'RESOLVED',
      ranges: (a.ranges ?? []).filter((r: J) => !tabbed || !r.tabId || r.tabId === tabId).flatMap(rangesOf),
      comments: posts.map((p: J) => ({
        id: p.postId,
        author: p.author?.displayName || (p.author?.anonymous ? 'Anonymous' : 'Someone'),
        ...(p.createTime ? { date: p.createTime } : {}),
        body: [{ id: `${c.commentId}:${p.postId}`, type: 'paragraph', props: {}, content: [{ type: 'text', text: p.content ?? '', styles: {} }], children: [] }]
      }))
    })
  }
  return { blocks, threads, changes, headers, footers, sections }
}
