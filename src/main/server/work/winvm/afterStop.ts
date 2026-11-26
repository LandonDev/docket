import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What outlasts a restart of the box's service (docs/agents/work-winvm.md "After a restart"): that the machine was
 * awake when the service stopped, and his Sleep's hold.
 */

/** The watcher's record in the machine's run folder, written at the stop signal (watcher.ts). */
export const AWAKE_AT_STOP = 'awake-at-stop'
/**
 * The keeper's own mark beside it, there while it holds the machine awake. The watcher is the one QEMU started
 * with, so a machine woken under an older build stops under that build's watcher, which writes no record (the
 * deploy of 2026-11-25): the mark says awake all the same.
 */
export const AWAKE_MARK = 'awake'

/** The keeper's mark: written as the machine comes awake, gone once the keeper sees it asleep. */
export function awakeMark(run: string): { set(on: boolean): void } {
  const file = join(run, AWAKE_MARK)
  return {
    set: (on) => {
      if (!on) return rmSync(file, { force: true })
      if (existsSync(run)) writeFileSync(file, `${new Date().toISOString()}\n`)
    }
  }
}

/**
 * At Work's start: whether the machine was awake when the service stopped, by the watcher's record or the keeper's
 * mark. Both are gone after, so it is read once. Beside a running QEMU (Work turned off and on, a deploy's trial
 * before the stop) nothing was stopped: the answer is no, the mark stays and an old record goes.
 */
export function takeAwakeAtStop(run: string, running: boolean): boolean {
  const record = join(run, AWAKE_AT_STOP)
  const mark = join(run, AWAKE_MARK)
  const was = !running && (existsSync(record) || existsSync(mark))
  rmSync(record, { force: true })
  if (!running) rmSync(mark, { force: true })
  return was
}

/** His Sleep's hold, as a file in the keeper's folder: present while a person's Sleep holds the machine asleep. */
export function heldMark(dir: string): { get(): boolean; set(on: boolean): void } {
  const file = join(dir, 'held-asleep')
  return {
    get: () => existsSync(file),
    set: (on) => {
      if (!on) return rmSync(file, { force: true })
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(file, `${new Date().toISOString()}\n`)
    }
  }
}
