/**
 * The outgoing rules of LifeOS's worker (`apps/worker/src/gmail/body.ts`
 * `sanitizeHtml(html, { outgoing: true })`), kept on the host for the mail a
 * TempCode press sends: Outlook mail goes from the `outbox` row straight into
 * Outlook's `HTMLBody`, and an agent's draft can carry an identity's raw
 * signature, so what leaves through this host is cleaned here first.
 *
 * Scripts, event handlers, `javascript:` and `data:` URLs, forms, frames,
 * objects, `<base>` and `<meta>` go. Styles, tables and http, https and
 * `cid:` images stay. An allow-list that writes out only what it read and
 * kept: a tag or attribute it does not know never passes.
 */

const TAGS = new Set([
  // sanitize-html's defaults
  'address', 'article', 'aside', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup', 'main', 'nav', 'section',
  'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'hr', 'li', 'ol', 'p', 'pre', 'ul',
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q',
  'rb', 'rp', 'rt', 'rtc', 'ruby', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
  'caption', 'col', 'colgroup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  // the worker's own
  'img', 'style', 'font', 'center', 'big'
])

const VOID = new Set(['br', 'hr', 'img', 'col', 'wbr'])

/** Elements whose content is not markup: kept as text for `style`, dropped with the tag for the rest. */
const RAW = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext', 'template'])

const ATTRS = new Set([
  'style', 'class', 'align', 'valign', 'width', 'height', 'bgcolor', 'background', 'border', 'cellpadding', 'cellspacing',
  'colspan', 'rowspan', 'color', 'face', 'size', 'dir', 'lang', 'title', 'alt'
])
const TAG_ATTRS: Record<string, Set<string>> = { a: new Set(['href', 'name', 'target']), img: new Set(['src']) }

const HREF_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])
const SRC_SCHEMES = new Set(['http', 'https', 'cid'])

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', nbsp: ' ', sol: '/', lpar: '(', rpar: ')' }

/** An attribute's value as a browser reads it: its character references decoded. */
function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    return NAMED[ref.toLowerCase()] ?? whole
  })
}

const escapeAttr = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A URL kept only with one of `schemes`, or as a page fragment for a link; protocol-relative never. */
function urlOk(raw: string, schemes: ReadonlySet<string>, fragment: boolean): boolean {
  // Browsers drop control characters and whitespace inside a scheme: `java\tscript:` is `javascript:`.
  const url = raw.replace(/[\u0000- \u007f-\u009f]/g, '')
  if (url.startsWith('//') || url.startsWith('\\')) return false
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)
  if (scheme) return schemes.has(scheme[1].toLowerCase())
  return fragment && url.startsWith('#')
}

/** A style declaration that could run something in an old renderer goes whole. */
const styleOk = (value: string): boolean => !/expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import/i.test(value.replace(/\\|\/\*[\s\S]*?\*\//g, ''))

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

function attributes(tag: string, source: string): string {
  let out = ''
  const own = TAG_ATTRS[tag]
  for (const m of source.matchAll(ATTR)) {
    const name = m[1].toLowerCase()
    if (!ATTRS.has(name) && !own?.has(name)) continue
    const value = decode(m[2] ?? m[3] ?? m[4] ?? '')
    if (name === 'href' && !urlOk(value, HREF_SCHEMES, true)) continue
    if ((name === 'src' || name === 'background') && !urlOk(value, name === 'src' ? SRC_SCHEMES : HREF_SCHEMES, false)) continue
    if (name === 'style' && !styleOk(value)) continue
    out += ` ${name}="${escapeAttr(value)}"`
  }
  return out
}

/** Where a tag's `>` is, past any quoted attribute value; -1 when the tag never closes. */
function tagEnd(html: string, from: number): number {
  let quote: string | null = null
  for (let i = from; i < html.length; i++) {
    const c = html[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}

/** The mail's HTML as it may leave this host: the worker's outgoing rules. */
export function outgoingHtml(html: string): string {
  let out = ''
  let i = 0
  const text = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      out += text(html.slice(i))
      break
    }
    out += text(html.slice(i, lt))
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end < 0 ? html.length : end + 3
      continue
    }
    const open = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 64))
    if (!open) {
      // `<!DOCTYPE …>`, `<?xml …?>`, a CDATA section: nothing a mail needs.
      if (html[lt + 1] === '!' || html[lt + 1] === '?') {
        const end = html.indexOf('>', lt)
        i = end < 0 ? html.length : end + 1
      } else {
        out += '&lt;'
        i = lt + 1
      }
      continue
    }
    const end = tagEnd(html, lt + open[0].length)
    if (end < 0) break
    const closing = open[1] === '/'
    const tag = open[2].toLowerCase()
    i = end + 1
    if (closing) {
      if (TAGS.has(tag) && !VOID.has(tag)) out += `</${tag}>`
      continue
    }
    if (TAGS.has(tag)) out += `<${tag}${attributes(tag, html.slice(lt + open[0].length, end).replace(/\/\s*$/, ''))}>`
    if (RAW.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, i)
      const inner = html.slice(i, close < 0 ? html.length : close)
      if (tag === 'style') out += `${inner.replace(/</g, '\\3c ')}</style>`
      if (close < 0) break
      const after = tagEnd(html, close)
      i = after < 0 ? html.length : after + 1
    }
  }
  return out
}
