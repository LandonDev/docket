import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ServerFrame } from '@shared/contract'
import type { CodeChunk } from '@shared/contract-code'
import { CODE_AVAILABLE_PUSH, CODE_CHUNK_BYTES, CODE_MAX_BYTES } from '@shared/codeUpdate'

/**
 * The host's side of a code-only update (docs/agents/code-only-updates.md):
 * the newest pack of a green commit's `out/`, made by scripts/code-pack.ts
 * right after the release train tagged it. The script says where the pack
 * lies (`code.announce`, the loopback socket only); this host tells every
 * registered Mac (`code-available` down its link) and answers each Mac's
 * `code.latest` and `code.chunk` over the link the Mac dialed and holds an
 * admin key for. The manifest is passed on as it was written: the Mac's own
 * boot code is its judge (src/main/codeChoice.ts), not this host.
 *
 * Only the newest pack is kept in mind; its folder is remembered in one
 * settings row, so a Mac that links after a restart of this host still gets
 * the offer.
 */

export const CODE_OFFER_SETTING = 'code-offer'
export const PACK_MANIFEST = 'code-manifest.json'
export const PACK_TARBALL = 'code.tar.gz'

/** What the push carries: enough to name the offer, never enough to trust it. */
export interface CodeOfferHead {
  commit: string
  release: number
  subject: string
  bytes: number
}

export interface CodeOfferDeps {
  environmentId: string
  /** One frame down every registered peer's socket (PeerCalls.notify). */
  notify?: (frame: ServerFrame) => void
  getSetting: (key: string) => string | null
  setSetting: (key: string, value: string) => void
  log?: (line: string) => void
}

/** The head of a manifest as a host reads it, or null: the shape the pack script writes. */
export function offerHead(raw: unknown): CodeOfferHead | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as { commit?: unknown; release?: unknown; subject?: unknown; tar?: { bytes?: unknown } }
  if (typeof m.commit !== 'string' || !/^[0-9a-f]{40}$/.test(m.commit)) return null
  if (typeof m.release !== 'number' || !Number.isInteger(m.release) || m.release < 1) return null
  const bytes = m.tar?.bytes
  if (typeof bytes !== 'number' || !(bytes > 0) || bytes > CODE_MAX_BYTES) return null
  return { commit: m.commit, release: m.release, subject: typeof m.subject === 'string' ? m.subject : '', bytes }
}

export class CodeOffers {
  constructor(private readonly deps: CodeOfferDeps) {}

  /** The pack in the remembered folder as it is on disk now, or null. */
  private pack(): { dir: string; manifest: unknown; head: CodeOfferHead } | null {
    const dir = this.deps.getSetting(CODE_OFFER_SETTING)
    return dir ? this.read(dir) : null
  }

  private read(dir: string): { dir: string; manifest: unknown; head: CodeOfferHead } | null {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, PACK_MANIFEST), 'utf8')) as unknown
      const head = offerHead(manifest)
      if (!head || statSync(join(dir, PACK_TARBALL)).size !== head.bytes) return null
      return { dir, manifest, head }
    } catch {
      return null
    }
  }

  /** `code.announce`: a new pack lies in `dir`. Remember it and tell every Mac. */
  announce(dir: string): CodeOfferHead {
    const pack = this.read(resolve(dir))
    if (!pack) throw new Error(`no code pack in ${dir}: it needs ${PACK_MANIFEST} and a ${PACK_TARBALL} of the size it names`)
    this.deps.setSetting(CODE_OFFER_SETTING, pack.dir)
    this.deps.notify?.({ push: CODE_AVAILABLE_PUSH, from: this.deps.environmentId, commit: pack.head.commit, release: pack.head.release, subject: pack.head.subject })
    this.deps.log?.(`[code] ${pack.head.commit.slice(0, 7)} (1.0.${pack.head.release}, ${pack.head.bytes} bytes) offered`)
    return pack.head
  }

  /** `code.latest`: the newest pack's manifest as written, or null. */
  latest(): unknown {
    return this.pack()?.manifest ?? null
  }

  /** `code.chunk`: bytes of that commit's packed tree from `offset`. A commit that is no longer the newest is gone. */
  chunk(commit: string, offset: number, length: number): CodeChunk {
    const pack = this.pack()
    if (!pack || pack.head.commit !== commit) throw new Error(`code ${commit.slice(0, 7)} is gone: a newer pack took its place`)
    if (offset > pack.head.bytes) throw new Error('offset past the end')
    const want = Math.min(length, CODE_CHUNK_BYTES, pack.head.bytes - offset)
    const buffer = Buffer.alloc(want)
    const fd = openSync(join(pack.dir, PACK_TARBALL), 'r')
    let bytes = 0
    try {
      while (bytes < want) {
        const n = readSync(fd, buffer, bytes, want - bytes, offset + bytes)
        if (n === 0) break
        bytes += n
      }
    } finally {
      closeSync(fd)
    }
    if (bytes !== want) throw new Error('the pack changed while it was read')
    return { data: buffer.toString('base64'), bytes, done: offset + bytes >= pack.head.bytes }
  }
}
