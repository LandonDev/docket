// A small A1 formula tokenizer: enough to find every cell/row/column reference (with its sheet
// qualifier), to translate relative references (shared-formula re-mastering), and to add or strip
// the storage prefixes Excel writes for newer functions (_xlfn., _xlws., _xlpm.).
// It is not a parser: it does not build an expression tree and does not know operator precedence.
import { colName, colNum } from './xml'

const MAX_ROW = 1048576,
  MAX_COL = 16384

export interface RefEnd {
  start: number
  end: number // span in the formula text
  kind: 'cell' | 'row' | 'col'
  col?: number
  colAbs?: boolean
  row?: number
  rowAbs?: boolean
}

export interface Ref {
  sheet?: string // as written ("Data", "Q1:Q3" for a 3D span, "[1]Prices" for external), unquoted
  external?: boolean
  a: RefEnd
  b?: RefEnd // b for ranges
}

const WORD = /[A-Za-z0-9_.$\\¡-￿?]/
const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/
const COL = /^(\$?)([A-Za-z]{1,3})$/
const ROW = /^(\$?)(\d{1,7})$/

function end(text: string, start: number, kind: RefEnd['kind']): RefEnd | null {
  const s = text.slice(start)
  let m: RegExpExecArray | null
  if (kind === 'cell' && (m = CELL.exec(s))) {
    const col = colNum(m[2]),
      row = Number(m[4])
    if (col > MAX_COL || row < 1 || row > MAX_ROW) return null
    return { start, end: start + s.length, kind, colAbs: !!m[1], col, rowAbs: !!m[3], row }
  }
  if (kind === 'col' && (m = COL.exec(s))) {
    const col = colNum(m[2])
    return col > MAX_COL ? null : { start, end: start + s.length, kind, colAbs: !!m[1], col }
  }
  if (kind === 'row' && (m = ROW.exec(s))) {
    const row = Number(m[2])
    return row < 1 || row > MAX_ROW
      ? null
      : { start, end: start + s.length, kind, rowAbs: !!m[1], row }
  }
  return null
}

export interface Token {
  kind: 'string' | 'sheet' | 'bracket' | 'error' | 'func' | 'name' | 'ref' | 'other'
  start: number
  end: number
  text: string
  ref?: Ref
}

