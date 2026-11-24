import { z } from 'zod'
import { SectorKeySchema } from './work/ids'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The lifeos pillar's wire (docs/agents/work-lifeos.md): this host's sign-in
 * to LifeOS, the JWT a screen asks for, and which workspace each sector key
 * serves. No answer and no push ever carries the device token or a sector
 * key: the token stays in this host's vault, each key in its add-on row's
 * grant.
 */

/**
 * Where this host stands with LifeOS, as a screen draws it.
 *  - `off`: Work is off on this host.
 *  - `signed-out`: no device token here.
 *  - `pairing`: a sign-in code waits for the owner's approval in LifeOS; `code` only to a caller with admin.
 *  - `connecting`: a token is here and the first trade has not come back.
 *  - `connected`: the host acts as the owner.
 *  - `unreachable`: LifeOS did not answer; the host keeps trying.
 *  - `refused`: LifeOS refused this host's token (revoked); sign in again.
 */
export const LifeosStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('off') }),
  z.object({ state: z.literal('signed-out') }),
  z.object({ state: z.literal('pairing'), code: z.string().optional(), expiresAt: z.number() }),
  z.object({ state: z.literal('connecting') }),
  z.object({ state: z.literal('connected'), ownerId: z.string(), since: z.number() }),
  z.object({ state: z.literal('unreachable'), since: z.number(), error: z.string() }),
  z.object({ state: z.literal('refused'), error: z.string() })
])
export type LifeosState = z.infer<typeof LifeosStateSchema>
export type LifeosStateName = LifeosState['state']

/**
 * One linked scope's sector key on this host: a workspace's, or the Work
 * Chats' (`workspaceId: "~work"`, every sector).
 *  - `ready`: the key is minted and its add-on row holds it.
 *  - `waiting`: LifeOS is not connected here, so nothing is minted yet.
 *  - `elsewhere`: the workspace's add-ons live on another host (a linked workspace), which mints its key.
 *  - `failed`: the last try failed; `error` says why, and the next pass tries again.
 */
export const LifeosKeyStateSchema = z.object({
  workspaceId: z.string(),
  sectors: z.array(SectorKeySchema),
  state: z.enum(['ready', 'waiting', 'elsewhere', 'failed']),
  /** the add-on row that holds the key, once there is one */
  addonId: z.string().optional(),
  error: z.string().optional()
})
export type LifeosKeyState = z.infer<typeof LifeosKeyStateSchema>

export interface LifeosStatus {
  lifeos: LifeosState
  keys: LifeosKeyState[]
}

/** What `work.lifeos.jwt` answers: a JWT while connected, with the Convex address it is good for; else the state that stopped it. */
export type LifeosJwtAnswer = { ok: true; jwt: string; expiresAt: number; url: string } | { ok: false; state: Exclude<LifeosStateName, 'connected'> }

export const LifeosRequestSchemas = [
  /** → LifeosStatus; a pairing's code only to a caller with admin */
  request('work.lifeos.status', z.object({}).optional()),
  /** → { code, expiresAt }: a sign-in code to approve in LifeOS ("Approve a sign-in"); the host polls for the token itself */
  request('work.lifeos.pairStart', z.object({ name: z.string().max(80).optional() }).optional()),
  /** → LifeosStatus: drops a pairing that waits */
  request('work.lifeos.pairCancel', z.object({}).optional()),
  /** → LifeosStatus: signs in with a device token made elsewhere (`auth:mint`); refused unless LifeOS takes it */
  request('work.lifeos.setToken', z.object({ token: z.string().min(8).max(512) })),
  /** → LifeosStatus: ends this host's LifeOS session and drops its token; the sector keys stay */
  request('work.lifeos.signOut', z.object({}).optional()),
  /** → LifeosJwtAnswer: a one-hour JWT for a screen, narrowed to `sector` when given */
  request('work.lifeos.jwt', z.object({ sector: SectorKeySchema.optional() }).optional()),
  /** → LifeosStatus: links a code workspace to a sector (null unlinks); its key is minted or retired */
  request('work.lifeos.link', z.object({ workspaceId: z.string(), sector: SectorKeySchema.nullable() }))
] as const

export type LifeosPush = { push: 'work.lifeos'; status: LifeosStatus }

export const LIFEOS_CAPS = {
  'work.lifeos.status': 'read',
  'work.lifeos.pairStart': 'admin',
  'work.lifeos.pairCancel': 'admin',
  // Local only (pc-setup.md): a remote key never writes this host's LifeOS session, relayed or not.
  'work.lifeos.setToken': 'local',
  'work.lifeos.signOut': 'admin',
  // A LifeOS JWT can do what the owner does there, his own send included: the press is approve's.
  'work.lifeos.jwt': 'approve',
  'work.lifeos.link': 'admin'
} satisfies CapsOf<typeof LifeosRequestSchemas>

/** A device token is set on the host that keeps it, never carried through another; a JWT crosses to a far host only while its screen is unlocked. */
export const LIFEOS_RELAY = { 'work.lifeos.jwt': 'screen' } satisfies RelayOf<typeof LifeosRequestSchemas>
