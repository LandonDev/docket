import { z } from 'zod'
import type { WorkspaceMeta } from './domain'
import type { CanvasSource } from './work/canvas'

/** A reveal carries saved ids. The host resolves file sources itself. */
const id = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/)
const settings = z.enum([
  'general', 'appearance', 'editor', 'keybindings', 'remote', 'defaults',
  'providers', 'addons', 'skills', 'orchestration', 'reviews', 'appshots',
  'computer', 'archive', 'work', 'connections'
])
const viewAt = z.enum(['agenda', 'mail', 'messages', 'people', 'projects', 'tasks'])
const view = z.enum([
  ...viewAt.options, 'files', 'forms', 'money', 'plays', 'prep', 'routines', 'templates'
])
const place = z.enum(['today', 'review'])

const held = z.discriminatedUnion('at', [
  z.object({ at: z.literal('host'), id }).strict(),
  z.object({ at: z.literal('lifeos'), table: z.enum(['outbox', 'calendarOps']), id }).strict()
])

/** Flat for Swift, like TellOpen. Exactly one TellOpen variant or a saved canvas item. */
export const RevealTargetSchema = z.object({
  thread: id.optional(),
  view: view.optional(),
  workspaceId: id.optional(),
  at: id.optional(),
  place: place.optional(),
  item: id.optional(),
  held: held.optional(),
  settings: settings.optional()
}).strict().refine((t) => {
  const { held, item, place, settings, thread, view, workspaceId, at } = t
  if ([held, item, place, settings, view, held ? undefined : thread].filter(Boolean).length !== 1) return false
  if (view) {
    if (!workspaceId) return false
    if (view === 'prep') return !!at
    return !at || viewAt.safeParse(view).success
  }
  if (workspaceId) return false
  return !at || (place === 'review' && /^\d{1,15}$/.test(at) && Number(at) <= 8.64e15)
}, { message: 'Pick one Work destination.' })

export const RevealParamsSchema = z.object({ target: RevealTargetSchema }).strict()
export const RevealAnswerSchema = z.object({ opened: z.literal(true) })

export type RevealTarget = z.infer<typeof RevealTargetSchema>
export type RevealParams = z.infer<typeof RevealParamsSchema>
export type RevealAnswer = z.infer<typeof RevealAnswerSchema>

export const REVEAL_INVALID = 'bad request: Pick a known Work destination by its ID.'
export const REVEAL_NO_WINDOW = 'Open a Docket window on this computer first.'
export const REVEAL_LOCKED = 'Unlock this computer to open that destination.'

type RevealItem =
  | { owner: string }
  | { tab: string; itemId: string }
  | { ref: CanvasSource; name: string }

/** The local window gets only the checked target and the details its openers need. */
export interface RevealNavigation {
  target: RevealTarget
  workspace?: Pick<WorkspaceMeta, 'id' | 'path'>
  item?: RevealItem
}
