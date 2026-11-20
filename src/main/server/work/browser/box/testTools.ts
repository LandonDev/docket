import { inflateSync } from 'node:zlib'
import { BoxChromium, type BoxChromiumOptions } from './chromium'
import { closedToAgents, type BrowserLink } from './service'
import { BoxStage } from './stage'
import { videoToolsAt, type VideoTools } from './videoSetting'

/**
 * What the box browser's tests share. The installed video tools a live test
 * runs against, or null where there are none (the test then skips): the
 * userData `TEMP_CODE_TEST_VIDEO_TOOLS` names, else this host's own. Install
 * them into a scratch folder with
 * `bun scripts/work-tools/install.ts --data <dir> --only screen-relay`.
 */
export function testVideoTools(env: NodeJS.ProcessEnv = process.env): VideoTools | null {
  if (process.platform !== 'linux') return null
  for (const dataDir of [env.TEMP_CODE_TEST_VIDEO_TOOLS, env.TEMP_CODE_USER_DATA]) {
    const tools = dataDir ? videoToolsAt(dataDir) : null
    if (tools) return tools
  }
  return null
}

/** `TC_BOX_HEADED=1` runs the box browser's own tests headed on a private display, where the tools are installed. */
export const testHeaded = (env: NodeJS.ProcessEnv = process.env): boolean => env.TC_BOX_HEADED === '1' && testVideoTools(env) !== null

export interface TestBrowser {
  browser: BoxChromium
  stage: BoxStage
  /** what a `BoxComputerService` is given */
  link: BrowserLink
}

/** The box's browser as the host wires it (index.ts `wireBoxBrowser`): headless, or headed with its stage when `headed`. */
export function testBrowser(root: string, bin: string, o: { headed?: boolean; pid?: boolean } & Partial<BoxChromiumOptions> = {}): TestBrowser {
  const { headed = testHeaded(), pid = true, ...rest } = o
  const tools = headed ? testVideoTools() : null
  const browser = new BoxChromium({ root, bin: () => bin, video: () => tools, ...rest })
  const stage = new BoxStage({ endpoint: () => browser.endpoint(), wm: () => browser.wm }, { closed: closedToAgents })
  browser.onStop(() => stage.close())
  return {
    browser,
    stage,
    link: {
      endpoint: () => browser.endpoint(),
      pid: () => (pid ? browser.pid : null),
      touch: () => browser.touch(),
      headed: () => stage.headed(),
      open: (url) => stage.open(url),
      ready: () => stage.ready()
    }
  }
}

/** The pixels of an 8-bit RGB or RGBA PNG that is not interlaced, as RGB triples row by row. */
export function pngPixels(png: Buffer): { width: number; height: number; rgb: Uint8Array } {
  let at = 8
  let width = 0
  let height = 0
  let channels = 0
  const data: Buffer[] = []
  while (at < png.length) {
    const length = png.readUInt32BE(at)
    const type = png.toString('latin1', at + 4, at + 8)
    const body = png.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const colour = body[9]
      if (body[8] !== 8 || (colour !== 2 && colour !== 6) || body[12] !== 0) throw new Error('not an 8-bit RGB or RGBA PNG')
      channels = colour === 6 ? 4 : 3
    } else if (type === 'IDAT') data.push(body)
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const rows = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? rows[y * stride + x - channels] : 0
      const up = y ? rows[(y - 1) * stride + x] : 0
      const corner = y && x >= channels ? rows[(y - 1) * stride + x - channels] : 0
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - corner
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)]
        predicted = a <= b && a <= c ? left : b <= c ? up : corner
      }
      rows[y * stride + x] = (line[x] + predicted) & 0xff
    }
  }
  const rgb = new Uint8Array(width * height * 3)
  for (let i = 0; i < width * height; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = rows[i * channels + c]
  return { width, height, rgb }
}

