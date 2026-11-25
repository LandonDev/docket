import { readFileSync } from 'node:fs'
import type { LiveReading } from '../perf/vmScreenRows'

/** One reading of the live app (`tc-local admission.get`, in ms; null when it did not answer) and the disk's pressure. */
export function liveAppReading(): LiveReading {
  const t0 = performance.now()
  const r = Bun.spawnSync(['tc-local', 'admission.get', '{}'], { stdout: 'ignore', stderr: 'ignore', timeout: 5000 })
  const ms = performance.now() - t0
  const some = /^some avg10=([\d.]+)/m.exec(readFileSync('/proc/pressure/io', 'utf8'))
  return { appMs: r.exitCode === 0 ? ms : null, ioSome: some ? Number(some[1]) : 0 }
}
