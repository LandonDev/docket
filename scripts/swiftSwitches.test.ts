import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACT_KINDS } from '../src/shared/work/acts'
import { CHIP_KINDS } from '../src/shared/work/canvas'
import { PILLAR_IDS } from '../src/shared/work/ids'

/**
 * The phone's switches over the contract's names, held on the box. A build that adds a held act kind, a chip kind or
 * a pillar regenerates the Swift contract, and every Swift `switch` over that enum with no `default` stops compiling;
 * only the Mac's publish gate would notice. This reads each such switch as text and names the case it lacks and the
 * file to add it to.
 *
 * A switch counts as one over a set when it has no `default`, and every case it names at its own level (but
 * `.unknown`) is a name of the set, at least half of them: a switch over another enum that shares a few names (the
 * Life view's `.mail`, `.agenda`) names too few to count.
 */

const ROOT = join(__dirname, '..')
const IOS = join(ROOT, 'ios')

/** `office.calendar.op` → `officeCalendarOp`, as scripts/gen-swift-contract.ts names an enum case. */
const swiftCase = (raw: string): string => raw.split('.').map((part, i) => (i === 0 ? part : part[0]!.toUpperCase() + part.slice(1))).join('')

const SETS: { name: string; cases: string[] }[] = [
  { name: 'act kinds (ACT_KINDS, src/shared/work/acts.ts)', cases: ACT_KINDS.map(swiftCase) },
  { name: 'chip kinds (CHIP_KINDS, src/shared/work/canvas.ts)', cases: CHIP_KINDS.map(swiftCase) },
  { name: 'pillar ids (PILLAR_IDS, src/shared/work/ids.ts)', cases: PILLAR_IDS.map(swiftCase) }
]

function swiftFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'Generated' || e.name.startsWith('.') || e.name === 'build' || e.name === 'DerivedData') return []
    const p = join(dir, e.name)
    return e.isDirectory() ? swiftFiles(p) : e.name.endsWith('.swift') ? [p] : []
  })
}

/** Each `switch … {` block's own cases (not a nested switch's), whether it has a `default`, and its line. */
export function switchesOf(source: string): { line: number; cases: string[]; defaulted: boolean }[] {
  const found: { line: number; cases: string[]; defaulted: boolean }[] = []
  const re = /\bswitch\b[^{\n]*\{/g
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 1
    let i = m.index + m[0].length
    const start = i
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') depth--
    }
    // the block's own level: nested braces (a nested switch, a closure) taken out
    let body = source.slice(start, i - 1)
    for (let prev = ''; prev !== body; ) {
      prev = body
      body = body.replace(/\{[^{}]*\}/g, '')
    }
    const cases = [...body.matchAll(/^\s*case\s+([^:]+):/gm)].flatMap((c) => [...c[1]!.matchAll(/(?:^|,)\s*\.([A-Za-z_]\w*)\s*(?=,|$)/g)].map((x) => x[1]!))
    found.push({ line: source.slice(0, m.index).split('\n').length, cases, defaulted: /^\s*default\s*:/m.test(body) })
  }
  return found
}

describe('the phone switches over the contract stay whole', () => {
  it('names every act kind, chip kind and pillar id in each Swift switch over them that has no default', () => {
    const missing: string[] = []
    for (const file of swiftFiles(IOS)) {
      const source = readFileSync(file, 'utf8')
      for (const sw of switchesOf(source)) {
        if (sw.defaulted) continue
        const named = sw.cases.filter((c) => c !== 'unknown')
        // two builds adding the same case each: the second is dead code that Swift only warns about
        for (const c of new Set(named.filter((x, i) => named.indexOf(x) !== i))) missing.push(`${relative(ROOT, file)}:${sw.line} names .${c} twice`)
        for (const set of SETS) {
          if (named.length < Math.max(3, Math.ceil(set.cases.length / 2)) || !named.every((c) => set.cases.includes(c))) continue
          for (const c of set.cases) if (!named.includes(c)) missing.push(`${relative(ROOT, file)}:${sw.line} lacks .${c} of the ${set.name}`)
        }
      }
    }
    expect(missing, `Add each case to its switch, once:\n${missing.join('\n')}`).toEqual([])
  })

  it('reads a switch at its own level, and its default', () => {
    const src = 'switch kind {\ncase .mailSend, .officeMailSend: "a"\ncase .x:\n  switch y {\n  case .inner: 1\n  default: 2\n  }\ncase .unknown: "c"\n}'
    expect(switchesOf(src)[0]).toEqual({ line: 1, cases: ['mailSend', 'officeMailSend', 'x', 'unknown'], defaulted: false })
    expect(switchesOf(src)[1]).toMatchObject({ cases: ['inner'], defaulted: true })
    expect(swiftCase('office.calendar.op')).toBe('officeCalendarOp')
    expect(swiftCase('share.guestLink')).toBe('shareGuestLink')
  })
})
