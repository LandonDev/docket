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

/**
 * Which pages may open a socket on the public listener (routes/route.ts `originAllowed`): a browser
 * says where its page came from, and a page of any other origin is refused before a route sees it.
 */
export interface ServiceOrigins {
  /** this host's public origin and, once guest pages have their own, that one too */
  allowed: string[]
  /** the guest pages' own origin (`work.guests.origin`); null while they share the public one */
  guest: string | null
  /** an isolated instance, a proof or a test: a page on loopback passes, and so does a guest's socket that names no origin */
  loopback: boolean
}

/** Who serves LifeOS's documents: this host, or the one named (the box); null for none (an isolated instance). */
export type LifeosServer = { here: true } | { here: false; host: string | null }

export interface ServiceConfig {
  /** the public listener's port on 127.0.0.1; 0 for any free one */
  port: number
  /** the internal routes' Unix socket (0660) and the secret every call carries */
  socketPath: string
  secret: string
  /** the service's own folder: its journal, and what agents propose over a .tcsheet (sheets/suggestions, kept out of the file) */
  dataDir: string
  /** out/hosted, served at /w/hosted/ */
  hostedDir: string
  /** this host's environment id */
  host: string
  /** the owner's zone for times written to response sheets */
  zone?: string
  /** the owner's name as he set it (Settings → Work), when he has: his own connections' presence carries it, whatever their client says */
  owner?: string
  lifeos: LifeosServer & { url: string }
  /** every issuer whose tokens open a socket: public keys only (main signs; the key never reaches this process) */
  trusted: TrustedIssuer[]
  links: ServiceLink[]
  /**
   * Whether `links` is a list main settled: its last one, handed on when the service alone restarted. False after main
   * itself started, when it knows no links yet: until the first `links` message a guest's address answers 503
   * ("starting"), never 403 ("gone"), since a start is not an end (docs/agents/work-guests.md "A start is not an end").
   * The supervisor always says; left out (a test's own config), the list given is the list.
   */
  linksSettled?: boolean
  /** absent (a test's config): loopback pages pass and nothing else is named */
  origins?: ServiceOrigins
}

/** Main → service. */
export type ToService =
  | { t: 'config'; config: ServiceConfig }
  | { t: 'zone'; zone: string }
  | { t: 'links'; links: ServiceLink[] }
  /** one project link's projection; null takes it away */
  | { t: 'project'; linkId: string; project: ServiceProject | null }
  | { t: 'trusted'; trusted: TrustedIssuer[] }
  | { t: 'origins'; origins: ServiceOrigins }
  | { t: 'jwt'; id: number; jwt?: string; error?: string }
  | { t: 'guest-answer'; id: number; value?: unknown; error?: string }
  | { t: 'stop' }

/** A file-backed document's live revision. The first notice is from loading it. */
export type DocRevision = { doc: string; rev: string; loaded?: true }

/**
 * An op landed on a sheet the service holds, whoever wrote it (a guest's page, his phone's, main itself): the host's
 * key for the sheet (`lifeos:<id>` or `tcsheet:<path>`, sheets/host/host.ts `refKey`) and the revision it is at now.
 * Main tells his open canvases on that sheet, which then ask for what they miss.
 */
export type SheetCommit = { key: string; rev: number }

/**
 * Who is on a sheet the service holds, each time it changes: everyone with a selection on it, under the name and
 * hue the service gives (routes/sheetRooms.ts `SheetPerson`). Main tells his open desktop grid on that sheet, which
 * is on no socket of its own.
 */
export type SheetPresent = { key: string; people: { id: string; name: string; hue: number; sheet: string; range: { startRow: number; endRow: number; startColumn: number; endColumn: number } }[] }

/**
 * What the service asks main of a guest link whose item only main holds: a `.tcdoc`'s comments are rows in the
 * app's database (docs/threads.ts), which this process never opens. `body` is the comment as the service built it
 * from a guest's plain words. Main answers for that link's own file alone (guests/comments.ts).
 */
export type GuestAsk = { what: 'threads'; linkId: string } | { what: 'comment'; linkId: string; body: string; quote?: string; threadId?: string }

/** Service → main. */
export type FromService =
  /** `mark`: a random value this run of the service made at its start, what `/w/healthz` answers */
  | { t: 'ready'; port: number; mark?: string }
  | ({ t: 'doc-revision' } & DocRevision)
  | ({ t: 'sheet-commit' } & SheetCommit)
  | ({ t: 'sheet-presence' } & SheetPresent)
  /** answered with `guest-answer` of the same id */
  | { t: 'guest-ask'; id: number; ask: GuestAsk }
  | { t: 'jwt?'; id: number }
  | { t: 'log'; line: string }
  | { t: 'fault'; message: string }
  | { t: 'stopped' }
