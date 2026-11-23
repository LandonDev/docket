import { z } from 'zod'
import { ContextChipSchema } from './work/canvas'
import { SEARCH_SNIPPET, SEARCH_TEXT_MAX, type SearchHit } from './work/search'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The search pillar's wire (docs/agents/work-search.md): one field over
 * everything in Work. `query` serves both speeds: `{text, tier: 'instant'}`
 * answers what this host knows without the network and names the sources
 * still to ask (`pending`); `{text, sources: [id]}` asks those, each on its
 * own. `opened` writes his own mark for Recent. Both are `approve`, as
 * `work.canvas.mentions` is: an answer holds what LifeOS holds. No param
 * names a path: a file is a ref inside a hit's `open`, which the fence
 * reads.
 */

/** A value of `open.with`: an id, a flag, or a small record of them (`doc: { id, title }`). */
const Scalar = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])
const WithSchema = z
  .record(z.string().max(40), z.union([Scalar, z.record(z.string().max(40), Scalar).refine((r) => Object.keys(r).length <= 8)]))
  .refine((r) => Object.keys(r).length <= 8, 'at most eight fields')

export const SearchOpenSchema = z.discriminatedUnion('to', [
  z.object({ to: z.literal('view'), view: z.string().min(1).max(40), with: WithSchema.optional() }),
  z.object({ to: z.literal('thread'), sessionId: z.string().min(1).max(200), seq: z.number().int().nonnegative().optional() }),
  z.object({ to: z.literal('file'), ref: z.unknown(), name: z.string().max(500) }),
  z.object({ to: z.literal('chip'), chip: ContextChipSchema })
])

export const SearchHitSchema = z.object({
  key: z.string().min(1).max(600),
  kind: z.string().min(1).max(40),
  title: z.string().max(500),
  detail: z.string().max(500).optional(),
  snippet: z.string().max(SEARCH_SNIPPET).optional(),
  at: z.number().optional(),
  workspaceId: z.string().max(200).nullable(),
  open: SearchOpenSchema,
  chip: ContextChipSchema.optional(),
  cloud: z.literal(true).optional(),
  openedAt: z.number().optional()
}) satisfies z.ZodType<SearchHit>

export const SearchRequestSchemas = [
  /** → SearchAnswer */
  request(
    'work.search.query',
    z.object({
      text: z.string().max(SEARCH_TEXT_MAX),
      /** one job; absent: every job of this host, and Work Chats */
      workspaceId: z.string().max(200).optional(),
      /** only what this host answers without the network; the rest come back as `pending` */
      tier: z.literal('instant').optional(),
      /** only these sources, by the ids `pending` named */
      sources: z.array(z.string().max(80)).max(40).optional(),
      /** one kind alone, with `SEARCH_ALL` rows */
      kind: z.string().max(40).optional(),
      /** leave out what is read from LifeOS: another host of his asks it */
      own: z.boolean().optional()
    })
  ),
  /** → {}: he opened this hit; kept for Recent on this host */
  request('work.search.opened', z.object({ hit: SearchHitSchema }))
] as const

export type SearchPush = never
export const SEARCH_CAPS = {
  'work.search.query': 'approve',
  'work.search.opened': 'approve'
} satisfies CapsOf<typeof SearchRequestSchemas>
export const SEARCH_RELAY = {
  'work.search.query': 'screen',
  'work.search.opened': 'screen'
} satisfies RelayOf<typeof SearchRequestSchemas>
