import { existsSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  clock,
  frameAt,
  frameCount,
  frameStart,
  frameTimecode,
  MediaRegionSchema,
  tableFps,
  timecodeFrames,
  type FrameTable,
  type MediaNote,
  type MediaVersion,
  type MediaView
} from '@shared/contract-work-media'
import { workText, type WorkToolResult } from '@shared/work'
import type { ToolCtx, WorkTool } from '../modules'
import { agentWrite, liveOf, mediaItem, preparerOf, viewOf } from './view'

/**
 * The agent's media tools (docs/agents/work-media.md, "Tools"). An agent
 * reads an item, looks at its frames, notes a frame, a stretch or a region,
 * adds chapters, and adds a version. It names a moment by frame number or
 * by time (`0:41`, `1:02:05.5`, or a timecode `00:00:41:12`), and the host
 * keys every note to a frame. Its notes land by the item's mode: straight on
 * with an Undo on his own file, or waiting for him in Suggests and on a
 * shared item.
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The thread's own media item: a subagent's items are its root thread's, as the canvas tools have it. */
function ownItem(ctx: ToolCtx, id: string): string {
  const item = mediaItem(ctx, id)
  if (item.sessionId !== ctx.canvas.paneOf(ctx.sessionId)) throw new Error(`this thread has no media item ${id}`)
  return item.id
}

/** The version a call means: the one named, else the newest. */
function versionOf(view: MediaView, n?: number): MediaVersion {
  const v = n === undefined ? view.versions[view.versions.length - 1] : view.versions.find((x) => x.n === n)
  if (!v) throw new Error(n === undefined ? 'the item has no version yet' : `there is no v${n}`)
  return v
}

/** A moment as the agent names it → a frame of the table. */
export function frameOf(table: FrameTable, at: string | number, timecode?: string, rate?: { num: number; den: number }): number {
  if (typeof at === 'number') return Math.max(0, Math.min(frameCount(table) - 1, Math.round(at)))
  const s = at.trim()
  // A timecode has four fields, its frames after `:` or `;`; `0:00:41.50` is seconds.
  if (/^\d{1,2}:\d{2}:\d{2}[:;]\d{2,3}$/.test(s) && rate) {
    const n = timecodeFrames(s, rate)
    const base = timecode ? (timecodeFrames(timecode, rate) ?? 0) : 0
    if (n === null) throw new Error(`${at} is not a timecode`)
    return Math.max(0, Math.min(frameCount(table) - 1, n - base))
  }
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/.exec(s) ?? /^()()(\d+(?:\.\d+)?)s?$/.exec(s)
  if (!m) throw new Error(`${at} is not a time: write 0:41, 1:02:05.5 or a timecode`)
  const seconds = Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3])
  return frameAt(table, frameStart(table, 0) + seconds)
}

/** `frame 984, 0:41 (00:00:41:00)` */
function momentOf(v: MediaVersion, frame: number | undefined, table: FrameTable | undefined): string {
  if (frame === undefined || !table) return 'the picture'
  const t = frameStart(table, frame) - frameStart(table, 0)
  return v.probe?.rate ? `frame ${frame}, ${clock(t)} (${frameTimecode(frame, v.probe.rate, v.probe.timecode)})` : `frame ${frame}, ${clock(t)}`
}

const WHO = (by: MediaNote['by']): string => (by === 'owner' ? 'the person' : by.startsWith('agent:') ? 'an agent' : (by.split(':')[1] ?? by))

