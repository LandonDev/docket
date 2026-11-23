import { LAPSE_NOTICE_DAYS, lapseStage } from '@shared/work/health'
import { lapsesOf } from '../../health'
import type { Source } from './index'

/**
 * A sign-in or a licence about to end (docs/agents/work-connections.md
 * "Things that lapse"), told by the host so the phone hears too. Fourteen
 * days before it waits for the digest; on the last day it carries its end
 * as its clock, so it interrupts. Read from what each module already holds
 * (`health.lapses`): no network, no child process.
 */

const HOUR = 3_600_000

const keyOf = (pillar: string, id: string, until: number, stage: number): string => `lapse:${pillar}:${id}:${until}:${stage}`

/** "Feb 17", "Feb 17, 2027" when it is another year: the same words every time it is read, so a re-read is not news. */
function dateWords(until: number, now: number): string {
  const end = new Date(until)
  const sameYear = end.getFullYear() === new Date(now).getFullYear()
  return end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}
const timeWords = (until: number): string => new Date(until).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

export const lapses: Source = {
  id: 'lapses',
  pillar: null,
  every: 6 * HOUR,
  prefix: 'lapse:',
  read(env, now) {
    const found = lapsesOf(env.ctx, env.modules)
    const lastStage = LAPSE_NOTICE_DAYS.length - 1
    return {
      tells: found.flatMap((lapse) => {
        const stage = lapseStage(lapse.until, now)
        if (stage === null) return []
        const last = stage === lastStage
        return [
          {
            kind: 'connections.ending',
            workspaceId: null,
            title: last ? `${lapse.title} ends ${dateWords(lapse.until, now)} at ${timeWords(lapse.until)}` : `${lapse.title} ends ${dateWords(lapse.until, now)}`,
            key: keyOf(lapse.pillar, lapse.id, lapse.until, stage),
            open: { settings: 'connections' },
            // Only on its last day can it not wait: until then the digest says it.
            ...(last ? { by: lapse.until } : {})
          }
        ]
      }),
      // A lapse still listed keeps every stage it was told at; one renewed or gone takes its rows with it.
      keep: found.flatMap((lapse) => LAPSE_NOTICE_DAYS.map((_, stage) => keyOf(lapse.pillar, lapse.id, lapse.until, stage)))
    }
  }
}
