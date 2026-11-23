import type { Block, Inline } from 'work-kit/formats'
import { makeZip, partBytes, partText, readZip } from '../zip'

/**
 * The starter documents' blocks and their last pass (docs/agents/work-templates.md
 * "The starters"). A document is written by work-kit's `writeDocx(blocks,
 * sidecar)`, the documents build's own writer. Until its styles and theme
 * land (DOC3, DOC5), that writer's style part carries the `docx` library's
 * defaults: headings in literal blues, no body font, A4. `themeDocx` puts
 * the style part on the theme (Word's built-in styles, colours as theme
 * slots with tints, fonts as the theme's heading and body, Calibri for both), sets the page to
 * US Letter, shades a table's head row with a theme tint, and zips the parts
 * again through `makeZip` with fixed dates, so a document built twice is the
 * same bytes. When DOC3 and DOC5 land this pass shrinks to the dates.
 */

// ── blocks ────────────────────────────────────────────────────────────

/** Ids for one document's blocks, in order: the same document gets the same ids. */
export function blockIds(): () => string {
  let n = 0
  return () => `b${++n}`
}

/**
 * Inline words from a line with `**bold**` and `_italic_` marks. A field
 * (`{{Client}}`) is plain text in a run of its own words.
 */
export function inline(text: string): Inline[] {
  const out: Inline[] = []
  for (const part of text.split(/(\*\*[^*]+\*\*|_[^_]+_)/)) {
    if (!part) continue
    if (part.startsWith('**') && part.endsWith('**')) out.push({ type: 'text', text: part.slice(2, -2), styles: { bold: true } })
    else if (part.length > 2 && part.startsWith('_') && part.endsWith('_')) out.push({ type: 'text', text: part.slice(1, -1), styles: { italic: true } })
    else out.push({ type: 'text', text: part, styles: {} })
  }
  return out
}

/** A small builder for one document's blocks. */
export function docBuilder() {
  const id = blockIds()
  const block = (type: string, content: Inline[], props: Record<string, unknown> = {}): Block => ({ id: id(), type, props, content, children: [] })
  return {
    h1: (text: string): Block => block('heading', inline(text), { level: 1 }),
    h2: (text: string): Block => block('heading', inline(text), { level: 2 }),
    h3: (text: string): Block => block('heading', inline(text), { level: 3 }),
    /** The heading after it starts a new page (the pass makes it the heading's own `pageBreakBefore`). */
    newPage: (): Block => ({ id: id(), type: 'pageBreak', props: {}, children: [] }),
    p: (text: string): Block => block('paragraph', inline(text)),
    bullets: (items: string[]): Block[] => items.map((t) => block('bulletListItem', inline(t))),
    numbered: (items: string[]): Block[] => items.map((t) => block('numberedListItem', inline(t))),
    checks: (items: string[]): Block[] => items.map((t) => block('checkListItem', inline(t), { checked: false })),
    /**
     * A table: column widths in pixels (the page's text is 624 wide on US
     * Letter with inch margins), its rows of cells, the first `head` rows
     * repeated on each page and shaded.
     */
    table: (widths: number[], rows: string[][], head = 1): Block => ({
      id: id(),
      type: 'table',
      props: {},
      content: {
        type: 'tableContent',
        columnWidths: widths,
        headerRows: head,
        rows: rows.map((r, ri) => ({ cells: r.map((c) => ({ type: 'tableCell' as const, props: {}, content: ri < head ? inline(`**${c}**`.replace('****', '')) : inline(c) })) }))
      },
      children: []
    }),
    /** A two-column table of facts: a label and its value on each row, no head. */
    facts: (rows: [string, string][], widths: [number, number] = [180, 444]): Block => ({
      id: id(),
      type: 'table',
      props: {},
      content: {
        type: 'tableContent',
        columnWidths: widths,
        headerRows: 0,
        rows: rows.map(([label, value]) => ({ cells: [{ type: 'tableCell' as const, props: {}, content: inline(`**${label}**`) }, { type: 'tableCell' as const, props: {}, content: inline(value) }] }))
      },
      children: []
    })
  }
}

/** The width of a page's text in the table's pixels: 6.5 inches at 96 to the inch. */
export const TEXT_WIDTH = 624

// ── the pass ──────────────────────────────────────────────────────────

const FIXED_DAY = '2026-01-01T00:00:00Z'

