import type { Tier } from '@shared/computer/protocol'
import type { SessionTierGate } from '../../computer/tierGate'

/**
 * The Windows VM's session tier (plan-m1X24rQ6nikm B5): admitted. A headless
 * box refuses the session tier because there is a person whose input it must
 * not take (tierGate.ts REFUSE_SESSION_TIER); in the guest there is nobody but
 * him, and while he drives every thread's call is refused before it reaches
 * the gate (`ownerDrivesLine`, computer.drive). On Windows a chord (Ctrl+S), a
 * held key and a paste into a browser all need the tier (§29.4.2).
 *
 * And it is the only event tier the guest gets: with nobody to disturb, real
 * input is what an app answers to. Posted messages (`process`, `front`) said
 * `changed` in a Save as dialog whose File name kept its old text and saved
 * under it (the box's Work run of 2026-11-22), as B10's held press did.
 */
export const VM_TIER_GATE: SessionTierGate = {
  admitted: () => true,
  frontAdmitted: () => true,
  request: async () => ({ admit: true }),
  run: (ctx, send) => send(vmTiers(ctx.tiers))
}

/** A call's tiers in the guest: `ax` as asked, and the session tier in place of the posted ones whenever it is allowed. */
export function vmTiers(tiers: Tier[]): Tier[] {
  return tiers.includes('session') ? tiers.filter((t) => t !== 'process' && t !== 'front') : tiers
}
