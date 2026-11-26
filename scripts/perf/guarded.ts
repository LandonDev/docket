/**
 * Runs one command under the live box's guard (lib/guard.ts): every load proof that is not `bun run perf` itself
 * goes through it (the soak, scripts/perf/host.ts, the launch timing, the video proofs, a bench, a big copy).
 *
 *   bun scripts/perf/guarded.ts [--cores 24-31] <command> [args…]
 *
 * The command runs in a process group of its own, pinned to the last eight cores unless `--cores none`, at the
 * lowest cpu and disk priority. When two hellos of the live box in a row pass 800 ms, or the disk's pressure
 * passes 30, the guard stops that group, the one it started, and exits 75 with the reason. Otherwise it exits
 * as the command did. It kills nothing by name.
 */
import { spawn } from 'node:child_process'
import { guardLiveBox } from './lib/guard'
import { lastCores, CORES } from './run'

export const STOPPED_BY_GUARD = 75

/** `[--cores <list|none>] <command…>`: the pin and the command. */
export function guardedArgs(args: string[], all?: number): { cores: string | null; command: string[] } {
  let cores: string | null = lastCores(CORES, all)
  let rest = args
  if (rest[0] === '--cores') {
    const list = rest[1] ?? ''
    if (list !== 'none' && !/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(list)) throw new Error('--cores is a taskset list, as 24-31, or none')
    cores = list === 'none' ? null : list
    rest = rest.slice(2)
  }
  if (!rest.length) throw new Error('usage: bun scripts/perf/guarded.ts [--cores 24-31|none] <command> [args…]')
  return { cores, command: rest }
}

/** The argv that runs `command` niced, at idle disk priority and pinned. */
export function wrapped(cores: string | null, command: string[]): string[] {
  return ['ionice', '-c', '3', 'nice', '-n', '19', ...(cores ? ['taskset', '-c', cores] : []), ...command]
}

async function main(): Promise<number> {
  const { cores, command } = guardedArgs(process.argv.slice(2))
  const argv = wrapped(cores, command)
  const child = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit', detached: true })
  const group = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid) process.kill(-child.pid, signal)
    } catch {
      // already gone
    }
  }
  const abort = new AbortController()
  const guard = guardLiveBox(abort)
  let why: string | null = null
  abort.signal.addEventListener('abort', () => {
    why = abort.signal.reason instanceof Error ? abort.signal.reason.message : String(abort.signal.reason)
    console.error(`guarded: stopping the job, ${why}`)
    group('SIGTERM')
    setTimeout(() => group('SIGKILL'), 5000).unref()
  }, { once: true })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => group(signal))
  const code = await new Promise<number>((resolve) => {
    child.once('error', (error) => (console.error(`guarded: ${error.message}`), resolve(127)))
    child.once('exit', (exit, signal) => resolve(exit ?? (signal ? 128 : 1)))
  })
  const times = guard.stop()
  const answered = times.filter((ms): ms is number => ms !== null)
  console.error(`guarded: the live box's hello ${answered.length ? `${Math.min(...answered)} to ${Math.max(...answered)} ms over ${times.length} asks` : 'was not watched'}; io pressure at most ${guard.pressure() ?? 'unknown'}`)
  return why ? STOPPED_BY_GUARD : code
}

if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}
