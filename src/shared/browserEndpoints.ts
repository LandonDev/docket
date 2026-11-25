import { z } from 'zod'

/** A host's own browser endpoints, carried only on the main-process peer link. */
export const BrowserEndpointsSchema = z.object({
  listenerPorts: z.array(z.number().int().min(1).max(65535)).min(1).max(8),
  lanAddresses: z.array(z.string().min(1).max(253)).max(256),
  remoteRoutes: z.array(z.string().min(1).max(2048)).max(8),
  tunnelHosts: z.array(z.string().min(1).max(253)).max(8).optional()
})

export type BrowserEndpoints = {
  listenerPorts: readonly number[]
  lanAddresses: readonly string[]
  remoteRoutes: readonly string[]
  tunnelHosts?: readonly string[]
}

/** Older peers answer the heartbeat without endpoints. An incomplete reply proves nothing. */
export function browserEndpointsFromReply(reply: unknown): BrowserEndpoints | undefined {
  if (!reply || typeof reply !== 'object' || !('browserEndpoints' in reply)) return
  const parsed = BrowserEndpointsSchema.safeParse(reply.browserEndpoints)
  return parsed.success ? parsed.data : undefined
}
