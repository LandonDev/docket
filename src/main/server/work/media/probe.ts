import { statSync } from 'node:fs'
import type { FrameRate, FrameTable, MediaProbe } from '@shared/contract-work-media'
import { runTool, tailOf } from '../formats/tools'

/**
 * What a file is, read by ffprobe on the host (docs/agents/work-media.md,
 * "Probing"): codec, profile, pixel format, rate, start timecode, rotation,
 * and whether the rate varies; then the frame table every note is keyed to.
 * The parsing is pure so a test reads ffprobe's own JSON.
 */

/** Extensions read as a still picture. Everything else ffprobe reads as a video when it has a moving stream. */
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'heif', 'bmp', 'tif', 'tiff'])
/** Still formats that come with a frame or two of "video" in ffprobe's eyes. */
const STILL_CODECS = new Set(['png', 'mjpeg', 'gif', 'webp', 'bmp', 'tiff', 'jpegls', 'jpeg2000'])

export const probeArgs = (path: string): string[] => ['-v', 'error', '-show_format', '-show_streams', '-show_stream_groups', '-of', 'json', path]
/** Every packet time of the first video stream, in decode order (sorted after). */
export const packetArgs = (path: string): string[] => ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', path]

const rateOf = (s: unknown): FrameRate | undefined => {
  const m = typeof s === 'string' ? /^(\d+)\/(\d+)$/.exec(s) : null
  if (!m) return undefined
  const num = Number(m[1])
  const den = Number(m[2])
  return num > 0 && den > 0 ? { num, den } : undefined
}

const bitDepthOf = (pixFmt: string | undefined): number | undefined => {
  if (!pixFmt) return undefined
  const m = /p(\d{2})(le|be)?$/.exec(pixFmt)
  return m ? Number(m[1]) : 8
}

const rotationOf = (stream: Record<string, unknown>): MediaProbe['rotation'] => {
  const side = (stream.side_data_list as Array<Record<string, unknown>> | undefined) ?? []
  const raw = side.find((d) => typeof d.rotation === 'number')?.rotation ?? (stream.tags as Record<string, string> | undefined)?.rotate
  const deg = (((Math.round(Number(raw ?? 0) / 90) * 90) % 360) + 360) % 360
  return deg as MediaProbe['rotation']
}

interface ProbeJson {
  format?: Record<string, unknown>
  streams?: Array<Record<string, unknown>>
  stream_groups?: Array<{ type?: string; components?: Array<{ width?: number; height?: number }> }>
}

/** ffprobe's JSON and the file's size and time → what the canvas and the plan need. Throws a sentence when there is no picture in it. */
export function parseProbe(json: ProbeJson, file: { size: number; mtimeMs: number; ext: string }): MediaProbe {
  const streams = json.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition as Record<string, number> | undefined)?.attached_pic)
  if (!video) throw new Error('there is no picture in this file')
  const codec = String(video.codec_name ?? 'unknown')
  const pixFmt = typeof video.pix_fmt === 'string' ? video.pix_fmt : undefined
  const grid = json.stream_groups?.find((g) => g.type === 'Tile Grid')?.components?.[0]
  const still = IMAGE_EXTS.has(file.ext) || STILL_CODECS.has(codec) || !!grid
  const width = Number(grid?.width ?? video.width ?? 0)
  const height = Number(grid?.height ?? video.height ?? 0)
  const base: MediaProbe = {
    kind: still ? 'image' : 'video',
    container: String(json.format?.format_name ?? ''),
    size: file.size,
    mtimeMs: file.mtimeMs,
    width,
    height,
    rotation: rotationOf(video),
    codec,
    ...(typeof video.profile === 'string' ? { profile: video.profile } : {}),
    ...(pixFmt ? { pixFmt, bitDepth: bitDepthOf(pixFmt) } : {})
  }
  if (still) return base
  const r = rateOf(video.r_frame_rate)
  const avg = rateOf(video.avg_frame_rate)
  const rate = r ?? avg
  const durationS = Number(video.duration ?? json.format?.duration ?? 0) || undefined
  const nb = Number(video.nb_frames ?? 0) || undefined
  const tags = (video.tags as Record<string, string> | undefined) ?? {}
  const tmcd = streams.find((s) => (s.tags as Record<string, string> | undefined)?.timecode)
  const timecode = tags.timecode ?? (tmcd?.tags as Record<string, string> | undefined)?.timecode ?? (json.format?.tags as Record<string, string> | undefined)?.timecode
  const audio = streams.find((s) => s.codec_type === 'audio')
  const fieldOrder = typeof video.field_order === 'string' ? video.field_order : 'progressive'
  return {
    ...base,
    ...(rate ? { rate } : {}),
    ...(durationS ? { durationS } : {}),
    ...(nb ? { frames: nb } : {}),
    ...(r && avg && r.num * avg.den !== avg.num * r.den ? { vfr: true } : {}),
    ...(timecode ? { timecode } : {}),
    ...(fieldOrder !== 'progressive' && fieldOrder !== 'unknown' ? { interlaced: true } : {}),
    ...(audio ? { audio: { codec: String(audio.codec_name ?? ''), channels: Number(audio.channels ?? 0) } } : {})
  }
}

