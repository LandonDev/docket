import type { MediaProbe } from '@shared/contract-work-media'

/**
 * The ffmpeg command lines the media pillar runs, as pure functions so a
 * test reads them (docs/agents/work-media.md, "Proxies"). ffmpeg is GPL: it
 * only ever runs as its own process, from the toolchain (work/formats).
 */

/** The longest side of a proxy. */
export const PROXY_MAX_SIDE = 1920
/** HLS segment length in seconds. */
export const HLS_SEGMENT_S = 4

/** A whole-frames keyframe interval of about one second, so a seek decodes at most a second. */
const gopOf = (p: MediaProbe): number => Math.max(1, Math.round(p.rate ? p.rate.num / p.rate.den : 24))

/**
 * The proxy's video filter: deinterlace in place (one frame out per frame
 * in), fit inside 1920 on the long side with even sides, and 8-bit 4:2:0.
 * The rotation is applied by ffmpeg's own autorotate before this runs.
 */
export function proxyFilter(p: MediaProbe): string {
  const turned = p.rotation === 90 || p.rotation === 270
  const w = turned ? p.height : p.width
  const h = turned ? p.width : p.height
  const scale = Math.max(w, h) > PROXY_MAX_SIDE ? (w >= h ? `scale=${PROXY_MAX_SIDE}:-2:flags=bicubic` : `scale=-2:${PROXY_MAX_SIDE}:flags=bicubic`) : 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
  return [p.interlaced ? 'bwdif=mode=send_frame' : null, scale, 'format=yuv420p'].filter(Boolean).join(',')
}

/**
 * An H.264 High 8-bit 4:2:0 proxy, frame for frame: CRF 23 capped at 10 Mb/s,
 * a keyframe each second, AAC at 192k, `-fps_mode passthrough` so the frame
 * count and every timestamp match the original (a note is a frame index; a
 * proxy that added or dropped one would move every note after it).
 * `hls`: fMP4 segments of four seconds under `output`'s folder, the playlist
 * at `output`, written as they are made.
 */
export function proxyArgs(o: { input: string; output: string; probe: MediaProbe; threads: number; hls?: boolean; progress?: string }): string[] {
  const g = gopOf(o.probe)
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-v',
    'error',
    ...(o.progress ? ['-progress', o.progress, '-stats_period', '1'] : []),
    '-threads',
    String(o.threads),
    '-i',
    o.input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-map_metadata',
    '-1',
    '-vf',
    proxyFilter(o.probe),
    '-fps_mode',
    'passthrough',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-profile:v',
    'high',
    '-crf',
    '23',
    '-maxrate',
    '10M',
    '-bufsize',
    '20M',
    '-g',
    String(g),
    '-keyint_min',
    String(g),
    '-sc_threshold',
    '0',
    '-threads',
    String(o.threads),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ac',
    '2'
  ]
  if (!o.hls) return [...args, '-movflags', '+faststart', '-f', 'mp4', o.output]
  return [
    ...args,
    '-f',
    'hls',
    '-hls_time',
    String(HLS_SEGMENT_S),
    '-hls_playlist_type',
    'event',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    'init.mp4',
    '-hls_segment_filename',
    o.output.replace(/[^/\\]+$/, 'seg%05d.m4s'),
    o.output
  ]
}

/** A still picture any Chromium shows: JPEG at quality 2 to 3, the HEIC's own orientation applied, the largest tile grid's whole picture. */
export function stillArgs(o: { input: string; output: string; threads: number; maxSide?: number }): string[] {
  const fit = o.maxSide ? [`scale='min(${o.maxSide},iw)':'min(${o.maxSide},ih)':force_original_aspect_ratio=decrease`] : []
  return ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-threads', String(o.threads), '-i', o.input, '-frames:v', '1', ...(fit.length ? ['-vf', fit.join(',')] : []), '-q:v', '2', '-f', 'image2', o.output]
}

/**
 * One frame of a video as a JPEG. `at` is half a frame before the frame's
 * start, counted from the stream's start. ffmpeg seeks the input to a
 * point well before it (an MPEG-TS seek lands on the next keyframe after
 * its point, so a seek near the frame overshoots it), then takes the first
 * frame at or after `at` by its own time.
 */
export const FRAME_SEEK_LEAD_S = 12
export function frameArgs(o: { input: string; output: string; at: number; maxSide: number }): string[] {
  const coarse = Math.max(0, o.at - FRAME_SEEK_LEAD_S)
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-v',
    'error',
    '-threads',
    '2',
    '-ss',
    coarse.toFixed(6),
    '-i',
    o.input,
    '-vf',
    `select='gte(t\\,${(o.at - coarse).toFixed(6)})',scale='min(${o.maxSide},iw)':'min(${o.maxSide},ih)':force_original_aspect_ratio=decrease`,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    '-f',
    'image2',
    o.output
  ]
}

// ── Deep Zoom ────────────────────────────────────────────────────────

export const TILE = 512

export interface TileLevel {
  level: number
  width: number
  height: number
  cols: number
  rows: number
}

/**
 * Deep Zoom's levels: level `L` is the picture scaled by 2^(L − max), max
 * being the level at full size. Only the levels a viewer zooms through are
 * cut: from the first that needs more than one tile up to full size; the
 * preview covers everything smaller.
 */
export function tileLevels(width: number, height: number, tile = TILE): { max: number; levels: TileLevel[] } {
  const max = Math.ceil(Math.log2(Math.max(width, height, 1)))
  const levels: TileLevel[] = []
  for (let level = max; level >= 0; level--) {
    const scale = 2 ** (max - level)
    const w = Math.max(1, Math.ceil(width / scale))
    const h = Math.max(1, Math.ceil(height / scale))
    levels.unshift({ level, width: w, height: h, cols: Math.ceil(w / tile), rows: Math.ceil(h / tile) })
    if (w <= tile && h <= tile) break
  }
  return { max, levels }
}

/**
 * One ffmpeg run that cuts every level: the picture is decoded once, split,
 * and each copy scaled, padded to whole tiles and cut by `untile` into
 * row-major frames `<dir>/<level>/%d.jpg`, which the caller renames to
 * `<col>_<row>.jpg`. The padding is never shown: the canvas clips each
 * level to the picture.
 */
export function tilesArgs(o: { input: string; dir: string; levels: TileLevel[]; threads: number; tile?: number }): string[] {
  const t = o.tile ?? TILE
  const n = o.levels.length
  const split = `[0:v]format=yuvj444p,split=${n}${o.levels.map((_, i) => `[s${i}]`).join('')}`
  const chains = o.levels.map((l, i) => `[s${i}]scale=${l.width}:${l.height}:flags=lanczos,pad=${l.cols * t}:${l.rows * t}:0:0:black,untile=${l.cols}x${l.rows}[o${i}]`)
  const outs = o.levels.flatMap((l, i) => ['-map', `[o${i}]`, '-fps_mode', 'passthrough', '-q:v', '3', '-start_number', '0', '-f', 'image2', `${o.dir}/${l.level}/%d.jpg`])
  return ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-threads', String(o.threads), '-i', o.input, '-filter_complex', [split, ...chains].join(';'), ...outs]
}
