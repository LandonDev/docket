import type { ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { ProofTimeout, watchProofChild, withinDeadline } from '../e2e-work-lib'

/** A paired proof owns just the children it started. One exit ends the other child's waits too. */
export class WorkProofChildren {
  private readonly lost = new AbortController()
  private readonly children: { name: string; pid?: number; exited: Promise<Error | null> }[] = []
  private stopping = false
  readonly signal: AbortSignal

  constructor(maxMs = 20 * 60_000) {
    this.signal = AbortSignal.any([this.lost.signal, AbortSignal.timeout(maxMs)])
  }

  track(child: ChildProcess, name: string): void {
    const exited = watchProofChild(child, name).then((error) => {
      if (!this.stopping) this.lost.abort(error ?? new Error(`${name} exited during the proof`))
      return error
    })
    this.children.push({ name, pid: child.pid, exited })
  }

  async until(label: string, ms: number, read: () => Promise<boolean> | boolean, note: (line: string) => void): Promise<boolean> {
    let lastError: unknown
    try {
      return await withinDeadline(label, ms, async (signal) => {
        while (true) {
          signal.throwIfAborted()
          try {
            if (await read()) return true
          } catch (error) {
            lastError = error
          }
          await delay(250, undefined, { signal })
        }
      }, this.signal)
    } catch (error) {
      if (!(error instanceof ProofTimeout)) throw error
      note(`${error.message}${lastError ? `; last error: ${String(lastError)}` : ''}`)
      return false
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    const results = await Promise.allSettled(this.children.splice(0).map(async ({ name, pid, exited }) => {
      if (!pid) return
      try {
        process.kill(-pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      await withinDeadline(`reap ${name}`, 5000, () => exited)
    }))
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, errors.map(String).join('\n'))
    this.signal.throwIfAborted()
  }
}
