import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Window } from './window'
import { words, type Cleanup, type Pair, type Shape } from './shape'

export type Context = {
  pair: Pair
  shape: Shape
  workspace: Awaited<ReturnType<Pair['workspace']>>
  folder: string
  evidencePage?: Window
}
type Step = { name: string; shapes?: readonly Shape[]; run(context: Context): void | Promise<void> }
type Journey = { id: string; title: string; tier: number; shapes: readonly Shape[]; steps: readonly Step[]; continueOnFailure?: boolean }
type StepResult = {
  name: string
  error?: string
  picture?: string
  toasts?: string[]
  saveLine?: string | null
  hostErrors?: string[]
  evidenceErrors?: string[]
}
export type JourneyResult = { id: string; title: string; shape: Shape; steps: StepResult[]; cleanup?: Cleanup; notRun?: 'no sandbox' }
export type Results = { journeys: JourneyResult[]; error?: string; cleanup?: Cleanup }

export function step(name: string, run: Step['run'], shapes?: readonly Shape[]): Step {
  return { name, run, shapes }
}

export function journey(spec: Journey): Journey {
  return spec
}

export function mainCheckout(repo: string): string {
  const git = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' }).trim()
  return dirname(resolve(repo, git))
}

export async function walk(spec: Journey, context: Context, stop: Promise<never>): Promise<JourneyResult> {
  const { pair, shape, folder } = context
  const result: JourneyResult = { id: spec.id, title: spec.title, shape, steps: [] }
  mkdirSync(folder, { recursive: true })
  const hostErrorStart = pair.hostErrors.length
  const steps = spec.steps.filter((step) => !step.shapes || step.shapes.includes(shape))
  for (const [i, { name, run }] of steps.entries()) {
    const entry: StepResult = { name }
    result.steps.push(entry)
    const page = () => context.evidencePage ?? pair.page
    const picture = `${String(i + 1).padStart(2, '0')}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')}.png`
    const savePicture = async () => {
      await page().shot(join(folder, picture))
      entry.picture = `${spec.id}-${shape}/${picture}`
    }
    try {
      pair.abort.signal.throwIfAborted()
      await Promise.race([run(context), stop])
      if (spec.tier === 3) await savePicture()
      console.log(`PASS ${spec.id} ${shape} ${name}`)
    } catch (error) {
      entry.error = words(error)
      console.error(`FAIL ${spec.id} ${shape} ${name}: ${entry.error.replace(/\s+/g, ' ')}`)
      const evidence = async <T>(want: string, get: () => Promise<T>): Promise<T | undefined> => {
        try {
          return await get()
        } catch (error) {
          (entry.evidenceErrors ??= []).push(`${want}: ${words(error)}`)
          return undefined
        }
      }
      const [, toasts, saveLine] = await Promise.all([
        evidence('picture', savePicture),
        evidence('toasts', () => page().toasts()),
        evidence('save line', () => page().saveLine())
      ])
      entry.hostErrors = [...new Set([...pair.hostErrors.slice(hostErrorStart), ...(context.evidencePage?.hostErrors ?? [])])]
      entry.toasts = toasts
      entry.saveLine = saveLine
      if (!spec.continueOnFailure || pair.abort.signal.aborted) break
    }
  }
  return result
}

export function saveResults(root: string, results: Results): void {
  writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2) + '\n')
}
