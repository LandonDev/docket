import { z } from 'zod'

/**
 * What a host says of its own screen and power (docs/box.md "The relay"),
 * in a file of its own: the Mac bridge's contract carries it, and the
 * renderer's first paint reads that contract, so these must not import the
 * relay's method table (contract-relay.ts), which mounts every contract
 * file Work has. contract-relay.ts re-exports all of this.
 */
export const ScreenStateSchema = z.enum(['unlocked', 'locked', 'unknown'])
export const PowerStateSchema = z.enum(['awake', 'asleep', 'unknown'])
export type ScreenState = z.infer<typeof ScreenStateSchema>
export type PowerState = z.infer<typeof PowerStateSchema>

/** What a host reports of itself (src/main/presence.ts). */
export const MacPresenceSchema = z.object({
  screen: ScreenStateSchema,
  power: PowerStateSchema,
  /** When this picture was taken on the host (its clock). */
  at: z.number().int(),
  /** The screen saver is up and leaving it needs no password (src/shared/screenState.ts): `screen` reads unlocked, and screen work dismisses it first. Absent from an older host. */
  saver: z.boolean().optional()
})
export type MacPresence = z.infer<typeof MacPresenceSchema>
