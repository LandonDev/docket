import { writeFileSync } from 'node:fs'
import { comparePackages, graftPackage, importPackage, packageCsv, inspect, readWorkbookRange, savePackage } from './jobs'
import { colName, type A1Range } from './a1'
import type { WorkerAsk, WorkerAnswer } from './workerClient'

/**
 * The sheet worker's entry: a utility process main forks while it holds an
 * opened package (workerClient.ts). It runs jobs.ts one call at a time and
 * answers each by id. IronCalc's native code is loaded here and only here: a
 * panic in it ends this process, main sees it go, answers the call in flight
 * with an error and forks a fresh one for the next.
 */

const parent = process.parentPort
if (!parent) {
  console.error('the sheet worker runs only as a utility process')
  process.exit(1)
}

async function run(ask: WorkerAsk): Promise<unknown> {
  switch (ask.op) {
    case 'inspect':
      return inspect(ask.path)
    case 'read':
      return readWorkbookRange(importPackage(ask.path).workbook, ask.range as A1Range, colName)
    case 'save': {
      const { bytes, report } = await savePackage(ask.path, ask.edits, ask.ironcalcDir, ask.formats)
      writeFileSync(ask.output, bytes)
      return { report }
    }
    case 'compare':
      return comparePackages(ask.from, ask.to, ask.max)
    case 'graft':
      return graftPackage(ask.original, ask.written, ask.output, ask.ops)
    case 'csv':
      return packageCsv(ask.path, ask.sheet)
  }
}

let queue = Promise.resolve()
parent.on('message', (event: { data: unknown }) => {
  const ask = event.data as WorkerAsk
  queue = queue.then(async () => {
    let answer: WorkerAnswer
    try {
      answer = { id: ask.id, ok: true, value: await run(ask) }
    } catch (err) {
      answer = { id: ask.id, ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    parent.postMessage(answer)
  })
})
