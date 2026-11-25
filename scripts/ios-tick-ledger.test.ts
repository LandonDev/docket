import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/* The repeating tasks a Work screen keeps alive at rest (plan TE_fWkYrofJc §5 "Battery"): each one is a clock that
 * docs/IOS-DESIGN.md "Clocks" names, registered in `TickLedger` by that name while it lives, in the file the table
 * names. A loop with no end but its task's cancel that sleeps and goes round is a clock; a bounded wait is not. No
 * Work view runs a `Timer`, a display link or a `TimelineView`. And the `rest-today` run allows Today what the table
 * gives it. */
const repo = resolve(__dirname, '..')
const WORK = resolve(repo, 'ios/TempCode/Sources/Work')
const design = readFileSync(resolve(repo, 'docs/IOS-DESIGN.md'), 'utf8')

export interface Clock {
  name: string
  screen: string
  file: string
}

/** The Clocks table: each row's name, screen and the file named in its last cell. */
export function clocksOf(markdown: string): Clock[] {
  const start = markdown.indexOf('#### Clocks')
  if (start < 0) return []
  const section = markdown.slice(start, markdown.indexOf('\n#', start + 5))
  return [...section.matchAll(/^\| `([\w.]+)` \| ([^|]+) \| [^|]*\(([^)]+\.swift)\) \|$/gm)].map((m) => ({ name: m[1], screen: m[2].trim(), file: m[3] }))
}

function strip(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** Each unbounded loop that sleeps, with the name the `TickLedger.begin` before it in the same task registers. */
export function loopsOf(source: string): { name: string | null }[] {
  const code = strip(source)
  const out: { name: string | null }[] = []
  for (const m of code.matchAll(/\b(?:while\s+!Task\.isCancelled|while\s+true|repeat)\s*\{/g)) {
    let depth = 1
    let i = m.index! + m[0].length
    for (; i < code.length && depth; i++) depth += code[i] === '{' ? 1 : code[i] === '}' ? -1 : 0
    if (!/\b(?:Task|clock)\.sleep\b/.test(code.slice(m.index!, i))) continue
    // Back to the brace that opens the loop's own task or function: the registration is inside it, before the loop.
    let open = m.index!
    for (let d = 0; open > 0; open--) {
      if (code[open] === '}') d++
      else if (code[open] === '{' && d-- === 0) break
    }
    const before = code.slice(open, m.index!)
    out.push({ name: /TickLedger\.begin\("([\w.]+)"\)/.exec(before)?.[1] ?? null })
  }
  return out
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (name.endsWith('.swift')) out.push(path)
  }
  return out
}

describe("Work's clocks", () => {
  const clocks = clocksOf(design)
  const files = walk(WORK).map((path) => ({ file: relative(WORK, path), source: readFileSync(path, 'utf8') }))

  it('are named in IOS-DESIGN', () => {
    expect(clocks.map((c) => c.name).sort()).toEqual(['media.preparing', 'messages.hold', 'today.minute'])
  })

  it('are each registered by a named clock, in the file the table names', () => {
    const found: string[] = []
    const problems: string[] = []
    for (const { file, source } of files) {
      for (const loop of loopsOf(source)) {
        const clock = clocks.find((c) => c.name === loop.name)
        if (!loop.name) problems.push(`${file}: a repeating task that registers no clock in TickLedger`)
        else if (!clock) problems.push(`${file}: ${loop.name} is not in IOS-DESIGN's Clocks`)
        else if (clock.file !== file) problems.push(`${file}: ${loop.name} runs here, IOS-DESIGN says ${clock.file}`)
        else found.push(loop.name)
      }
    }
    expect(problems).toEqual([])
    expect(found.sort()).toEqual(clocks.map((c) => c.name).sort())
  })

  it('never run on a timer, a display link or a timeline', () => {
    const ticking = files.filter(({ source }) => /\bTimer\.(?:scheduled|publish)|CADisplayLink\(|\bTimelineView\b/.test(strip(source))).map((f) => f.file)
    expect(ticking).toEqual([])
  })

  it("leave Today at rest with what the table gives it, the count rest-today allows", () => {
    const today = clocks.filter((c) => c.screen === 'Today').length
    const run = readFileSync(resolve(repo, 'ios/TempCode/Sources/Perf/LaunchFrames.swift'), 'utf8')
    expect(today).toBe(1)
    expect(run).toMatch(new RegExp(`ticksAllowed: ${today}\\b`))
  })

  it('tells a clock from a bounded wait', () => {
    expect(loopsOf('.task {\n TickLedger.begin("a.b"); defer { TickLedger.end("a.b") }\n while !Task.isCancelled { try? await Task.sleep(for: .seconds(2)) }\n}')).toEqual([{ name: 'a.b' }])
    expect(loopsOf('.task { while !Task.isCancelled { try? await Task.sleep(for: .seconds(2)) } }')).toEqual([{ name: null }])
    expect(loopsOf('for _ in 0..<100 { try? await Task.sleep(for: .milliseconds(100)) }')).toEqual([])
    expect(loopsOf('while !Task.isCancelled { await next() }')).toEqual([])
  })
})
