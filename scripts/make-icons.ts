/**
 * Makes every app icon from one piece of art, build/icon-source.png (1024 px,
 * square, opaque, full bleed): `bun run icons`. A headless Chromium draws and
 * cuts each size (the box has no image library); scripts/lib/iconFiles.ts
 * writes the containers. The next icon is a new icon-source.png and this
 * command. TC_CHROME names the browser when it is not found.
 *
 * Shapes, on a 1024 grid:
 * - mac: an 824 rounded square (radius 185) centred with a soft shadow; macOS
 *   draws no mask of its own for an .icns.
 * - round: a 976 rounded square (radius 216) for Windows, the window icon, the
 *   Office add-in and favicons.
 * - bleed: the art as it is, for the phone, which masks it itself.
 * - mask: the slabs alone as white on clear, each as solid as it stands off the
 *   art's ground, for the boot splash, which paints it in the theme's ink.
 * At 32 px and below the art is cropped closer so the slabs stay apart.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Cdp } from '../src/main/server/work/browser/box/cdp'
import { icns, ico, png, type Pixels } from './lib/iconFiles'

type Shape = 'mac' | 'round' | 'bleed' | 'mask'

const root = resolve(import.meta.dirname, '..')
const at = (...p: string[]): string => join(root, ...p)

function findChrome(): string {
  const cache = join(homedir(), '.cache', 'ms-playwright')
  const playwright = existsSync(cache)
    ? readdirSync(cache)
        .filter((n) => /^chromium-\d+$/.test(n))
        .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
        .map((n) => join(cache, n, 'chrome-linux64', 'chrome'))
    : []
  const found = [process.env.TC_CHROME, ...playwright, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(
    (p): p is string => !!p && existsSync(p)
  )
  if (!found) throw new Error('no Chromium found: set TC_CHROME to a Chrome or Chromium binary')
  return found
}

/** Draws in the page: the art cropped closer at small sizes, halved step by step so nothing aliases, cut to its shape. */
const PAGE_CODE = `
window.drawIcon = async (src, size, shape) => {
  const img = new Image()
  img.src = src
  await img.decode()
  if (shape === 'mask') return drawMask(img, size)
  const crop = size <= 16 ? [168, 196, 688] : size <= 32 ? [152, 176, 720] : [0, 0, 1024]
  const box = shape === 'mac' ? [100, 824, 185] : shape === 'round' ? [24, 976, 216] : [0, 1024, 0]
  const inner = Math.round((box[1] / 1024) * size)
  let canvas = document.createElement('canvas')
  canvas.width = canvas.height = crop[2]
  canvas.getContext('2d').drawImage(img, crop[0], crop[1], crop[2], crop[2], 0, 0, crop[2], crop[2])
  while (canvas.width / 2 >= inner) {
    const half = document.createElement('canvas')
    half.width = half.height = Math.max(inner, Math.round(canvas.width / 2))
    const g = half.getContext('2d')
    g.imageSmoothingQuality = 'high'
    g.drawImage(canvas, 0, 0, half.width, half.height)
    canvas = half
  }
  const out = document.createElement('canvas')
  out.width = out.height = size
  const g = out.getContext('2d')
  const k = size / 1024
  const x = (box[0] / 1024) * size
  if (shape === 'mac' && size > 32) {
    g.save()
    g.shadowColor = 'rgba(0, 0, 0, 0.3)'
    g.shadowBlur = 20 * k
    g.shadowOffsetY = 10 * k
    g.beginPath()
    g.roundRect(x, x, (box[1] / 1024) * size, (box[1] / 1024) * size, box[2] * k)
    g.fillStyle = '#000'
    g.fill()
    g.restore()
  }
  g.save()
  if (shape !== 'bleed') {
    g.beginPath()
    g.roundRect(x, x, (box[1] / 1024) * size, (box[1] / 1024) * size, box[2] * k)
    g.clip()
  }
  g.imageSmoothingQuality = 'high'
  g.drawImage(canvas, x, x, (box[1] / 1024) * size, (box[1] / 1024) * size)
  g.restore()
  return encode(g, size)
}

const encode = (g, size) => {
  const data = g.getImageData(0, 0, size, size).data
  let bin = ''
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** The stack's square (x, y, side) on the art, and how far from the ground a pixel must stand to be solid. */
const drawMask = (img, size) => {
  const [cx, cy, side, solid] = [181, 210, 660, 90]
  let canvas = document.createElement('canvas')
  canvas.width = canvas.height = side
  const g0 = canvas.getContext('2d', { willReadFrequently: true })
  g0.drawImage(img, cx, cy, side, side, 0, 0, side, side)
  const px = g0.getImageData(0, 0, side, side)
  const d = px.data
  const ground = [d[0], d[1], d[2]]
  for (let i = 0; i < d.length; i += 4) {
    const off = Math.max(Math.abs(d[i] - ground[0]), Math.abs(d[i + 1] - ground[1]), Math.abs(d[i + 2] - ground[2]))
    d[i] = d[i + 1] = d[i + 2] = 255
    d[i + 3] = Math.min(255, Math.round((off / solid) * 255))
  }
  g0.putImageData(px, 0, 0)
  while (canvas.width / 2 >= size) {
    const half = document.createElement('canvas')
    half.width = half.height = Math.max(size, Math.round(canvas.width / 2))
    const g = half.getContext('2d')
    g.imageSmoothingQuality = 'high'
    g.drawImage(canvas, 0, 0, half.width, half.height)
    canvas = half
  }
  const out = document.createElement('canvas')
  out.width = out.height = size
  const g = out.getContext('2d', { willReadFrequently: true })
  g.imageSmoothingQuality = 'high'
  g.drawImage(canvas, 0, 0, size, size)
  return encode(g, size)
}
`

