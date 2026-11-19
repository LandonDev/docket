import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { z } from 'zod'
import { clock, frameStart, MediaRegionSchema, type MediaShape } from '@shared/contract-work-media'
import type { FrameioEntry, FrameioPost } from '@shared/contract-work-frameio'
import { workText, type WorkToolResult } from '@shared/work'
import { frameOf } from '../media/tools'
import { agentWrite, liveOf as mediaOf, mediaItem, preparerOf } from '../media/view'
import type { ToolCtx, WorkCtx, WorkTool } from '../modules'
import { frameioConfig } from './auth'
import { frameioItem, frameioOf } from './live'
import { openFile, syncComments } from './media'
import { postWords } from './post'

/**
 * The agent's Frame.io tools (docs/agents/work-frameio.md, "Tools"): look
 * through accounts, workspaces, projects and folders; open a file in the
 * media canvas; and hold a comment at a frame or a new version for the
 * person's press. Nothing an agent does here reaches Frame.io unheld.
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** One level of Frame.io: accounts with nothing named, else what is inside the one named. */
export async function browse(ctx: WorkCtx, o: { account?: string; kind?: FrameioEntry['kind']; id?: string }): Promise<FrameioEntry[]> {
  const { api } = frameioOf(ctx)
  if (!o.account) return (await api.accounts()).map((a) => ({ kind: 'account', id: a.id, account: a.id, name: a.display_name ?? a.name ?? a.id }))
  const a = o.account
  if (!o.kind || o.kind === 'account') return (await api.workspaces(a)).map((w) => ({ kind: 'workspace', id: w.id, account: a, name: w.name }))
  if (!o.id) throw new Error(`name the ${o.kind} to look in`)
  if (o.kind === 'workspace') return (await api.projects(a, o.id)).map((p) => ({ kind: 'project', id: p.root_folder_id, account: a, name: p.name }))
  if (o.kind === 'stack') return (await api.stackChildren(a, o.id)).map((f) => ({ kind: 'file', id: f.id, account: a, name: f.name, ...(f.media_type ? { mediaType: f.media_type } : {}) }))
  // A project's entry carries its root folder's id, so a project and a folder are looked in alike.
  return (await api.children(a, o.id)).map((c) => ({ kind: c.type === 'version_stack' ? 'stack' : c.type, id: c.id, account: a, name: c.name, ...(c.media_type ? { mediaType: c.media_type } : {}) }))
}

const signedIn = (): void => {
  if (!frameioConfig.tokens.read()) throw new Error('Frame.io is not signed in on this host. The person signs in from Settings, Work.')
}

/** The thread's own Frame.io item. */
function ownItem(ctx: ToolCtx, id: string): { itemId: string; account: string } {
  const item = mediaItem(ctx, id)
  if (item.sessionId !== ctx.canvas.paneOf(ctx.sessionId)) throw new Error(`this thread has no media item ${id}`)
  const row = frameioItem(ctx.db, item.id)
  if (!row) throw new Error(`${item.title} is not from Frame.io`)
  return { itemId: item.id, account: row.account }
}

const itemInput = z.string().describe('the media item id, as frameio_open answered it')
const versionInput = z.number().int().positive().optional().describe('the version number (1 for v1); the newest when left out')
const momentInput = z.union([z.number().int().nonnegative(), z.string().min(1).max(40)])

/** Holds a post and says so. */
function hold(ctx: ToolCtx, payload: FrameioPost): WorkToolResult {
  const item = ctx.held.create({ kind: 'frameio.post', sessionId: ctx.sessionId, payload })
  const { summary } = postWords(payload)
  return workText(item.state === 'sent' ? `Sent: ${summary}.` : `Held: ${summary}. It waits in the Outbox for the person to post it; nothing went to Frame.io.`)
}