async function infoText(ctx: ToolCtx, itemId: string): Promise<string> {
  const view = await viewOf(ctx, itemId)
  const preparer = await preparerOf(ctx)
  const lines: string[] = []
  for (const v of view.versions) {
    const p = v.probe
    const facts = p
      ? p.kind === 'video'
        ? [`${p.codec} ${p.width}×${p.height}`, p.durationS ? clock(p.durationS) : null, p.rate ? `${(p.rate.num / p.rate.den).toFixed(3).replace(/\.?0+$/, '')} fps` : null, p.frames ? `${p.frames} frames (0 to ${p.frames - 1})` : null, p.vfr ? 'variable rate' : null, p.timecode ? `starts at ${p.timecode}` : null]
        : [`${p.codec} ${p.width}×${p.height}`]
      : []
    const shown = v.state === 'ready' || v.state === 'preparing' ? (v.plays.some((x) => x.via === 'proxy' || x.via === 'hls') ? 'a proxy is made for viewers that cannot decode it' : v.plays.some((x) => x.via === 'image' && x.converted) ? 'converted to JPEG for viewers' : 'shown as it is') : v.state
    lines.push(`v${v.n} ${v.name}: ${[...facts.filter(Boolean), shown].join(', ')}${v.error ? `. Failed: ${v.error}` : ''}`)
  }
  const notes = view.notes.filter((n) => !n.parentId)
  const noteLines = notes.map((n) => {
    const v = view.versions.find((x) => x.id === n.anchor.versionId)
    const where = v ? `v${v.n} ${momentOf(v, n.anchor.frame, preparer.table(v.id))}${n.anchor.durationFrames ? ` for ${n.anchor.durationFrames} frames` : ''}${n.anchor.region ? ', a region' : ''}` : 'a version that is gone'
    return `- ${n.kind === 'chapter' ? 'Chapter' : 'Note'} ${n.id} at ${where}, by ${WHO(n.by)}${n.state === 'suggested' ? ', waiting for the person' : ''}${n.resolved ? ', resolved' : ''}: ${n.body}`
  })
  const mode = view.shared ? 'Others review this item, so your notes wait for the person.' : view.mode === 'suggests' ? 'The person set Suggests: your notes wait for him.' : 'Your notes go straight onto it; the person can undo them.'
  return [...lines, notes.length ? `Notes:\n${noteLines.join('\n')}` : 'No notes yet.', mode].join('\n')
}

/** The version a call names (the newest when it names none), once the host has read it. */
async function readVersion(ctx: ToolCtx, id: string, n?: number) {
  const p = await preparerOf(ctx)
  const rows = liveOf(ctx).store.versions(id)
  const row = n === undefined ? rows[rows.length - 1] : rows.find((v) => v.n === n)
  if (!row) throw new Error(n === undefined ? 'the item has no version yet' : `there is no v${n}`)
  // Only the probe: a proxy being made for a viewer is no reason to keep the agent waiting.
  await p.ready(row, ctx.signal)
  const v = versionOf(await viewOf(ctx, id), row.n)
  return { p, row, v, table: p.table(row.id) }
}

const momentInput = z.union([z.number().int().nonnegative(), z.string().min(1).max(40)])
const itemInput = z.string().describe('the media item id, as canvas_open answered it')
const versionInput = z.number().int().positive().optional().describe('the version number (1 for v1); the newest when left out')

