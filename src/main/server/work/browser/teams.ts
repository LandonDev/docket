import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ActKindDef } from '../modules'
import { ActStale } from '../outbox/kinds'

/**
 * A Teams reply (docs/agents/work-browser.md "Teams"). TempCode reads no
 * Teams; a thread that should answer there holds a `teams.post` with the
 * chat and the text. On the owner's press the host posts it by computer use
 * on this Mac and keeps a picture of the posted message, which Sent shows.
 *
 * The posting itself is the carrier's: the steps on Teams (bring it
 * forward, find the chat, type, Return) run through the thread's computer
 * session as the owner's press, so the computer hold does not hold them a
 * second time. index.ts sets it once at boot on a host that has computer
 * use; with none set, nothing here can post, and `teams_reply` refuses
 * before anything is held. A box thread's reply is refused the same way:
 * the box has no Teams to post with.
 */

export const TeamsPostSchema = z.object({
  /** the chat, channel or person as Teams lists it */
  chat: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(8000)
})
export type TeamsPost = z.infer<typeof TeamsPostSchema>

export interface PostedPicture {
  data: Uint8Array
  mimeType: string
  width: number
  height: number
}

/**
 * Posts one held reply. Throw `ActStale` when nothing was posted (Teams is
 * not signed in, the chat is not there): the item reads stale and he is
 * told nothing went. Any other throw reads failed, "may or may not have gone".
 */
export interface TeamsCarrier {
  post(p: TeamsPost, o: { sessionId: string | null }): Promise<{ picture: PostedPicture | null }>
}

let carrier: TeamsCarrier | null = null
/** Set once at boot where computer use runs (a Mac); null takes it back. */
export function configureTeamsCarrier(next: TeamsCarrier | null): void {
  carrier = next
}
export const teamsCarrier = (): TeamsCarrier | null => carrier

export const TEAMS_UNAVAILABLE =
  'refused: this host cannot post to Teams. A reply goes out by computer use on a Mac with Teams signed in, and a thread on another host cannot hold one for it. Give him the text in your reply instead.'
export const TEAMS_GONE = 'This host can no longer post to Teams. Nothing was posted.'

const clip = (text: string, n: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > n ? `${line.slice(0, n - 1).trimEnd()}…` : line
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

/** Where the picture of a posted reply is kept: under the pillar's own folder, by the held row. */
export const postedPicturePath = (dataDir: string, rowId: string, mimeType: string): string => join(dataDir, 'work-browser', 'teams', `${rowId}.${EXT[mimeType] ?? 'img'}`)

export const teamsPostKind: ActKindDef<TeamsPost, never> = {
  kind: 'teams.post',
  store: 'host',
  payload: TeamsPostSchema,
  // No matcher: a Teams reply takes no grant, so every one waits for his press.
  words: (p) => ({ summary: `Post in Teams to ${p.chat}: “${clip(p.text, 60)}”`, verb: 'Post' }),
  async execute(p, act) {
    const post = carrier
    if (!post) throw new ActStale(TEAMS_GONE)
    const { picture } = await post.post(p, { sessionId: act.item.sessionId })
    const rowId = act.item.ref.at === 'host' ? act.item.ref.id : String(act.item.createdAt)
    let kept: { path: string; mimeType: string; width: number; height: number } | null = null
    if (picture) {
      const path = postedPicturePath(act.dataDir, rowId, picture.mimeType)
      try {
        mkdirSync(join(act.dataDir, 'work-browser', 'teams'), { recursive: true })
        writeFileSync(path, picture.data)
        kept = { path, mimeType: picture.mimeType, width: picture.width, height: picture.height }
      } catch (err) {
        // The reply went; only its picture could not be kept.
        act.log(`browser: the picture of a posted Teams reply was not kept: ${String(err)}`)
      }
    }
    return { summary: `Posted in Teams to ${p.chat}`, ref: { chat: p.chat, picture: kept } }
  },
  wayBack: () => null
}
