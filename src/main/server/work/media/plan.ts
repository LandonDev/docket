import { playKey, VIEWER_DEFAULT_PLAYS, type MediaProbe } from '@shared/contract-work-media'

export { playKey }

/**
 * How a version is shown, decided from its probe and what the viewer says it
 * decodes (docs/agents/work-media.md, "What plays"). The formats research's
 * rule: play the original where it decodes, else an H.264 proxy made on the
 * host, as HLS for a file over about ten minutes; HEIC is converted on the
 * host; a picture past about 40 megapixels is cut into Deep Zoom tiles.
 */

/** Past this a proxy is cut into HLS segments, so it plays while the host still writes it. */
export const HLS_OVER_S = 10 * 60
/** Past this a picture is cut into tiles: Chromium took 2 s to decode a 240 MP JPEG to 2048 px. */
export const TILES_OVER_MP = 40

export type VideoPlan = { via: 'original' } | { via: 'proxy' | 'hls'; why: string }
export type ImagePlan = { via: 'image' } | { via: 'convert'; why: string } | { via: 'tiles'; why: string }

const CODEC_WORDS: Record<string, string> = { prores: 'ProRes', dnxhd: 'DNxHR', hevc: 'HEVC', 'h264-hi': 'H.264 at 10 bits or 4:2:2', mpeg2video: 'MPEG-2', vp8: 'VP8' }

export function planVideo(p: MediaProbe, plays: readonly string[] = VIEWER_DEFAULT_PLAYS, hlsOverS = HLS_OVER_S): VideoPlan {
  const key = playKey(p)
  const long = (p.durationS ?? 0) > hlsOverS
  const via = long ? 'hls' : 'proxy'
  if (p.interlaced) return { via, why: 'It is interlaced' }
  if (!plays.includes(key)) return { via, why: `This viewer does not play ${CODEC_WORDS[key] ?? key}` }
  return { via: 'original' }
}

/** Formats every Chromium shows as they are. */
const NATIVE_IMAGES = new Set(['png', 'mjpeg', 'gif', 'webp', 'av1', 'bmp', 'svg'])

export function planImage(p: MediaProbe, ext: string): ImagePlan {
  if ((p.width * p.height) / 1e6 > TILES_OVER_MP) return { via: 'tiles', why: `It is ${Math.round((p.width * p.height) / 1e6)} megapixels` }
  if (ext === 'heic' || ext === 'heif' || p.codec === 'hevc') return { via: 'convert', why: 'HEIC is converted on the host' }
  if (ext === 'tif' || ext === 'tiff' || !NATIVE_IMAGES.has(p.codec)) return { via: 'convert', why: `${ext.toUpperCase()} is converted on the host` }
  return { via: 'image' }
}