export const mediaTools: WorkTool[] = [
  {
    name: 'media_info',
    description: "Reads an image or video item in this thread's canvas: each version's facts (codec, size, length, rate, frame count, start timecode), and every note and chapter with its frame and time.",
    input: z.object({ item: itemInput }),
    readOnly: true,
    run: async (args, ctx) => {
      try {
        const id = ownItem(ctx, (args as { item: string }).item)
        const p = await preparerOf(ctx)
        for (const v of liveOf(ctx).store.versions(id)) await p.ready(v, ctx.signal).catch((err: unknown) => (ctx.signal.aborted ? Promise.reject(err) : undefined))
        return workText(await infoText(ctx, id))
      } catch (err) {
        return fail(message(err))
      }
    }
  },
  {
    name: 'media_frames',
    description:
      'Looks at frames of a video item (or at an image item): up to 8 stills, each at most 1280 px, by frame number or time (`0:41`, `1:02:05.5`, `00:00:41:12`). Pass `at`, or `count` for frames spread evenly over the clip.',
    input: z.object({ item: itemInput, version: versionInput, at: z.array(momentInput).max(8).optional(), count: z.number().int().min(1).max(8).optional() }),
    readOnly: true,
    run: async (args, ctx) => {
      const a = args as { item: string; version?: number; at?: Array<string | number>; count?: number }
      try {
        const { p, row: vrow, v, table } = await readVersion(ctx, ownItem(ctx, a.item), a.version)
        if (!table) {
          const data = await p.still(vrow, null, ctx.signal)
          return { content: [{ type: 'text', text: `v${v.n} ${v.name}` }, { type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' }] }
        }
        const total = frameCount(table)
        const frames = a.at?.length ? a.at.map((m) => frameOf(table, m, v.probe?.timecode, v.probe?.rate)) : Array.from({ length: a.count ?? 6 }, (_, i) => Math.min(total - 1, Math.floor(((i + 0.5) * total) / (a.count ?? 6))))
        const content: WorkToolResult['content'] = []
        for (const f of frames) {
          const data = await p.still(vrow, f, ctx.signal)
          content.push({ type: 'text', text: `v${v.n} ${momentOf(v, f, table)}` }, { type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' })
        }
        return { content }
      } catch (err) {
        return fail(message(err))
      }
    }
  },
  {
    name: 'media_note',
    description:
      'Adds a note to an image or video item: at a moment (`at`: a frame number, `0:41`, or a timecode), over a stretch (`until`), and on a region of the picture (`region`, 0 to 1 of the picture, from its top left). On the person\'s own file it goes straight on and he can undo it; on a shared item, or when he set Suggests, it waits for him to accept.',
    input: z.object({ item: itemInput, version: versionInput, text: z.string().min(1).max(40_000), at: momentInput.optional(), until: momentInput.optional(), region: MediaRegionSchema.optional() }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item: string; version?: number; text: string; at?: string | number; until?: string | number; region?: { x: number; y: number; w: number; h: number } }
      try {
        const id = ownItem(ctx, a.item)
        const { v, table } = await readVersion(ctx, id, a.version)
        if (table && a.at === undefined) throw new Error('a note on a video needs `at`')
        const frame = table && a.at !== undefined ? frameOf(table, a.at, v.probe?.timecode, v.probe?.rate) : undefined
        const end = table && a.until !== undefined ? frameOf(table, a.until, v.probe?.timecode, v.probe?.rate) : undefined
        const anchor = { versionId: v.id, ...(frame !== undefined ? { frame } : {}), ...(frame !== undefined && end !== undefined && end > frame ? { durationFrames: end - frame + 1 } : {}), ...(a.region ? { region: a.region } : {}) }
        const { notes, suggested } = agentWrite(ctx, id, ctx.sessionId, [{ anchor, body: a.text }], 'Added a note')
        return workText(`${suggested ? 'Waiting for the person' : 'Added'}: note ${notes[0].id} at v${v.n} ${momentOf(v, frame, table)}.`)
      } catch (err) {
        return fail(message(err))
      }
    }
  },
  {
    name: 'media_chapters',
    description: 'Adds chapters to a video item, each a title at a moment (a frame number, `4:12`, or a timecode). They mark the scrubber and list under the player. The person can undo them in one step.',
    input: z.object({ item: itemInput, version: versionInput, chapters: z.array(z.object({ at: momentInput, title: z.string().min(1).max(200) })).min(1).max(200) }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item: string; version?: number; chapters: Array<{ at: string | number; title: string }> }
      try {
        const id = ownItem(ctx, a.item)
        const { v, table } = await readVersion(ctx, id, a.version)
        if (!table) throw new Error('chapters are for a video')
        const notes = a.chapters.map((c) => ({ kind: 'chapter' as const, anchor: { versionId: v.id, frame: frameOf(table, c.at, v.probe?.timecode, v.probe?.rate) }, body: c.title }))
        const { suggested } = agentWrite(ctx, id, ctx.sessionId, notes, `Added ${notes.length} chapter${notes.length === 1 ? '' : 's'}`)
        return workText(`${suggested ? 'Waiting for the person' : 'Added'}: ${notes.length} chapter${notes.length === 1 ? '' : 's'} on v${v.n}, ${Math.round(tableFps(table))} fps.`)
      } catch (err) {
        return fail(message(err))
      }
    }
  },
  {
    name: 'media_version',
    description: "Adds a file on this host as the item's next version (v2 after v1), for comparing cuts or edits. Notes stay on the version they were made on.",
    input: z.object({ item: itemInput, file: z.string().min(1).max(4096).describe('the absolute path of the new version on this host') }),
    readOnly: false,
    run: async (args, ctx) => {
      const a = args as { item: string; file: string }
      try {
        const id = ownItem(ctx, a.item)
        if (!isAbsolute(a.file) || !existsSync(a.file)) throw new Error(`there is no file at ${a.file}`)
        const v = liveOf(ctx).store.addVersion(id, { source: { at: 'file', host: ctx.host, path: a.file }, name: basename(a.file), by: `agent:${ctx.host}:${ctx.sessionId}` })
        ;(await preparerOf(ctx)).view(v)
        return workText(`Added v${v.n} ${v.name}.`)
      } catch (err) {
        return fail(message(err))
      }
    }
  }
]
