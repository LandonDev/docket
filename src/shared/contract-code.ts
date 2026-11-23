import { z } from 'zod'
import { CODE_CHUNK_BYTES } from './codeUpdate'

// Code-only updates (docs/agents/code-only-updates.md): a host that packed a
// green commit's `out/` answers its Macs for the manifest and the bytes over
// the link each Mac holds (src/main/server/codeOffer.ts); the Mac checks,
// stages and offers the restart (src/main/server/codeUpdates.ts).

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

const Commit = z.string().regex(/^[0-9a-f]{40}$/)

/** `code.chunk`'s answer: the bytes from `offset`, base64; `done` at the last. */
export interface CodeChunk {
  data: string
  bytes: number
  done: boolean
}

/** `code.settings.get` and `.set`: the host this Mac takes code from, the hosts it could, and whether this build can take code at all. */
export interface CodeSettings {
  /** The chosen host's environment id, or null: off, or none picked among several. */
  host: string | null
  /** The saved environments whose key holds admin. */
  hosts: { id: string; name: string }[]
  /** Null when it can, else the plain reason (a dev build, no base stamp). */
  cannot: string | null
}

export const CodeRequestSchemas = [
  /** The pack script's word that `dir` holds a new pack (scripts/code-pack.ts through tc-local): → the manifest's head. */
  request('code.announce', z.object({ dir: z.string().min(1) })),
  /** → the newest pack's manifest, or null. */
  request('code.latest', z.object({}).optional()),
  /** → CodeChunk of that commit's packed tree. */
  request('code.chunk', z.object({ commit: Commit, offset: z.number().int().min(0), length: z.number().int().min(1).max(CODE_CHUNK_BYTES) })),
  /** → CodeSettings. */
  request('code.settings.get', z.object({}).optional()),
  /** → CodeSettings. */
  request('code.settings.set', z.object({ host: z.string().min(1).max(200).nullable() }))
] as const