/**
 * The frame table from every packet's time. A clip whose frames sit on its
 * rate's grid (to a tenth of a frame) is `cfr`, kept as start, rate and
 * count; otherwise every time is kept. A rate in the metadata is never
 * trusted alone: the formats research found a phone-style clip whose tags
 * said 30 fps with a sixth of its frames missing.
 */
export function frameTableOf(packetTimes: number[], probe: Pick<MediaProbe, 'rate' | 'durationS'>): FrameTable {
  const times = packetTimes.filter((t) => Number.isFinite(t)).sort((a, b) => a - b)
  const rate = probe.rate
  if (times.length === 0) throw new Error('ffprobe found no frames')
  const start = times[0]
  if (rate) {
    const step = rate.den / rate.num
    const onGrid = times.every((t, i) => Math.abs(t - (start + i * step)) < step * 0.1)
    if (onGrid) return { kind: 'cfr', start, rate, count: times.length }
  }
  const last = times[times.length - 1]
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b)
  const typical = gaps.length ? gaps[gaps.length >> 1] : rate ? rate.den / rate.num : 1 / 30
  const end = probe.durationS && probe.durationS + start > last ? Math.min(probe.durationS + start, last + typical * 4) : last + typical
  return { kind: 'vfr', times, end }
}

/** `0.033000\n0.067000,` → numbers. */
export const parsePacketTimes = (csv: string): number[] =>
  csv
    .split('\n')
    .map((l) => Number.parseFloat(l.split(',')[0]))
    .filter((n) => Number.isFinite(n))

export interface Probed {
  probe: MediaProbe
  table?: FrameTable
}

/** ffprobe on this host: the file's facts and, for a video, its frame table. */
export async function probeFile(ffprobe: string, path: string, signal?: AbortSignal): Promise<Probed> {
  const st = statSync(path)
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  const r = await runTool(ffprobe, probeArgs(path), { timeoutMs: 60_000, signal })
  if (r.code !== 0) throw new Error(`ffprobe could not read it: ${tailOf(r.out)}`)
  const json = JSON.parse(r.out.slice(r.out.indexOf('{'))) as ProbeJson
  const probe = parseProbe(json, { size: st.size, mtimeMs: st.mtimeMs, ext })
  if (probe.kind === 'image') return { probe }
  const p = await runTool(ffprobe, packetArgs(path), { timeoutMs: 10 * 60_000, signal, gentle: true })
  if (p.code !== 0) throw new Error(`ffprobe could not list its frames: ${tailOf(p.out)}`)
  const table = frameTableOf(parsePacketTimes(p.out), probe)
  return { probe: { ...probe, frames: table.kind === 'cfr' ? table.count : table.times.length, ...(table.kind === 'vfr' ? { vfr: true } : {}) }, table }
}
