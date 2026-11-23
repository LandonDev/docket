/**
 * Code-only updates, the parts every side shares
 * (docs/agents/code-only-updates.md): the push a host sends when it has
 * packed a green commit's `out/`, the Mac's decision on an offer, and the
 * words the app shows. The rules of what boot may run live with the boot
 * code (src/main/codeChoice.ts), which this file never imports.
 */

/** A host packed a commit's code: down every registered peer's link (codeOffer.ts). */
export const CODE_AVAILABLE_PUSH = 'code-available'

/** The setting on a Mac: the one host it takes code-only updates from (a saved environment's id),
 *  or `off`. Absent, the Mac's only admin host is taken and written here at first use; with several,
 *  none is until the owner picks one. A host saved later is never taken on its own. */
export const CODE_UPDATES_SETTING = 'code-updates'
export const CODE_UPDATES_OFF = 'off'

/** One `code.chunk` answer carries at most this many bytes of the packed tree. */
export const CODE_CHUNK_BYTES = 2 * 1024 * 1024

/** The packed tree's largest size a Mac will fetch: four times today's 36 MB. */
export const CODE_MAX_BYTES = 160 * 1024 * 1024

/** The largest tree a pack may unpack to: seven times today's 139 MB. */
export const CODE_MAX_UNPACKED_BYTES = 1024 * 1024 * 1024

export interface CodeHost {
  id: string
  name: string
}

/**
 * The host this Mac takes code from. `pin` is the id to write as the setting when the choice was
 * made here: the only admin host, taken once. A host named by the setting that is no longer saved
 * with admin is no host.
 */
export function chosenHost(setting: string | null | undefined, adminHosts: readonly CodeHost[]): { host: string | null; pin?: string } {
  if (setting === CODE_UPDATES_OFF) return { host: null }
  if (setting) return { host: adminHosts.some((h) => h.id === setting) ? setting : null }
  return adminHosts.length === 1 ? { host: adminHosts[0].id, pin: adminHosts[0].id } : { host: null }
}

/** Code crosses only a link no one on the network can read or answer for: TLS, or this machine itself. */
export function routeIsSecure(url: string | null | undefined): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    if (u.protocol === 'wss:') return true
    return u.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname.toLowerCase())
  } catch {
    return false
  }
}

/** "Code updates need an encrypted link to The box." */
export function insecureLine(hostName: string): string {
  return `Code updates need an encrypted link to ${hostName}.`
}

/** What the update status carries about code-only updates (update.ts `UpdateStatus.code`). */
export interface CodeUpdateStatus {
  /** The staged code this app runs over its bundle. */
  running?: { commit: string; release: number; subject: string }
  /** An update on its way from a host, or staged and waiting for the restart. */
  offer?: { commit: string; release: number; subject: string; phase: 'downloading' | 'ready'; percent?: number }
  /** One plain line: a tree that did not start (said once), or why the last offer was refused. */
  notice?: string
}

export interface OfferFacts {
  /** The offering host is the one the setting names (chosenHost), saved with a key that holds admin. */
  chosen: boolean
  /** boot's word on the manifest (CodeBoot.refusal): null when it would run it. */
  refusal: string | null
  commit: string
  release: number
  /** The staged code this app runs, the one waiting for a restart, and the last that did not start. */
  running: { commit: string; release: number } | null
  staged: { commit: string; release: number } | null
  failed: string | null
}

export type OfferDecision =
  /** fetch it, stage it, offer the restart */
  | { kind: 'take' }
  /** nothing to do and nothing to say: another host, already here, or older than what runs */
  | { kind: 'skip'; why: string }
  /** not taken, with the line the app shows */
  | { kind: 'refuse'; line: string }

/** What a Mac does with a host's offer. Who may offer comes first, before anything of the offer is read. */
export function decideOffer(f: OfferFacts): OfferDecision {
  if (!f.chosen) return { kind: 'skip', why: 'not the host this Mac takes code from' }
  if (f.running?.commit === f.commit) return { kind: 'skip', why: 'this code is running' }
  if (f.staged?.commit === f.commit) return { kind: 'skip', why: 'this code is staged' }
  if (f.running && f.release <= f.running.release) return { kind: 'skip', why: 'older than the code running' }
  if (f.staged && f.release < f.staged.release) return { kind: 'skip', why: 'older than the code staged' }
  if (f.refusal) return /already$/.test(f.refusal) ? { kind: 'skip', why: f.refusal } : { kind: 'refuse', line: f.refusal }
  if (f.failed === f.commit) return { kind: 'refuse', line: 'this code did not start here' }
  return { kind: 'take' }
}

/** A commit's subject cut to one short line: its first sentence, else its first words. */
export function shortSubject(subject: string, max = 72): string {
  const line = subject.split('\n')[0].trim()
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line
  const text = sentence.replace(/[.]$/, '')
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const at = cut.lastIndexOf(' ')
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:]+$/, '')}…`
}

/** The version as the app says it: the bundle's alone, or with the commit of the staged code it runs. */
export function versionLine(bundleVersion: string, stagedCommit?: string | null): string {
  return stagedCommit ? `${bundleVersion} + ${stagedCommit.slice(0, 7)}` : bundleVersion
}

/** "Code update 3f9c2ab did not start. Running 1.0.371." */
export function fellBackLine(commit: string, bundleVersion: string): string {
  return `Code update ${commit.slice(0, 7)} did not start. Running ${bundleVersion}.`
}

/** "Code update 3f9c2ab needs a full release: node_modules changed." */
export function refusedLine(commit: string, line: string): string {
  const short = commit.slice(0, 7)
  return line.startsWith('needs ') ? `Code update ${short} ${line}.` : `Code update ${short} was not taken: ${line}.`
}