/** A run's colour as a theme slot. `val="auto"` is the fallback a reader without themes uses: automatic ink. */
const themeColor = (slot: string, mod = ''): string => `<w:color w:val="auto" w:themeColor="${slot}"${mod}/>`
const MAJOR = '<w:rFonts w:asciiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:hAnsiTheme="majorHAnsi" w:cstheme="majorBidi"/>'
const MINOR = '<w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/>'

const DOC_DEFAULTS =
  `<w:docDefaults><w:rPrDefault><w:rPr>${MINOR}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>` +
  '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'

const paraStyle = (id: string, name: string, pPr: string, rPr: string, extra = ''): string =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>${extra}<w:qFormat/><w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`
const heading = (level: number, size: number, before: number, after: number, color: string, bold = false): string =>
  paraStyle(
    `Heading${level}`,
    `heading ${level}`,
    `<w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="${after}"/><w:outlineLvl w:val="${level - 1}"/>`,
    `${MAJOR}${bold ? '<w:b/><w:bCs/>' : ''}${color}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`,
    '<w:uiPriority w:val="9"/>'
  )

/** The styles this pass writes in place of the writer's, by id. */
const STYLES: Record<string, string> = {
  Title: paraStyle('Title', 'Title', '<w:spacing w:after="80"/><w:contextualSpacing/>', `${MAJOR}${themeColor('text1')}<w:kern w:val="28"/><w:sz w:val="52"/><w:szCs w:val="52"/>`, '<w:uiPriority w:val="10"/>'),
  Heading1: heading(1, 40, 0, 160, themeColor('text1')),
  Heading2: heading(2, 26, 320, 100, themeColor('accent1', ' w:themeShade="BF"'), true),
  Heading3: heading(3, 23, 240, 60, themeColor('text1', ' w:themeTint="D9"'), true),
  Heading4: heading(4, 22, 200, 40, themeColor('text1', ' w:themeTint="D9"'), true),
  Heading5: heading(5, 22, 160, 40, themeColor('text1', ' w:themeTint="BF"')),
  Heading6: heading(6, 22, 160, 40, themeColor('text1', ' w:themeTint="BF"')),
  Hyperlink: `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr>${themeColor('hyperlink')}<w:u w:val="single"/></w:rPr></w:style>`,
  Quote: paraStyle('Quote', 'Quote', '<w:ind w:left="720" w:right="720"/>', `<w:i/>${themeColor('text1', ' w:themeTint="BF"')}`),
  SourceCode: paraStyle('SourceCode', 'Source Code', '<w:spacing w:before="0" w:after="0"/><w:shd w:val="clear" w:color="auto" w:fill="auto" w:themeFill="background1" w:themeFillShade="F2"/>', '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/>'),
  ListParagraph: paraStyle('ListParagraph', 'List Paragraph', '<w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/>', '', '<w:uiPriority w:val="34"/>')
}

/** A run's look in the page's header and footer: small, and quieter than the body. */
const HEAD_FOOT_RUN = `<w:rPr>${themeColor('text1', ' w:themeTint="A6"')}<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>`
/** A table head's cells: a light tint of the first accent. */
const HEAD_SHADE = '<w:shd w:val="clear" w:color="auto" w:fill="auto" w:themeFill="accent1" w:themeFillTint="33"/>'
/** Table lines: a light grey from the theme's ink, not black. */
const TABLE_LINE = '<w:$1 w:val="single" w:color="auto" w:themeColor="text1" w:themeTint="40" w:sz="4"/>'

function themeStyles(xml: string): string {
  let out = xml.replace(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>|<w:docDefaults\/>/, DOC_DEFAULTS)
  for (const [id, style] of Object.entries(STYLES)) {
    const re = new RegExp(`<w:style\\b[^>]*w:styleId="${id}"[^>]*>[\\s\\S]*?</w:style>`)
    out = re.test(out) ? out.replace(re, style) : out.replace('</w:styles>', `${style}</w:styles>`)
  }
  return out
}

function themeBody(xml: string): string {
  return (
    xml
      // US Letter, portrait, inch margins.
      .replace(/<w:pgSz\b[^>]*\/>/g, '<w:pgSz w:w="12240" w:h="15840" w:orient="portrait"/>')
      .replace(/<w:pgMar\b[^>]*\/>/g, '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>')
      .replace(/<w:(top|left|bottom|right|insideH|insideV) w:val="single" w:color="auto" w:sz="4"\/>/g, TABLE_LINE)
      // A table's cells breathe: a little room above and below their words.
      .replace(/<\/w:tblPr>/g, '<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>')
      // A cell's own paragraph needs no space after it: the cell's margins give it. An empty cell's is `<w:p/>`.
      .replace(/(<w:tc>[\s\S]*?<\/w:tc>)/g, (cell) =>
        cell
          .replace(/<w:p\/>/g, '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>')
          .replace(/<w:p>(?!<w:pPr><w:spacing w:after="0"\/><\/w:pPr><\/w:p>)/g, '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>')
          .replace(/<w:p><w:pPr><w:spacing w:after="0"\/><\/w:pPr><w:pPr>/g, '<w:p><w:pPr><w:spacing w:after="0"/>')
      )
      // A page break before a heading is the heading's own: no empty line is left at the top of the new page.
      .replace(/<w:p><w:r><w:br w:type="page"\/><\/w:r><\/w:p><w:p><w:pPr><w:pStyle w:val="(Heading\d)"\/>/g, '<w:p><w:pPr><w:pStyle w:val="$1"/><w:pageBreakBefore/>')
      // A row that is no head says nothing: the writer's `<w:tblHeader w:val="off"/>` is read as a head by readers that look only for the tag (work-kit's readDocx among them).
      .replace(/<w:trPr><w:tblHeader w:val="(?:off|false|0)"\/><\/w:trPr>/g, '')
      .replace(/<w:tblHeader w:val="(?:off|false|0)"\/>/g, '')
      // A check item is its box and its words: the list's bullet would be a second mark before the box.
      .replace(/<w:pPr><w:pStyle w:val="ListParagraph"\/><w:numPr>(?:(?!<\/w:numPr>).)*<\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">([☐☒]) <\/w:t><\/w:r>/g, '<w:pPr><w:pStyle w:val="ListParagraph"/><w:ind w:left="720" w:hanging="360"/></w:pPr><w:r><w:t xml:space="preserve">$1 </w:t></w:r>')
      // Words that follow a table or a list get a little room above them; a heading has its own.
      .replace(/<\/w:tbl><w:p><w:r>/g, '</w:tbl><w:p><w:pPr><w:spacing w:before="160"/></w:pPr><w:r>')
      .replace(/(<w:pStyle w:val="ListParagraph"\/>(?:(?!<\/w:p>).)*<\/w:p>)<w:p><w:r>/g, '$1<w:p><w:pPr><w:spacing w:before="160"/></w:pPr><w:r>')
      .replace(/<w:tr>\s*<w:trPr>\s*<w:tblHeader\/>\s*<\/w:trPr>([\s\S]*?)<\/w:tr>/g, (row) => row.replace(/<\/w:tcPr>/g, `${HEAD_SHADE}</w:tcPr>`))
  )
}

/** A paragraph that stays on the page of the one after it. `w:keepNext` stands right after the paragraph's style, as the schema orders a paragraph's properties. */
export function keepNext(p: string): string {
  if (p.includes('<w:keepNext/>')) return p
  if (p === '<w:p/>') return '<w:p><w:pPr><w:keepNext/></w:pPr></w:p>'
  if (!p.startsWith('<w:p><w:pPr>')) return p.replace(/^<w:p>/, '<w:p><w:pPr><w:keepNext/></w:pPr>')
  return /^<w:p><w:pPr><w:pStyle [^>]*\/>/.test(p) ? p.replace(/^(<w:p><w:pPr><w:pStyle [^>]*\/>)/, '$1<w:keepNext/>') : p.replace(/^<w:p><w:pPr>/, '<w:p><w:pPr><w:keepNext/>')
}

const BODY_PART = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\/>|<w:p>[\s\S]*?<\/w:p>/g
const isList = (p: string): boolean => p.includes('<w:pStyle w:val="ListParagraph"/>')
const isHeading = (p: string): boolean => /<w:pStyle w:val="Heading\d"\/>/.test(p)

/**
 * Nothing short is cut from what it belongs to. A heading keeps with what
 * follows by its style; here a list keeps whole (each item but its last
 * keeps with the next), a table keeps whole (every row but its last keeps
 * with the next, and no row splits), and a line that leads into a list or a
 * table keeps with it. So a heading, its lead line, a list or a table of up
 * to a page move to the next page together, or not at all.
 */
export function keepTogether(xml: string): string {
  const parts = [...xml.matchAll(BODY_PART)].map((m) => ({ at: m.index, text: m[0] }))
  let out = ''
  let at = 0
  parts.forEach((part, i) => {
    const next = parts[i + 1]?.text ?? ''
    let text = part.text
    if (text.startsWith('<w:tbl>')) {
      const rows = (text.match(/<w:tr>[\s\S]*?<\/w:tr>/g) ?? []).length
      let r = 0
      text = text.replace(/<w:tr>[\s\S]*?<\/w:tr>/g, (row) => {
        let kept = row.replace(/^<w:tr>(?!<w:trPr>)/, '<w:tr><w:trPr><w:cantSplit/></w:trPr>').replace(/^<w:tr><w:trPr>(?!<w:cantSplit\/>)/, '<w:tr><w:trPr><w:cantSplit/>')
        if (r++ < rows - 1) kept = kept.replace(/<w:p\/>|<w:p>[\s\S]*?<\/w:p>/g, keepNext)
        return kept
      })
    } else if (!isHeading(text) && ((isList(text) && isList(next)) || (!isList(text) && (next.startsWith('<w:tbl>') || isList(next))))) text = keepNext(text)
    out += xml.slice(at, part.at) + text
    at = part.at! + part.text.length
  })
  return out + xml.slice(at)
}

/** The literal colours in a part: what starters.test.ts refuses outside the theme. `auto` is no colour. */
export function literalColours(xml: string): string[] {
  const found = [
    ...xml.matchAll(/<w:color\b[^>]*\bw:val="(?!auto")[^"]*"[^>]*>/g),
    ...xml.matchAll(/\b(?:w:color|w:fill|rgb|lastClr|w14:val)="(?!auto")[0-9A-Fa-f]{6,8}"/g),
    ...xml.matchAll(/<(?:a:srgbClr|a:sysClr|w:highlight)\b[^>]*>/g)
  ]
  return found.map((m) => m[0])
}

/** A writeDocx file on the theme, on Letter, with fixed dates; zipped again in its own order. */
export function themeDocx(bytes: Uint8Array): Uint8Array {
  const files: Record<string, Uint8Array | string> = {}
  for (const part of readZip(bytes)) {
    const name = part.name
    if (name === 'word/styles.xml') files[name] = themeStyles(partText(part))
    else if (name === 'word/document.xml') files[name] = keepTogether(themeBody(partText(part)))
    else if (/^word\/(header|footer)\d+\.xml$/.test(name)) files[name] = partText(part).replace(/<w:r>(?!<w:rPr>)/g, `<w:r>${HEAD_FOOT_RUN}`)
    // Calibri for headings too: a reader without Calibri Light (LibreOffice) sets them in a serif.
    else if (name === 'word/theme/theme1.xml') files[name] = partText(part).replace(/(<a:majorFont><a:latin typeface=")Calibri Light(" panose=")[0-9A-F]+"/, '$1Calibri$2020F0502020204030204"')
    else if (name === 'docProps/core.xml')
      files[name] = partText(part)
        .replace(/(<dcterms:(?:created|modified)\b[^>]*>)[^<]*/g, `$1${FIXED_DAY}`)
        .replace(/<dc:creator>[^<]*<\/dc:creator>/, '<dc:creator></dc:creator>')
        .replace(/<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/, '<cp:lastModifiedBy></cp:lastModifiedBy>')
    else files[name] = partBytes(part)
    const text = typeof files[name] === 'string' ? (files[name] as string) : ''
    if (text && name !== 'word/theme/theme1.xml' && literalColours(text).length) throw new Error(`${name} still holds a literal colour after the theme pass: ${literalColours(text)[0]}`)
  }
  return makeZip(headerFromPageTwo(files))
}

/**
 * The page header and footer print from page two on, as the sheets' header
 * does: page one's title says it already, and a one-page document has
 * neither. Word's way is a first page of its own (`w:titlePg`); with no
 * header or footer named for it, that page's are blank. None is named
 * because our own reader keeps the setting and counts a first page's own
 * header as something it could not keep.
 */
export function headerFromPageTwo(files: Record<string, Uint8Array | string>): Record<string, Uint8Array | string> {
  const part = files['word/document.xml']
  const doc = part === undefined ? null : typeof part === 'string' ? part : new TextDecoder().decode(part)
  if (!doc || !/<w:(header|footer)Reference w:type="default"/.test(doc)) return files
  // `w:titlePg` stands before `w:docGrid` in a section's properties.
  return { ...files, 'word/document.xml': doc.replace(/(<w:docGrid\b)/, '<w:titlePg/>$1') }
}
