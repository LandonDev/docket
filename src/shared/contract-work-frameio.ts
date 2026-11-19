import { z } from 'zod'
import type { MediaShape } from './contract-work-media'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The frameio pillar's wire (docs/agents/work-frameio.md). Its methods are
 * `work.frameio.<verb>` and its push `work.frameio`; src/shared/work/wire.ts
 * has the helpers and the rules.
 *
 * Frame.io V4 through an Adobe sign-in (PKCE, no client secret): a file
 * opens in the media canvas from Frame.io's own renditions with its comments
 * on their frames, an agent's comment or new version waits in the Outbox as
 * a held `frameio.post`, and Frame.io's webhooks fire routines.
 */

/** What this host knows of its Frame.io sign-in. `pending`: a sign-in was started and its answer has not come back. */
export interface FrameioStatus {
  signedIn: boolean
  user?: { id: string; name: string; email?: string }
  /** the Adobe Developer Console credential's client id (an OAuth Native App) */
  clientId?: string
  redirectUri: string
  /** where Frame.io can reach this host's webhook receiver; unset: no webhooks, so no routine fires on a comment */
  publicUrl?: string
  pending: boolean
  error?: string
}

/** One row of a Frame.io listing. A `stack` is a version stack; a `file` opens in the media canvas. */
export interface FrameioEntry {
  kind: 'account' | 'workspace' | 'project' | 'folder' | 'stack' | 'file'
  id: string
  account: string
  name: string
  mediaType?: string
}

/**
 * Exactly what a held `frameio.post` sends. `comment`: one comment on one
 * version (Frame.io's file), at a frame of TempCode's count (0 is the first
 * frame; the host shifts it to Frame.io's at the send) with its pin and its
 * marks in picture space; `height` is the picture's in pixels, which
 * Frame.io's mark sizes are counted in. `version`: a file on the host,
 * copied when it was held (`path`, under the host's data folder, so the
 * bytes that go are the bytes he saw named), uploaded and stacked on top
 * of `onto`; `from` is where it was.
 */
export type FrameioPost =
  | {
      what: 'comment'
      account: string
      fileId: string
      fileName: string
      text: string
      frame?: number
      durationFrames?: number
      /** `0:41`, for the words only */
      clock?: string
      pin?: { x: number; y: number }
      shapes?: MediaShape[]
      height?: number
      itemId?: string
      noteId?: string
    }
  | { what: 'version'; account: string; onto: string; ontoName: string; from: string; path: string; name: string; size: number; itemId?: string }

export const FrameioRequestSchemas = [
  /** → FrameioStatus */
  request('work.frameio.status', z.object({})),
  /** → { url }: the Adobe sign-in page to open in a browser; its answer comes back to `redirectUri` on this host, or through `finish` */
  request('work.frameio.signIn', z.object({ clientId: z.string().min(8).max(200), redirectUri: z.string().url().max(500).optional() })),
  /** → FrameioStatus: the address the browser ended on after the sign-in, pasted when that browser is on another machine */
  request('work.frameio.finish', z.object({ url: z.string().max(4000) })),
  /** → FrameioStatus */
  request('work.frameio.signOut', z.object({})),
  /** → FrameioStatus: the public https address the tunnel gives this host's webhook receiver, or null for none */
  request('work.frameio.setPublicUrl', z.object({ url: z.string().url().max(500).nullable() })),
  /** → { entries }: accounts with nothing named; else the children of one workspace, project, folder or version stack */
  request('work.frameio.browse', z.object({ account: z.string().optional(), kind: z.enum(['account', 'workspace', 'project', 'folder', 'stack']).optional(), id: z.string().optional() })),
  /** → CanvasItem: the file, with its version stack, in the thread's media canvas */
  request('work.frameio.open', z.object({ sessionId: z.string(), account: z.string(), fileId: z.string() }))
] as const

/** The sign-in changed. */
export type FrameioPush = { push: 'work.frameio'; status: FrameioStatus }

export const FRAMEIO_CAPS = {
  'work.frameio.status': 'read',
  'work.frameio.signIn': 'admin',
  'work.frameio.finish': 'admin',
  'work.frameio.signOut': 'admin',
  'work.frameio.setPublicUrl': 'admin',
  'work.frameio.browse': 'read',
  'work.frameio.open': 'operate'
} satisfies CapsOf<typeof FrameioRequestSchemas>
export const FRAMEIO_RELAY = {} satisfies RelayOf<typeof FrameioRequestSchemas>
