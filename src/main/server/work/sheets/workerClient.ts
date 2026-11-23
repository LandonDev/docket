import type { SheetCellDiff, SheetMutationJson } from '@shared/contract-work-sheets'
import type { A1Range } from './a1'
import type { ComposeAsk } from './compose'
import type { Inspected, PackageRules, ReadCell, SaveAnswer } from './jobs'
import type { EditSpec } from './patch/patch'
import type { StructuralOp } from './structural'

/**
 * Main's side of the sheet worker (worker.ts): the jobs on an opened package,
 * run off main's thread and outside its process. `SheetJobs` is what the
 * pillar calls; the app's is `workerJobs()`, a test's `localJobs()`.
 */

export type WorkerAsk = { id: number } & (
  | { op: 'inspect'; path: string }
  | { op: 'read'; path: string; range: A1Range }
  | { op: 'save'; path: string; output: string; edits: EditSpec[]; ironcalcDir: string | null; formats?: SheetMutationJson[] }
  | { op: 'compare'; from: string; to: string; max: number }
  | { op: 'graft'; original: string; written: string; output: string; ops: StructuralOp[] }
  | { op: 'csv'; path: string; sheet?: string }
  | { op: 'compose'; ask: ComposeAsk }
  | { op: 'rules'; path: string }
)
export type WorkerAnswer = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string }

export interface SheetJobs {
  inspect(path: string): Promise<Inspected>
  read(path: string, range: A1Range): Promise<{ sheet: string; cells: ReadCell[][] }>
  /** writes the patched package to `output`; the caller moves it into place. `formats` are the grid's formatting mutations, each named by its tab. */
  save(path: string, output: string, edits: EditSpec[], ironcalcDir: string | null, formats?: SheetMutationJson[]): Promise<SaveAnswer>
  compare(from: string, to: string, max: number): Promise<{ cells: SheetCellDiff[]; truncated: boolean }>
  /** writes LibreOffice's package with what it drops put back; answers what was put back */
  graft(original: string, written: string, output: string, ops: StructuralOp[]): Promise<string[]>
  /** one sheet of a package as CSV */
  csv(path: string, sheet?: string): Promise<string>
  /** a format an agent asked for, as the mutations the row's own press would make (compose.ts) */
  compose(ask: ComposeAsk): Promise<SheetMutationJson[]>
  /** the rules a package holds now, as the importer reads them: what one more rule is added to */
  rules(path: string): Promise<PackageRules>
  stop(): void
}

type Ask = WorkerAsk extends infer A ? (A extends { id: number } ? Omit<A, 'id'> : never) : never

/** A job takes at most this long; a save of a 100,000-row file with IronCalc takes about 20 s. */
const JOB_MS = 5 * 60_000

interface Child {
  postMessage(m: unknown): void
  on(event: 'message', fn: (m: unknown) => void): void
  on(event: 'exit', fn: (code: number) => void): void
  kill(): boolean
}

/** The worker as a utility process, forked when first asked and again after it dies. */
export function workerJobs(fork: () => Child): SheetJobs {
  let child: Child | null = null
  let next = 1
  const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>()
  const settle = (id: number, fn: (w: { resolve(v: unknown): void; reject(e: Error): void }) => void): void => {
    const w = waiting.get(id)
    if (!w) return
    waiting.delete(id)
    clearTimeout(w.timer)
    fn(w)
  }
  const ensure = (): Child => {
    if (child) return child
    const c = fork()
    c.on('message', (m) => {
      const a = m as WorkerAnswer
      settle(a.id, (w) => (a.ok ? w.resolve(a.value) : w.reject(new Error(a.error))))
    })
    c.on('exit', (code) => {
      if (child === c) child = null
      for (const id of [...waiting.keys()]) settle(id, (w) => w.reject(new Error(`the sheet worker stopped (exit ${code})`)))
    })
    child = c
    return c
  }
  const call = <T>(ask: Ask): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = next++
      const timer = setTimeout(() => {
        settle(id, (w) => w.reject(new Error('the sheet worker did not answer in time')))
        // A job that runs away holds the queue behind it: start over.
        child?.kill()
      }, JOB_MS)
      waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      ensure().postMessage({ ...ask, id })
    })
  return {
    inspect: (path) => call({ op: 'inspect', path }),
    read: (path, range) => call({ op: 'read', path, range }),
    save: (path, output, edits, ironcalcDir, formats) => call({ op: 'save', path, output, edits, ironcalcDir, ...(formats?.length ? { formats } : {}) }),
    compare: (from, to, max) => call({ op: 'compare', from, to, max }),
    graft: (original, written, output, ops) => call({ op: 'graft', original, written, output, ops }),
    csv: (path, sheet) => call({ op: 'csv', path, ...(sheet === undefined ? {} : { sheet }) }),
    compose: (ask) => call({ op: 'compose', ask }),
    rules: (path) => call({ op: 'rules', path }),
    stop() {
      child?.kill()
      child = null
    }
  }
}

/** The same jobs in this process: for tests, and for a host that has no utility processes. */
export async function localJobs(): Promise<SheetJobs> {
  const { comparePackages, graftPackage, importPackage, inspect, packageCsv, packageRules, readWorkbookRange, savePackage } = await import('./jobs')
  const { formatMutations } = await import('./compose')
  const { colName } = await import('./a1')
  const { writeFileSync } = await import('node:fs')
  return {
    inspect: async (path) => inspect(path),
    read: async (path, range) => readWorkbookRange(importPackage(path).workbook, range, colName),
    async save(path, output, edits, ironcalcDir, formats) {
      const { bytes, report } = await savePackage(path, edits, ironcalcDir, formats)
      writeFileSync(output, bytes)
      return { report }
    },
    compare: async (from, to, max) => comparePackages(from, to, max),
    graft: async (original, written, output, ops) => graftPackage(original, written, output, ops),
    csv: async (path, sheet) => packageCsv(path, sheet),
    compose: async (ask) => formatMutations(ask),
    rules: async (path) => packageRules(path),
    stop() {}
  }
}
