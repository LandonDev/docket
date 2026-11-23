import { readFileSync } from 'node:fs'
import { mentionMatches } from '@shared/work'
import type { WorkCtx } from '../modules'
import { isIsolatedInstance } from '../service/config'

/**
 * A LifeOS stand-in for a proof on an isolated instance
 * (docs/agents/work-search.md "Proofs"): made-up rows from the JSON file
 * `TEMP_CODE_WORK_SEARCH_STANDIN` names, answered in LifeOS's place to this
 * pillar's own reads and to no other part of Work. It lets the whole path
 * be proven in a real window (the sources, the frame, the wire, the picker,
 * the tool) with no row of his. An installed host never takes it: the
 * app's own data folder is not an isolated instance, whatever its
 * environment says.
 */

/** LifeOS's lists by function name (`people:list`, `mail:search`, `tasks:search`, `tasks:list`, `events:range`, `projects:list`, `docs:list`, `catalog:search`, `chats:search`, `chats:find`). */
export type StandInRows = Record<string, Record<string, unknown>[]>

export function standInOf(env: NodeJS.ProcessEnv = process.env): StandInRows | null {
  const file = env.TEMP_CODE_WORK_SEARCH_STANDIN?.trim()
  if (!file || !isIsolatedInstance(env)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as StandInRows
  } catch {
    return null
  }
}

/** One function's answer from the rows, narrowed as LifeOS narrows it: by the sector asked for, and by the words for the functions that search. */
export function answer(rows: StandInRows, fn: string, args: Record<string, unknown> = {}): unknown {
  const sector = typeof args.sector === 'string' ? args.sector : undefined
  const text = typeof args.text === 'string' ? args.text : ''
  const mine = (rows[fn] ?? []).filter((row) => !sector || row.sector === sector)
  if (fn === 'mail:search') return mine.filter((m) => mentionMatches(text, m.subject as string, m.snippet as string, ...((m.senders as string[] | undefined) ?? [])))
  if (fn === 'tasks:search') return mine.filter((t) => mentionMatches(text, t.title as string))
  if (fn === 'tasks:byKeys') return (rows['tasks:search'] ?? []).filter((t) => ((args.keys as string[] | undefined) ?? []).some((key) => key.toUpperCase() === String(t.key ?? '').toUpperCase()))
  if (fn === 'tasks:list') return (rows['tasks:search'] ?? []).filter((t) => (!sector || t.sector === sector) && !['done', 'dropped'].includes(String(t.status ?? 'todo')))
  if (fn === 'catalog:search') return mine.filter((d) => mentionMatches(text, d.snippet as string))
  if (fn === 'chats:search') return mine.filter((m) => mentionMatches(text, m.text as string))
  if (fn === 'chats:find') return mine.filter((c) => mentionMatches(text, c.name as string))
  if (fn === 'docs:list') return { page: mine }
  if (fn === 'docs:get') return (rows['docs:list'] ?? []).find((d) => d._id === args.id) ?? null
  return mine
}

/** The context this pillar reads LifeOS through: the stand-in's rows, always connected. */
export function withStandIn<C extends WorkCtx>(ctx: C, rows: StandInRows): C {
  return {
    ...ctx,
    lifeos: {
      ...ctx.lifeos,
      connected: () => true,
      owner: () => ({
        query: async <T>(fn: string, args: Record<string, unknown> = {}) => answer(rows, fn, args) as T,
        mutation: async () => Promise.reject(new Error('the LifeOS stand-in changes nothing')),
        action: async () => Promise.reject(new Error('the LifeOS stand-in changes nothing'))
      }),
      subscribe: <T>(fn: string, args: unknown, on: (value: T) => void) => {
        on(answer(rows, fn, (args ?? {}) as Record<string, unknown>) as T)
        return () => {}
      }
    }
  }
}