export function tokenize(f: string): Token[] {
  const out: Token[] = []
  let i = 0
  let pendingSheet: string | undefined,
    pendingExternal = false
  const n = f.length
  const readWord = (p: number) => {
    let q = p
    while (q < n && WORD.test(f[q])) q++
    return q
  }
  while (i < n) {
    const ch = f[i]
    if (ch === '"') {
      let j = i + 1
      while (j < n) {
        if (f[j] === '"') {
          if (f[j + 1] === '"') {
            j += 2
            continue
          }
          break
        }
        j++
      }
      out.push({ kind: 'string', start: i, end: j + 1, text: f.slice(i, j + 1) })
      i = j + 1
      continue
    }
    if (ch === "'") {
      let j = i + 1
      while (j < n) {
        if (f[j] === "'") {
          if (f[j + 1] === "'") {
            j += 2
            continue
          }
          break
        }
        j++
      }
      const name = f.slice(i + 1, j).replace(/''/g, "'")
      if (f[j + 1] === '!') {
        const ext = /^\[[^\]]*\]/.test(name)
        pendingSheet = name
        pendingExternal = ext
        out.push({ kind: 'sheet', start: i, end: j + 2, text: f.slice(i, j + 2) })
        i = j + 2
        continue
      }
      out.push({ kind: 'other', start: i, end: j + 1, text: f.slice(i, j + 1) })
      i = j + 1
      continue
    }
    if (ch === '[') {
      let depth = 0,
        j = i
      for (; j < n; j++) {
        if (f[j] === '[') depth++
        else if (f[j] === ']') {
          depth--
          if (depth === 0) break
        } else if (f[j] === "'") j++
      }
      const text = f.slice(i, j + 1)
      // "[1]Sheet!A1": an external workbook index directly followed by a sheet name
      const w = readWord(j + 1)
      if (/^\[\d+\]$/.test(text) && w > j + 1 && f[w] === '!') {
        pendingSheet = f.slice(i, w)
        pendingExternal = true
        out.push({ kind: 'sheet', start: i, end: w + 1, text: f.slice(i, w + 1) })
        i = w + 1
        continue
      }
      if (/^\[\d+\]$/.test(text) && f[j + 1] === '!') {
        // [1]!Name (workbook-level external name)
        out.push({ kind: 'sheet', start: i, end: j + 2, text: f.slice(i, j + 2) })
        i = j + 2
        continue
      }
      out.push({ kind: 'bracket', start: i, end: j + 1, text })
      i = j + 1
      continue
    }
    if (ch === '#') {
      const m =
        /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA|SPILL!|CALC!|FIELD!|BLOCKED!|CONNECT!|BUSY!|UNKNOWN!|PYTHON!)/i.exec(
          f.slice(i)
        )
      if (m) {
        out.push({ kind: 'error', start: i, end: i + m[0].length, text: m[0] })
        i += m[0].length
        continue
      }
    }
    if (WORD.test(ch)) {
      const j = readWord(i)
      const w = f.slice(i, j)
      if (f[j] === '(') {
        out.push({ kind: 'func', start: i, end: j, text: w })
        i = j
        pendingSheet = undefined
        continue
      }
      if (f[j] === '!') {
        pendingSheet = w
        pendingExternal = false
        out.push({ kind: 'sheet', start: i, end: j + 1, text: f.slice(i, j + 1) })
        i = j + 1
        continue
      }
      // 3D span Q1:Q3!A1
      if (f[j] === ':' && !pendingSheet) {
        const k = readWord(j + 1)
        if (k > j + 1 && f[k] === '!') {
          pendingSheet = f.slice(i, k)
          pendingExternal = false
          out.push({ kind: 'sheet', start: i, end: k + 1, text: f.slice(i, k + 1) })
          i = k + 1
          continue
        }
      }
      // reference, possibly a range a:b
      let done = false
      for (const kind of ['cell', 'col', 'row'] as const) {
        const a = end(f.slice(0, j), i, kind)
        if (!a) continue
        if (f[j] === ':') {
          // range end may itself carry a sheet prefix in rare forms (Sheet1!A1:Sheet1!B2); handle the plain form
          const k = readWord(j + 1)
          const b = end(f.slice(0, k), j + 1, kind)
          if (b) {
            out.push({
              kind: 'ref',
              start: i,
              end: k,
              text: f.slice(i, k),
              ref: { sheet: pendingSheet, external: pendingExternal, a, b }
            })
            i = k
            pendingSheet = undefined
            done = true
            break
          }
        }
        if (kind !== 'cell') continue // a lone column or row is a name or number, not a reference
        out.push({
          kind: 'ref',
          start: i,
          end: j,
          text: w,
          ref: { sheet: pendingSheet, external: pendingExternal, a }
        })
        i = j
        pendingSheet = undefined
        done = true
        break
      }
      if (done) continue
      out.push({ kind: /^[\d.]/.test(w) ? 'other' : 'name', start: i, end: j, text: w })
      i = j
      pendingSheet = undefined
      continue
    }
    out.push({ kind: 'other', start: i, end: i + 1, text: ch })
    i++
  }
  return out
}

export const refs = (f: string) =>
  tokenize(f)
    .filter((t) => t.kind === 'ref')
    .map((t) => t.ref!)

function writeEnd(e: RefEnd, dr: number, dc: number): string | null {
  const parts: string[] = []
  if (e.kind !== 'row') {
    const c = e.colAbs ? e.col! : e.col! + dc
    if (c < 1 || c > MAX_COL) return null
    parts.push((e.colAbs ? '$' : '') + colName(c))
  }
  if (e.kind !== 'col') {
    const r = e.rowAbs ? e.row! : e.row! + dr
    if (r < 1 || r > MAX_ROW) return null
    parts.push((e.rowAbs ? '$' : '') + r)
  }
  return parts.join('')
}

/** Move a formula by (dr, dc) the way Excel fills it: relative parts shift, $-anchored parts stay. */
export function translate(f: string, dr: number, dc: number): string {
  let out = '',
    last = 0
  for (const t of tokenize(f)) {
    if (t.kind !== 'ref' || t.ref!.external) continue
    const { a, b } = t.ref!
    const wa = writeEnd(a, dr, dc),
      wb = b ? writeEnd(b, dr, dc) : ''
    out += f.slice(last, t.start) + (wa === null || wb === null ? '#REF!' : b ? `${wa}:${wb}` : wa)
    last = t.end
  }
  return out + f.slice(last)
}

