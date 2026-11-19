import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { utilityProcess } from 'electron'
import { workerJobs, type SheetJobs } from './workerClient'

/**
 * The app's sheet worker: worker.ts built as its own entry (`sheetWorker` in
 * electron.vite.config.ts's MAIN_INPUTS) to out/main/sheetWorker.js, and
 * forked as a utility process. It is found at run time beside the main
 * bundle (this code may sit in out/main or in out/main/chunks), with no
 * bundler-specific import, so esbuild and vitest load this file too.
 */
export function sheetWorkerPath(): string | null {
  // CommonJS (the app's main bundle) has __dirname; an ESM bundle or a test does not, and runs the jobs in process.
  if (typeof __dirname !== 'string') return null
  for (const path of [join(__dirname, 'sheetWorker.js'), join(__dirname, '..', 'sheetWorker.js')]) if (existsSync(path)) return path
  return null
}

/** The worker as a utility process; null where no built worker is beside the main bundle (an esbuild-bundled proof). */
export function appJobs(): SheetJobs | null {
  const path = sheetWorkerPath()
  return path ? workerJobs(() => utilityProcess.fork(path, [], { serviceName: 'TempCode Sheets', stdio: 'inherit' })) : null
}
