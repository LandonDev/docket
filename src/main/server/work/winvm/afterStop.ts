import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What outlasts a restart of the box's service (docs/agents/work-winvm.md "After a restart"): the watcher's record
 * that the machine was awake when the service stopped, and his Sleep's hold.
 */

/** The record's file in the machine's run folder: the watcher writes it at the stop signal (watcher.ts). */
export const AWAKE_AT_STOP = 'awake-at-stop'

/** Whether the watcher left the record in `run`; the record is gone after, so it is read once. */
export function takeAwakeAtStop(run: string): boolean {
  const file = join(run, AWAKE_AT_STOP)
  if (!existsSync(file)) return false
  rmSync(file, { force: true })
  return true
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