async function openBrowser(): Promise<{ cdp: Cdp; close: () => Promise<void> }> {
  const profile = mkdtempSync(join(tmpdir(), 'make-icons-'))
  const child = spawn(findChrome(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  const portFile = join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100))
  const port = readFileSync(portFile, 'utf8').split('\n')[0]
  const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[]
  const cdp = await Cdp.open(pages.find((p) => p.type === 'page')!.webSocketDebuggerUrl)
  return {
    cdp,
    close: async () => {
      cdp.close()
      await new Promise<void>((done) => {
        child.once('exit', () => done())
        child.kill()
      })
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
}

async function main(): Promise<void> {
  const src = `data:image/png;base64,${readFileSync(at('build/icon-source.png')).toString('base64')}`
  const { cdp, close } = await openBrowser()
  try {
    await cdp.send('Runtime.evaluate', { expression: PAGE_CODE })
    const draw = async (size: number, shape: Shape): Promise<Pixels> => {
      const { result } = await cdp.send<{ result: { value: string } }>('Runtime.evaluate', {
        expression: `drawIcon(${JSON.stringify(src)}, ${size}, ${JSON.stringify(shape)})`,
        awaitPromise: true,
        returnByValue: true
      })
      return { size, rgba: new Uint8Array(Buffer.from(result.value, 'base64')) }
    }
    const write = (path: string, bytes: Buffer): void => {
      mkdirSync(dirname(at(path)), { recursive: true })
      writeFileSync(at(path), bytes)
      console.log(`${path} (${bytes.length} bytes)`)
    }

    const mac = new Map<number, Pixels>()
    for (const size of [16, 32, 64, 128, 256, 512, 1024]) mac.set(size, await draw(size, 'mac'))
    write('build/icon.icns', icns(mac))

    const round = new Map<number, Pixels>()
    for (const size of [16, 24, 32, 48, 64, 128, 144, 256, 512, 1024]) round.set(size, await draw(size, 'round'))
    write('build/icon.ico', ico([16, 24, 32, 48, 64, 128, 256].map((s) => round.get(s)!)))
    write('build/icon.png', png(round.get(1024)!))
    write('resources/icon.png', png(round.get(512)!))
    write('src/hosted/public/favicon.png', png(round.get(32)!))
    write('src/renderer/public/favicon.png', png(round.get(32)!))
    write('src/renderer/public/mark.png', png(await draw(144, 'mask')))
    for (const size of [32, 64, 80]) write(`addins/office/icon-${size}.png.b64`, Buffer.from(`${png(round.get(size) ?? (await draw(size, 'round'))).toString('base64')}`))

    const touch = await draw(180, 'bleed')
    write('src/hosted/public/apple-touch-icon.png', png(touch, true))
    write('src/renderer/public/apple-touch-icon.png', png(touch, true))
    const appIcon = 'ios/TempCode/Sources/Assets.xcassets/AppIcon.appiconset'
    write(`${appIcon}/AppIcon.png`, png(await draw(1024, 'bleed'), true))
    const images = [{ filename: 'AppIcon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }]
    write(`${appIcon}/Contents.json`, Buffer.from(`${JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2)}\n`))
  } finally {
    await close()
  }
}

await main()
