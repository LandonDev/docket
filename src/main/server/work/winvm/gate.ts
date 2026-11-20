import type { SessionTierGate } from '../../computer/tierGate'

/**
 * The Windows VM's session tier (plan-m1X24rQ6nikm B5): admitted. A headless
 * box refuses the session tier because there is a person whose input it must
 * not take (tierGate.ts REFUSE_SESSION_TIER); in the guest there is nobody but
 * him, and while he drives every thread's call is refused before it reaches
 * the gate (`ownerDrivesLine`, computer.drive). On Windows a chord (Ctrl+S), a
 * held key and a paste into a browser all need the tier (§29.4.2).
 */
export const VM_TIER_GATE: SessionTierGate = {
  admitted: () => true,
  frontAdmitted: () => true,
  request: async () => ({ admit: true }),
  run: (ctx, send) => send(ctx.tiers)
}
