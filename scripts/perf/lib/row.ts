/**
 * A perf row: one thing he does, pressed three times in his shape, each press timed and counted (probe.ts). A row
 * reuses the journeys' own actions and never asserts a time: it records, and scripts/perf/table.ts sets the middle
 * press beside its budget.
 */
import type { Context } from '../../journeys/lib/record'
import type { Pair, Shape } from '../../journeys/lib/shape'
import type { Window } from '../../journeys/lib/window'
import { measure, type Counter, type MeasureOptions, type Sample } from './probe'

export type Workspace = Awaited<ReturnType<Pair['workspace']>>

/** What scripts/perf/seed-box.ts put in box before it started (a code-family run). */
export interface Seeded {
  workspaceId: string
  projectId: string
  path: string
  threads: { id: string; title: string; rows: number }[]
}

export interface PerfCtx {
  pair: Pair
  page: Window
  counter: Counter
  /** the job with the seeded LifeOS sector; in the code family, the seeded workspace */
  workspace: Workspace
  /** a second job, to switch to and from */
  other: Workspace
  /** what the pair was stood up for */
  family: 'work' | 'code'
  /** the seeded threads of a code-family run */
  seeded?: Seeded
  repo: string
  folder: string
  /** Takes the window's picture when a press never became usable, before anything tidies it */
  stuck?: () => Promise<void>
  /** One timed press. */
  time(options: MeasureOptions): Promise<Sample>
  /** The journeys' context for a shape, for their place helpers (`showPlace`, `fileAt`). */
  at(shape: Shape): Context
}

export interface Row {
  id: string
  title: string
  /** the pair it runs on: Work's (the default) or the code family's (`--family code`) */
  family?: 'work' | 'code'
  /** what the pair must have for it: the LifeOS sandbox, the loopback provider, a third machine */
  needs?: { sandbox?: boolean; fake?: boolean; desk?: boolean }
  /** The presses, each a sample; a row that cannot run throws its reason. */
  run(ctx: PerfCtx): Promise<Sample[]>
}

export const PRESSES = 3

export function perfCtx(base: Omit<PerfCtx, 'time' | 'at'>): PerfCtx {
  return {
    ...base,
    time: async (options) => {
      const sample = await measure(base.page, base.counter, base.pair.windowLink, options, base.pair.sandbox?.link)
      if (sample.usable === null) await base.stuck?.()
      return sample
    },
    at: (shape) => ({ pair: base.pair, shape, workspace: base.workspace, folder: base.folder })
  }
}

/** Three timed presses of one thing, with what puts it back between them. */
export async function thrice(ctx: PerfCtx, press: (i: number) => MeasureOptions | Promise<MeasureOptions>, between?: (i: number) => Promise<void>): Promise<Sample[]> {
  const samples: Sample[] = []
  for (let i = 0; i < PRESSES; i++) {
    if (between) await between(i)
    const sample = await ctx.time(await press(i))
    samples.push(sample)
    // A press that never got there says so once: two more would only spend the run's measured seconds.
    if (sample.usable === null) break
  }
  return samples
}
