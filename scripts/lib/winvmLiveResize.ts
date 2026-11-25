/**
 * The pure parts of scripts/e2e-winvm-liveresize.ts: its rows, the steps Turn on said in order, and what the
 * guest's and QEMU's answers say. Tested in winvmLiveResize.test.ts; the script itself needs a machine.
 */
import { LIVE_RESIZE_WORDS } from '../../src/shared/contract-work-winvm'

/** One fact the proof read. `ok` is null for a record that checks nothing (a time, a skip); it never asserts a time. */
export interface ProofRow {
  part: 1 | 2
  step: string
  ok: boolean | null
  detail: string
  /** ms since the part began */
  at: number
}

/** Turn on's six step words, in the order the keeper says them. */
export const UPGRADE_WORDS: readonly string[] = [LIVE_RESIZE_WORDS.driver, LIVE_RESIZE_WORDS.stage, LIVE_RESIZE_WORDS.restart, LIVE_RESIZE_WORDS.point, LIVE_RESIZE_WORDS.start, LIVE_RESIZE_WORDS.cursor]

/** The steps the pushes said, a repeat of the one before dropped and settled states (null) left out. */
export function stepsSeen(steps: readonly (string | null | undefined)[]): string[] {
  const out: string[] = []
  for (const s of steps) if (s && out.at(-1) !== s) out.push(s)
  return out
}

/** Every word of `want` said, in its order, whatever else was said between. */
export function saidInOrder(seen: readonly string[], want: readonly string[]): boolean {
  let at = 0
  for (const s of seen) if (s === want[at]) at++
  return at === want.length
}

/** The display device QEMU runs with, from its /proc cmdline (NUL-separated); null when it names neither. */
export function qemuDevice(cmdline: string): 'virtio' | 'vga' | null {
  const args = cmdline.split('\0')
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-device' && args[i + 1]!.startsWith('virtio-vga')) return 'virtio'
    if (args[i] === '-vga' && args[i + 1] === 'std') return 'vga'
  }
  return null
}

/** `name=value` from a script's last line that has it; null when none does. */
export function valueOf(out: string, name: string): string | null {
  const lines = out.split(/\r?\n/).filter((l) => l.startsWith(`${name}=`))
  return lines.length ? lines.at(-1)!.slice(name.length + 1).trim() : null
}

/** The part to run: `--part 1` (Turn on, a resize, Turn off, back to the point) or `--part 2` (a stop between steps 5 and 6). */
export function partOf(argv: readonly string[]): 1 | 2 {
  const i = argv.indexOf('--part')
  const v = i >= 0 ? argv[i + 1] : undefined
  if (v === '1' || v === '2') return Number(v) as 1 | 2
  throw new Error('--part 1 (Turn on, a resize, Turn off, back to the point) or --part 2 (a stop between steps 5 and 6)')
}

/** The JSON the proof prints: its rows, and whether every check held. */
export function report(part: 1 | 2, rows: readonly ProofRow[], error: string | null): { part: 1 | 2; ok: boolean; failed: string[]; error: string | null; rows: readonly ProofRow[] } {
  const failed = rows.filter((r) => r.ok === false).map((r) => r.step)
  return { part, ok: !error && failed.length === 0, failed, error, rows }
}
