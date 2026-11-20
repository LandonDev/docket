import type { TrustedIssuer } from 'work-kit/collab-server'
import type { GuestProjection } from '@shared/work/guestProjection'

/**
 * The wire between main and the Work service's utility process
 * (docs/agents/work-service.md). The service opens neither the app's
 * database nor the vault: everything it needs comes this way, at start and
 * on every change (architecture §8.1).
 */

/** A guest link as the service checks it (rows are main's; milestone 31 makes them). */
export interface ServiceLink {
  linkId: string
  item: { doc: string } | { sheet: string } | { project: string }
  role: 'view' | 'comment' | 'edit'
  expiresAt: number
  revokedAt: number | null
}

/**
 * What a project's link shows, sent in a message of its own (never inside `links`, which goes whole
 * on every change): the projection as main last read it, and a view token main signed for each
 * sheet it lists (`sheets:<id>`), for this link and that sheet alone. A document has none: the
 * service hands its text as it stands.
 */
export interface ServiceProject {
  projection: GuestProjection
  tokens: Record<string, { token: string; exp: number }>
}

/** Who serves LifeOS's documents: this host, or the one named (the box); null for none (an isolated instance). */
export type LifeosServer = { here: true } | { here: false; host: string | null }

export interface ServiceConfig {
  /** the public listener's port on 127.0.0.1; 0 for any free one */
  port: number
  /** the internal routes' Unix socket (0660) and the secret every call carries */
  socketPath: string
  secret: string
  /** the service's own folder: its journal and nothing else */
  dataDir: string
  /** out/hosted, served at /w/hosted/ */
  hostedDir: string
  /** this host's environment id */
  host: string
  lifeos: LifeosServer & { url: string }
  /** every issuer whose tokens open a socket: public keys only (main signs; the key never reaches this process) */
  trusted: TrustedIssuer[]
  links: ServiceLink[]
}

/** Main → service. */
export type ToService =
  | { t: 'config'; config: ServiceConfig }
  | { t: 'links'; links: ServiceLink[] }
  /** one project link's projection; null takes it away */
  | { t: 'project'; linkId: string; project: ServiceProject | null }
  | { t: 'trusted'; trusted: TrustedIssuer[] }
  | { t: 'jwt'; id: number; jwt?: string; error?: string }
  | { t: 'stop' }

/** Service → main. */
export type FromService =
  | { t: 'ready'; port: number }
  | { t: 'jwt?'; id: number }
  | { t: 'log'; line: string }
  | { t: 'fault'; message: string }
  | { t: 'stopped' }
