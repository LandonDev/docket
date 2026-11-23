import { join } from 'node:path'
import { appRoot } from '../../appRoot'
import type { ServiceChild } from './supervisor'

/**
 * Forks out/main/workService.js (the `workService` build entry) as an
 * Electron utility process. Electron is asked for only here, when the fork
 * happens, so a test that hands the supervisor its own spawn never loads it.
 * The path is counted from the code that runs (appRoot), never from
 * app.getAppPath(): under a code-only update that is the bundle, whose
 * `out/` is the older one (docs/agents/code-only-updates.md).
 */
export function spawnServiceChild(): ServiceChild {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { utilityProcess } = require('electron') as typeof import('electron')
  const child = utilityProcess.fork(join(appRoot(), 'out', 'main', 'workService.js'), [], { serviceName: 'TempCode Work', stdio: 'inherit' })
  return {
    post: (m) => child.postMessage(m),
    onMessage: (fn) => void child.on('message', fn),
    onExit: (fn) => void child.once('exit', (code) => fn(code)),
    kill: () => void child.kill()
  }
}

/** Where the hosted pages were built (electron.vite.config.ts `hostedPages`). */
export function hostedDir(): string {
  return join(appRoot(), 'out', 'hosted')
}