export const frameioTools: WorkTool[] = [
  {
    name: 'frameio_browse',
    description:
      "Looks through the person's Frame.io: with nothing named, his accounts; with `account`, its workspaces; with `kind` and `id`, what is inside a workspace (its projects), a project or folder (folders, version stacks, files) or a version stack (its versions, newest first).",
    input: z.object({ account: z.string().optional(), kind: z.enum(['workspace', 'project', 'folder', 'stack']).optional(), id: z.string().optional() }),
    readOnly: true,
    run: async (args, ctx) => {
      try {
        signedIn()
        const rows = await browse(ctx, args as { account?: string; kind?: FrameioEntry['kind']; id?: string })
        if (!rows.length) return workText('Nothing there.')
        return workText(rows.map((r) => `- ${r.kind} “${r.name}” id ${r.id}${r.kind === 'account' ? '' : ` (account ${r.account})`}${r.mediaType ? `, ${r.mediaType}` : ''}`).join('\n'))
      } catch (err) {
        return fail(message(err))
      }
    }
  },
  {
    name: 'frameio_open',
    description: "Opens a Frame.io file in this thread's canvas as a media item, with every version in its stack and Frame.io's comments on their frames. Read it afterwards with media_info and media_frames.",
    input: z.object({ account: z.string(), file: z.string().describe('the file id, from frameio_browse') }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { account: string; file: string }
      try {
        signedIn()
        const item = await openFile(ctx, ctx.sessionId, a.account, a.file)
        const { store } = mediaOf(ctx)
        const notes = store.notes(item.id).filter((n) => n.external?.service === 'frameio' && !n.parentId).length
        return workText(`Opened ${item.title} as media item ${item.id}: ${store.versions(item.id).length} version(s), ${notes} Frame.io comment(s). Others review it, so your notes wait for the person.`)
      } catch (err) {
        return fail(message(err))
      }
    }
  },
  {
    name: 'frameio_comment',
    description:
      'Holds a comment for a Frame.io item at a moment (a frame number, `0:41`, or a timecode), over a stretch (`until`), and on a region of the picture (0 to 1 from its top left). Or pass `note` to post one of your waiting notes on the item. It shows on the item as waiting and posts to Frame.io only when the person presses Post in the Outbox. Frame.io cannot take a reply to a comment.',
    input: z.object({ item: itemInput, version: versionInput, note: z.string().optional(), text: z.string().min(1).max(40_000).optional(), at: momentInput.optional(), until: momentInput.optional(), region: MediaRegionSchema.optional() }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item: string; version?: number; note?: string; text?: string; at?: string | number; until?: string | number; region?: { x: number; y: number; w: number; h: number } }
      try {
        signedIn()
        const { itemId, account } = ownItem(ctx, a.item)
        const { store } = mediaOf(ctx)
        const p = await preparerOf(ctx)
        let noteId = a.note
        if (!noteId) {
          if (!a.text) throw new Error('write the comment in `text`, or name a waiting note')
          const rows = store.versions(itemId)
          const row = a.version === undefined ? rows[rows.length - 1] : rows.find((v) => v.n === a.version)
          if (!row) throw new Error(a.version === undefined ? 'the item has no version yet' : `there is no v${a.version}`)
          await p.ready(row, ctx.signal)
          const table = p.table(row.id)
          const probe = row.source.at === 'frameio' ? frameioOf(ctx).probes.get(row.source.fileId) : undefined
          if (table && a.at === undefined) throw new Error('a comment on a video needs `at`')
          const frame = table && a.at !== undefined ? frameOf(table, a.at, probe?.timecode, probe?.rate) : undefined
          const end = table && a.until !== undefined ? frameOf(table, a.until, probe?.timecode, probe?.rate) : undefined
          const anchor = { versionId: row.id, ...(frame !== undefined ? { frame } : {}), ...(frame !== undefined && end !== undefined && end > frame ? { durationFrames: end - frame + 1 } : {}), ...(a.region ? { region: a.region } : {}) }
          noteId = agentWrite(ctx, itemId, ctx.sessionId, [{ anchor, body: a.text }], 'Added a comment').notes[0].id
        }
        const note = store.note(noteId)
        if (!note || note.itemId !== itemId) throw new Error(`there is no note ${noteId} on this item`)
        if (note.external) throw new Error('that note is already in Frame.io')
        const v = store.version(note.anchor.versionId)
        if (v?.source.at !== 'frameio') throw new Error('that note is on a version that is not in Frame.io')
        const table = p.table(v.id)
        const height = frameioOf(ctx).probes.get(v.source.fileId)?.height
        const r = note.anchor.region
        const shapes: MediaShape[] = [...(note.anchor.shapes ?? []), ...(r ? [{ tool: 'rect' as const, color: '#F22237', width: 0.004, x: r.x, y: r.y, w: r.w, h: r.h }] : [])]
        const frame = note.anchor.frame
        return hold(ctx, {
          what: 'comment',
          account,
          fileId: v.source.fileId,
          fileName: v.name,
          text: note.body,
          ...(frame !== undefined ? { frame } : {}),
          ...(note.anchor.durationFrames ? { durationFrames: note.anchor.durationFrames } : {}),
          ...(frame !== undefined && table ? { clock: clock(frameStart(table, frame) - frameStart(table, 0)) } : {}),
          ...(note.anchor.pin ? { pin: note.anchor.pin } : {}),
          ...(shapes.length ? { shapes } : {}),
          ...(height ? { height } : {}),
          itemId,
          noteId
        })
      } catch (err) {
        return fail(message(err))
      }
    }
  },
  {
    name: 'frameio_add_version',
    description: "Holds a file on this host as the next version of a Frame.io item's stack. It uploads only when the person presses Upload in the Outbox.",
    input: z.object({ item: itemInput, file: z.string().min(1).max(4096).describe('the absolute path of the new version on this host') }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item: string; file: string }
      try {
        signedIn()
        const { itemId, account } = ownItem(ctx, a.item)
        if (!isAbsolute(a.file) || !existsSync(a.file) || !statSync(a.file).isFile()) throw new Error(`there is no file at ${a.file}`)
        const versions = mediaOf(ctx).store.versions(itemId).filter((v) => v.source.at === 'frameio')
        const top = versions[versions.length - 1]
        if (!top || top.source.at !== 'frameio') throw new Error('the item has no Frame.io version to stack onto')
        return hold(ctx, { what: 'version', account, onto: top.source.fileId, ontoName: top.name, path: a.file, name: basename(a.file), size: statSync(a.file).size, itemId })
      } catch (err) {
        return fail(message(err))
      }
    }
  },
  {
    name: 'frameio_refresh',
    description: "Reads a Frame.io item's comments again, for when the person says someone commented.",
    input: z.object({ item: itemInput }),
    readOnly: true,
    run: async (args, ctx) => {
      try {
        signedIn()
        const { itemId } = ownItem(ctx, (args as { item: string }).item)
        const changed = await syncComments(ctx, itemId, ctx.signal)
        return workText(changed ? `${changed} note(s) changed.` : 'Nothing new.')
      } catch (err) {
        return fail(message(err))
      }
    }
  }
]
