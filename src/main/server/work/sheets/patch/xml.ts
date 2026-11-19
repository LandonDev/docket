// String-level XML helpers. The patcher never parses a part into a tree: it finds spans and
// splices them, so every byte outside the spliced spans (prefixes, namespaces, mc:Ignorable,
// extLst, attribute order and quoting) is left exactly as it was.

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Characters XML 1.0 cannot carry are written the way Excel does: _xHHHH_. A literal "_xHHHH_" is escaped as _x005F_xHHHH_. */
export const escText = (s: string) =>
  esc(
    s
      .replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_')
      .replace(
        /[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g,
        (ch) => `_x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`
      )
  )

export const unesc = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) =>
    e === 'lt'
      ? '<'
      : e === 'gt'
        ? '>'
        : e === 'amp'
          ? '&'
          : e === 'quot'
            ? '"'
            : e === 'apos'
              ? "'"
              : String.fromCodePoint(
                  e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
                )
  )

export interface Attr {
  name: string
  value: string
  quote: string
}

export function parseAttrs(s: string): Attr[] {
  const out: Attr[] = []
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)))
    out.push({ name: m[1], value: m[2] ?? m[3], quote: m[2] !== undefined ? '"' : "'" })
  return out
}

export const attr = (attrs: Attr[], name: string) => attrs.find((a) => a.name === name)?.value

/** Set (or add at the end) one attribute inside a start tag, leaving the others byte-identical. */
export function setAttrInTag(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\s${name.replace(/[.:]/g, '\\$&')}\\s*=\\s*)(?:"[^"]*"|'[^']*')`)
  if (re.test(tag)) return tag.replace(re, `$1"${esc(value)}"`)
  return tag.replace(/\s*(\/?>)$/, (_m, end) => ` ${name}="${esc(value)}"${end}`)
}

export function removeAttrInTag(tag: string, name: string): string {
  return tag.replace(
    new RegExp(`\\s${name.replace(/[.:]/g, '\\$&')}\\s*=\\s*(?:"[^"]*"|'[^']*')`),
    ''
  )
}

/** Namespace prefix used for an element's own namespace on the root (e.g. "x:" for <x:worksheet>), or "". */
export function rootPrefix(xml: string, local: string): string {
  const m = new RegExp(`<([A-Za-z_][\\w.-]*:)?${local}[\\s>]`).exec(xml)
  if (!m) throw new Error(`no <${local}> root`)
  return m[1] ?? ''
}

// ---------------------------------------------------------------- A1 references
export function colNum(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64
  return n
}

export function colName(n: number): string {
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

export function parseRef(a1: string): { row: number; col: number } {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(a1.trim())
  if (!m) throw new Error(`bad cell reference ${a1}`)
  const col = colNum(m[1]),
    row = Number(m[2])
  if (col > 16384 || row < 1 || row > 1048576) throw new Error(`cell reference out of range ${a1}`)
  return { row, col }
}

export const refName = (row: number, col: number) => `${colName(col)}${row}`

export interface Box {
  r1: number
  c1: number
  r2: number
  c2: number
}

export function parseRange(s: string): Box {
  const [a, b] = s.split(':')
  const p = parseRef(a),
    q = b ? parseRef(b) : p
  return {
    r1: Math.min(p.row, q.row),
    c1: Math.min(p.col, q.col),
    r2: Math.max(p.row, q.row),
    c2: Math.max(p.col, q.col)
  }
}

export const inBox = (b: Box, row: number, col: number) =>
  row >= b.r1 && row <= b.r2 && col >= b.c1 && col <= b.c2