/** The share of pixels of two pictures of one size that differ by more than `by` in a channel. */
export function pixelsApart(a: { rgb: Uint8Array }, b: { rgb: Uint8Array }, by = 24): number {
  let apart = 0
  const count = a.rgb.length / 3
  for (let i = 0; i < count; i++) {
    if (Math.abs(a.rgb[i * 3] - b.rgb[i * 3]) > by || Math.abs(a.rgb[i * 3 + 1] - b.rgb[i * 3 + 1]) > by || Math.abs(a.rgb[i * 3 + 2] - b.rgb[i * 3 + 2]) > by) apart++
  }
  return apart / count
}

/** The colour at one point of a picture, as `r,g,b`. */
export function pixelAt(p: { width: number; rgb: Uint8Array }, x: number, y: number): string {
  const i = (y * p.width + x) * 3
  return `${p.rgb[i]},${p.rgb[i + 1]},${p.rgb[i + 2]}`
}

/**
 * What an H.264 stream's SPS says of reordering: whether it carries the
 * bitstream restriction at all, and how many frames a decoder must be ready
 * to hold back. A hardware decoder holds its output for a stream that does
 * not say it reorders nothing, and a viewer that draws nothing acks nothing.
 * Null when the access unit holds no SPS it can read.
 */
export function spsReorder(annexB: Uint8Array): { restriction: boolean; reorder: number | null } | null {
  let at = -1
  for (let i = 0; i + 4 < annexB.length; i++) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1 && (annexB[i + 3] & 31) === 7) {
      at = i + 4
      break
    }
  }
  if (at < 0) return null
  // the SPS's own bytes: up to the next start code, with the emulation prevention bytes taken out
  const raw: number[] = []
  for (let i = at; i < annexB.length; i++) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && (annexB[i + 2] === 1 || (annexB[i + 2] === 0 && annexB[i + 3] === 1))) break
    if (i >= at + 2 && annexB[i] === 3 && annexB[i - 1] === 0 && annexB[i - 2] === 0) continue
    raw.push(annexB[i])
  }
  let bit = 0
  const u = (n: number): number => {
    let v = 0
    for (let i = 0; i < n; i++, bit++) v = v * 2 + ((raw[bit >> 3] >> (7 - (bit & 7))) & 1)
    return v
  }
  const ue = (): number => {
    let zeros = 0
    while (u(1) === 0 && zeros < 32) zeros++
    return 2 ** zeros - 1 + u(zeros)
  }
  const se = (): number => ue()
  const hrd = (): void => {
    const count = ue() + 1
    u(8)
    for (let i = 0; i < count; i++) {
      ue()
      ue()
      u(1)
    }
    u(20)
  }
  const profile = u(8)
  u(16)
  ue()
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    if (ue() === 3) u(1)
    ue()
    ue()
    u(1)
    // scaling lists are not read: no stream here carries them
    if (u(1)) return null
  }
  ue()
  const poc = ue()
  if (poc === 0) ue()
  else if (poc === 1) {
    u(1)
    se()
    se()
    const cycle = ue()
    for (let i = 0; i < cycle; i++) se()
  }
  ue()
  u(1)
  ue()
  ue()
  if (!u(1)) u(1)
  u(1)
  if (u(1)) for (let i = 0; i < 4; i++) ue()
  if (!u(1)) return { restriction: false, reorder: null }
  // the VUI, as far as the restriction
  if (u(1) && u(8) === 255) u(32)
  if (u(1)) u(1)
  if (u(1)) {
    u(4)
    if (u(1)) u(24)
  }
  if (u(1)) {
    ue()
    ue()
  }
  if (u(1)) {
    u(32)
    u(32)
    u(1)
  }
  const nal = u(1)
  if (nal) hrd()
  const vcl = u(1)
  if (vcl) hrd()
  if (nal || vcl) u(1)
  u(1)
  if (!u(1)) return { restriction: false, reorder: null }
  u(1)
  for (let i = 0; i < 4; i++) ue()
  return { restriction: true, reorder: ue() }
}
