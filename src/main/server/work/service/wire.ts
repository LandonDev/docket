import type { TrustedIssuer } from 'work-kit/collab-server'

/**
 * The wire between main and the Work service's utility process
 * (docs/agents/work-service.md). The service opens neither the app's
 * database nor the vault: everything it needs comes this way, at start and
 * on every change (architecture §8.1).
 */

/** A guest link as the service checks it (rows are main's; milestone 31 makes them). */
export interface ServiceLink {
  linkId: string
  item: { doc: string } | { sheet: string }
  role: 'view' | 'comment' | 'edit'
  expiresAt: number
  revokedAt: number | null
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
