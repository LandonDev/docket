import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/* Access on every Work screen, where the rule is pure enough to read in the source (docs/IOS-DESIGN.md "Access on
 * Work's screens"): under Reduce Motion nothing moves that is not a fade; glass only through `tcGlass` and the
 * system's glass buttons, which turn solid under Reduce Transparency; an ink laid at a fixed alpha over a picture
 * turns solid under Increase Contrast; and the commands the desktop binds carry the same keys on the open Duo. What
 * a source cannot show (VoiceOver's order, the largest text, the pointer's highlight) is the Mac's proof. */
const WORK = resolve(__dirname, '../ios/TempCode/Sources/Work')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (name.endsWith('.swift')) out.push(path)
  }
  return out
}

/** Each code line (comments out) with its file and number. */
function lines(): { file: string; line: number; code: string }[] {
  return walk(WORK).flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .map((text, i) => ({ file: relative(WORK, path), line: i + 1, code: text.replace(/\/\/.*$/, '') }))
  )
}

/** The Motion names that move something (a spring, a slide, a size), as against a fade or a count. */
const MOVING = /Motion\.(?:layout|glide|expand|drawer|rise|settleSlide|swapIn|swapOut|iconSwap)\b/
/** A moving animation whose movement is already gone under Reduce Motion, with why. */
const MOVING_ALLOWED: Record<string, string> = {
  // The mic's held scale is off under Reduce Motion (it dims instead): the spring then animates nothing that moves.
  'Capture/CaptureSheet.swift:held': 'the scale it springs is off under Reduce Motion'
}

export function motionProblems(all: { file: string; line: number; code: string }[]): string[] {
  const problems: string[] = []
  for (const { file, line, code } of all) {
    const transition = /\.transition\(([^\n]*)/.exec(code)
    if (transition && !/reduceMotion\s*\?/.test(code) && !/^\.opacity\)/.test(transition[1].trim())) problems.push(`${file}:${line}: a transition that moves, with no Reduce Motion fade`)
    if (/(?:withAnimation|\.animation)\(/.test(code) && MOVING.test(code) && !/reduceMotion/.test(code)) {
      const allowed = Object.keys(MOVING_ALLOWED).some((key) => key.startsWith(`${file}:`) && code.includes(key.split(':')[1]))
      if (!allowed) problems.push(`${file}:${line}: a moving animation with no Reduce Motion fade`)
    }
  }
  return problems
}

export function glassProblems(all: { file: string; line: number; code: string }[]): string[] {
  return all
    .filter(({ code }) => /\.glassEffect\(|\b(?:ultraThin|thin|regular|thick|ultraThick)Material\b/.test(code))
    .map(({ file, line }) => `${file}:${line}: glass or a material by hand; use tcGlass, which turns solid under Reduce Transparency`)
}

export function contrastProblems(all: { file: string; line: number; code: string }[]): string[] {
  return all
    .filter(({ code }) => /Color\.(?:black|white)[^\n]*\.opacity\(\s*0?\.\d/.test(code) && !/contrast/.test(code))
    .map(({ file, line }) => `${file}:${line}: an ink at a fixed alpha that stays thin under Increase Contrast`)
}

/** The desktop's keys the phone's Work screens carry, each where its command is (file, key). */
const KEYS: [string, RegExp][] = [
  ['Files/FolderScreen.swift', /Button\("New"[^\n]*\n\s*\.keyboardShortcut\("n", modifiers: \.command\)/],
  ['Files/FilesScreen.swift', /Button\("New"[^\n]*\n\s*\.keyboardShortcut\("n", modifiers: \.command\)/],
  ['OutboxPresses.swift', /Button\("Undo", action: undo\)\n\s*\.keyboardShortcut\("z", modifiers: \.command\)/],
  ['OutboxItemScreen.swift', /Button\(title\) \{ send\(item\) \}\n\s*\.keyboardShortcut\(\.return, modifiers: \.command\)/],
  ['Messages/ChatScreen.swift', /intent: \.send,[\s\S]{0,400}?\n\s*\)\n\s*\.keyboardShortcut\(\.return, modifiers: \.command\)/],
  ['Items/ItemPage.swift', /Button\("Send"\)[^\n]*\n\s*\.keyboardShortcut\(\.return, modifiers: \.command\)/]
]

describe("Work's screens", () => {
  const all = lines()

  it('fade instead of moving under Reduce Motion', () => {
    expect(motionProblems(all)).toEqual([])
  })

  it('draw glass only through the parts that honour Reduce Transparency', () => {
    expect(glassProblems(all)).toEqual([])
  })

  it('lay no fixed-alpha ink that stays thin under Increase Contrast', () => {
    expect(contrastProblems(all)).toEqual([])
  })

  it.each(KEYS)('%s carries its key', (file, shape) => {
    expect(readFileSync(join(WORK, file), 'utf8')).toMatch(shape)
  })

  it('reads the shapes it exists for', () => {
    const at = (code: string) => [{ file: 'X.swift', line: 1, code }]
    expect(motionProblems(at('.transition(.move(edge: .bottom))'))).toHaveLength(1)
    expect(motionProblems(at('.transition(reduceMotion ? .opacity : .move(edge: .bottom))'))).toEqual([])
    expect(motionProblems(at('.transition(.opacity)'))).toEqual([])
    expect(motionProblems(at('withAnimation(Motion.expand) { open.toggle() }'))).toHaveLength(1)
    expect(motionProblems(at('withAnimation(reduceMotion ? Motion.crossFade : Motion.expand) { open.toggle() }'))).toEqual([])
    expect(motionProblems(at('withAnimation(Motion.rowLeave) { gone = true }'))).toEqual([])
    expect(glassProblems(at('.glassEffect(.regular, in: Circle())'))).toHaveLength(1)
    expect(glassProblems(at('.background(.ultraThinMaterial)'))).toHaveLength(1)
    expect(contrastProblems(at('.background(Color.black.opacity(0.55))'))).toHaveLength(1)
    expect(contrastProblems(at('.background(Color.black.opacity(contrast == .increased ? 1 : 0.55))'))).toEqual([])
  })
})