// ---------------------------------------------------------------- storage prefixes
// Functions Excel stores with a _xlfn. prefix: the MS-XLSX "Functions" future-function list
// (learn.microsoft.com/en-us/openspecs/office_standards/ms-xlsx/5d1b6d44-6fc1-4ecd-8fef-0b27406cc2bf, 2024-04-16), which
// writes NETWORKDAYS.INTL, WORKDAY.INTL, ISO.CEILING and ECMA.CEILING without a prefix, plus later functions not on that
// list yet (ARRAYTOTEXT, VALUETOTEXT, IMAGE, GROUPBY, PIVOTBY, PERCENTOF, REGEX*, TRIMRANGE, STOCKHISTORY, ENCODEURL: inferred).
const XLFN =
  `FIELDVALUE PQSOURCE PYTHON_STR PYTHON_TYPE PYTHON_TYPENAME ACOT ACOTH AGGREGATE ARABIC ARRAYTOTEXT BASE BETA.DIST BETA.INV BINOM.DIST BINOM.DIST.RANGE BINOM.INV BITAND BITLSHIFT
BITOR BITRSHIFT BITXOR BYCOL BYROW CEILING.MATH CEILING.PRECISE CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT CHISQ.TEST CHOOSECOLS
CHOOSEROWS COMBINA CONCAT CONFIDENCE.NORM CONFIDENCE.T COT COTH COVARIANCE.P COVARIANCE.S CSC CSCH DAYS DECIMAL DROP ENCODEURL
ERF.PRECISE ERFC.PRECISE EXPAND EXPON.DIST F.DIST F.DIST.RT F.INV F.INV.RT F.TEST FILTERXML FLOOR.MATH FLOOR.PRECISE FORECAST.ETS
FORECAST.ETS.CONFINT FORECAST.ETS.SEASONALITY FORECAST.ETS.STAT FORECAST.LINEAR FORMULATEXT GAMMA GAMMA.DIST GAMMA.INV GAMMALN.PRECISE
GAUSS GROUPBY HSTACK HYPGEOM.DIST IFNA IFS IMAGE IMCOSH IMCOT IMCSC IMCSCH IMSEC IMSECH IMSINH IMTAN ISFORMULA ISOMITTED ISOWEEKNUM LAMBDA
LET LOGNORM.DIST LOGNORM.INV MAKEARRAY MAP MAXIFS MINIFS MODE.MULT MODE.SNGL MUNIT NEGBINOM.DIST NORM.DIST NORM.INV
NORM.S.DIST NORM.S.INV NUMBERVALUE PDURATION PERCENTILE.EXC PERCENTILE.INC PERCENTOF PERCENTRANK.EXC PERCENTRANK.INC PERMUTATIONA PHI
PIVOTBY POISSON.DIST QUARTILE.EXC QUARTILE.INC RANDARRAY RANK.AVG RANK.EQ REDUCE REGEXEXTRACT REGEXREPLACE REGEXTEST RRI SCAN SEC SECH
SEQUENCE SHEET SHEETS SINGLE SKEW.P SORTBY STDEV.P STDEV.S STOCKHISTORY SWITCH T.DIST T.DIST.2T T.DIST.RT T.INV T.INV.2T T.TEST TAKE
TEXTAFTER TEXTBEFORE TEXTJOIN TEXTSPLIT TOCOL TOROW TRIMRANGE UNICHAR UNICODE UNIQUE VALUETOTEXT VAR.P VAR.S VSTACK WEBSERVICE
WEIBULL.DIST WRAPCOLS WRAPROWS XLOOKUP XMATCH XOR Z.TEST`.split(/\s+/)
const XLWS = new Set(['FILTER', 'SORT', 'PY'])
const XLFN_SET = new Set(XLFN)
// Functions whose result can spill: a new formula using one needs dynamic-array cell metadata (cm=) in Excel.
export const SPILLING = new Set([
  'FILTER',
  'SORT',
  'SORTBY',
  'UNIQUE',
  'SEQUENCE',
  'RANDARRAY',
  'VSTACK',
  'HSTACK',
  'TOCOL',
  'TOROW',
  'WRAPROWS',
  'WRAPCOLS',
  'TAKE',
  'DROP',
  'CHOOSEROWS',
  'CHOOSECOLS',
  'EXPAND',
  'TEXTSPLIT',
  'MAKEARRAY',
  'MAP',
  'SCAN',
  'BYROW',
  'BYCOL',
  'GROUPBY',
  'PIVOTBY',
  'TRANSPOSE',
  'MUNIT',
  'FREQUENCY',
  'MODE.MULT',
  'LINEST',
  'LOGEST',
  'TREND',
  'GROWTH',
  'MINVERSE',
  'MMULT',
  'REGEXEXTRACT'
])

