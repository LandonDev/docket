import { join } from 'node:path'
import type { ServiceChild } from './supervisor'

/**
 * Forks out/main/workService.js (the `workService` build entry) as an
 * Electron utility process. Electron is asked for only here, when the fork
 * happens, so a test that hands the supervisor its own spawn never loads it.
 */
export function spawnServiceChild(): ServiceChild {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app, utilityProcess } = require('electron') as typeof import('electron')
  const child = utilityProcess.fork(join(app.getAppPath(), 'out', 'main', 'workService.js'), [], { serviceName: 'TempCode Work', stdio: 'inherit' })
  return {
    post: (m) => child.postMessage(m),
    onMessage: (fn) => void child.on('message', fn),
    onExit: (fn) => void child.once('exit', (code) => fn(code)),
    kill: () => void child.kill()
  }
}

/** Where the hosted pages were built (electron.vite.config.ts `hostedPages`). */
export function hostedDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as typeof import('electron')
  return join(app.getAppPath(), 'out', 'hosted')
}
