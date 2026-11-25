import type { ProviderId } from '../catalog'

/**
 * The harnesses a Work thread may run on, shared by the host's rule (work/scope.ts `workProviderRefusal`, where the
 * reasons are) and the window's model picker, which offers no other in a Work thread or draft. A leaf with no imports
 * but a type, so the composer's Work row can read it without pulling the host's scope rules in.
 */
export const WORK_PROVIDERS: readonly ProviderId[] = ['claude', 'codex', 'muse']