/** LET/LAMBDA parameter names: odd LET arguments before the body, every LAMBDA argument before the body. */
export function lambdaParams(toks: Token[]): Set<string> {
  const names = new Set<string>()
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.kind !== 'func') continue
    const fn = t.text.toUpperCase().replace(/^(_XLFN\.)?(_XLWS\.)?/, '')
    if (fn !== 'LET' && fn !== 'LAMBDA') continue
    // collect top-level argument token lists
    let depth = 0
    const args: Token[][] = [[]]
    for (let j = i + 1; j < toks.length; j++) {
      const u = toks[j]
      if (u.text === '(') {
        depth++
        if (depth === 1) continue
      }
      if (u.text === ')') {
        depth--
        if (depth === 0) break
      }
      if (u.text === ',' && depth === 1) {
        args.push([])
        continue
      }
      args[args.length - 1].push(u)
    }
    const params =
      fn === 'LET' ? args.slice(0, -1).filter((_, k) => k % 2 === 0) : args.slice(0, -1)
    for (const a of params) {
      const w = a.filter((x) => x.text.trim())
      if (w.length === 1 && w[0].kind === 'name')
        names.add(w[0].text.replace(/^_xlpm\./i, '').toLowerCase())
    }
  }
  return names
}

/** "=XLOOKUP(...)" as typed → "_xlfn.XLOOKUP(...)" as stored. */
export function toFileFormula(typed: string): string {
  const f = typed.replace(/^\s*=/, '')
  const toks = tokenize(f)
  const params = lambdaParams(toks)
  let out = '',
    last = 0
  for (const t of toks) {
    let rep: string | null = null
    if (t.kind === 'func') {
      const bare = t.text.replace(/^(_xlfn\.)?(_xlws\.)?/i, '')
      const up = bare.toUpperCase()
      if (XLWS.has(up)) rep = `_xlfn._xlws.${bare}`
      else if (XLFN_SET.has(up)) rep = `_xlfn.${bare}`
    } else if (t.kind === 'name' && params.has(t.text.replace(/^_xlpm\./i, '').toLowerCase())) {
      rep = `_xlpm.${t.text.replace(/^_xlpm\./i, '')}`
    } else if (t.kind === 'ref' && !t.ref!.sheet && params.has(t.text.toLowerCase())) {
      rep = `_xlpm.${t.text}` // a LET name that looks like a cell (x1) — Excel forbids those, kept for safety
    }
    if (rep !== null && rep !== t.text) {
      out += f.slice(last, t.start) + rep
      last = t.end
    }
  }
  return out + f.slice(last)
}

/** Stored formula → what a user (or IronCalc's updateCellWithFormula) types. */
export function toUserFormula(stored: string): string {
  const toks = tokenize(stored)
  let out = '',
    last = 0
  for (const t of toks) {
    if ((t.kind === 'func' || t.kind === 'name') && /^_xl(fn|ws|pm)\./i.test(t.text)) {
      out += stored.slice(last, t.start) + t.text.replace(/^(_xlfn\.)?(_xlws\.)?(_xlpm\.)?/i, '')
      last = t.end
    }
  }
  return '=' + out + stored.slice(last)
}

export const functionsIn = (f: string) =>
  tokenize(f)
    .filter((t) => t.kind === 'func')
    .map((t) => t.text.replace(/^(_xlfn\.)?(_xlws\.)?/i, '').toUpperCase())
