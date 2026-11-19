import { utilityProcess } from 'electron'
import workerPath from './worker?modulePath'
import { workerJobs, type SheetJobs } from './workerClient'

/** The app's sheet worker: worker.ts as its own utility process (electron-vite builds it from the `?modulePath` import). */
export const appJobs = (): SheetJobs => workerJobs(() => utilityProcess.fork(workerPath, [], { serviceName: 'TempCode Sheets', stdio: 'inherit' }))
