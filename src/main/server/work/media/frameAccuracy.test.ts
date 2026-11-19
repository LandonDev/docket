import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { frameStart, type FrameTable } from '@shared/contract-work-media'
import { runTool, tailOf, Toolchain } from '../formats/tools'
import { proxyArgs } from './encode'
import { probeFile } from './probe'

/**
 * The formats research's frame-accuracy finding, proved on the code that
 * ships: clips with their frame number as a barcode, made by the toolchain's
 * ffmpeg, the host's own proxy command lines, and a real Electron page that
 * seeks with `seekToFrame` (src/renderer/src/work/media/seek.ts) and feeds
 * the HLS proxy through `attachSegments` (segments.ts), reading every frame
 * back from its pixels. Bit k of the frame number is a white box, a
 * sixteenth of the width square, at x = k sixteenths, y = 0.
 *
 * It needs the toolchain (TEMP_CODE_WORK_TOOLS_DATA, a userData the
 * installer filled), bun, xvfb-run, dbus-run-session and Electron; without
 * them it is skipped and says which is missing. TC_FRAME_ACCURACY_OUT=<file>
 * keeps the page's whole result.
 */

const repo = resolve(import.meta.dirname, '../../../../..')
const DATA = process.env.TEMP_CODE_WORK_TOOLS_DATA
const tools = DATA ? new Toolchain(DATA) : null
const ffmpeg = tools?.bin('ffmpeg') ?? null
const ffprobe = tools?.bin('ffmpeg', 'ffprobe') ?? null

const onPath = (name: string): string | null => {
  for (const dir of [...(process.env.PATH ?? '').split(delimiter), join(process.env.HOME ?? '', '.bun/bin')]) if (dir && existsSync(join(dir, name))) return join(dir, name)
  return null
}
const electronBin = ((): string | null => {
  try {
    const dir = dirname(createRequire(import.meta.url).resolve('electron/package.json'))
    const bin = join(dir, 'dist', readFileSync(join(dir, 'path.txt'), 'utf8').trim())
    return existsSync(bin) ? bin : null
  } catch {
    return null
  }
})()
const bun = onPath('bun')
const xvfb = onPath('xvfb-run')
const dbus = onPath('dbus-run-session')
const missing = [
  !DATA && 'TEMP_CODE_WORK_TOOLS_DATA is not set',
  DATA && !ffmpeg && `no ffmpeg tool in ${DATA}`,
  DATA && !ffprobe && `no ffprobe in ${DATA}`,
  !bun && 'no bun',
  !xvfb && 'no xvfb-run',
  !dbus && 'no dbus-run-session',
  !electronBin && 'no Electron binary'
].filter(Boolean) as string[]

/** The research's 16 targets in a 120-frame clip, and 16 distinct frames under 48 for the 4K one. */
const TARGETS = [0, 1, 2, 11, 12, 23, 24, 25, 47, 48, 49, 71, 95, 100, 118, 119]
const TARGETS_48 = [0, 1, 2, 11, 12, 13, 23, 24, 25, 30, 35, 40, 44, 45, 46, 47]

/** A black strip with frame n's 12 bits as white boxes of side `box`, over `background`. */
const barcode = (box: number): string =>
  [
    `drawbox=x=0:y=0:w=${12 * box}:h=${box}:color=black:t=fill`,
    ...Array.from({ length: 12 }, (_, k) => `drawbox=x=${k * box}:y=0:w=${box}:h=${box}:color=white:t=fill:enable='mod(floor(n/${1 << k}),2)'`)
  ].join(',')

const ENCODES: Record<string, string[]> = {
  h264: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart'],
  vp9: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-g', '48'],
  av1: ['-c:v', 'libsvtav1', '-preset', '10', '-crf', '40', '-g', '48', '-svtav1-params', 'lp=2']
}
const EXT: Record<string, string> = { h264: 'mp4', vp9: 'webm', av1: 'webm' }

let root = ''
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

async function ff(args: string[]): Promise<void> {
  const r = await runTool(ffmpeg!, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...args], { gentle: true, timeoutMs: 120_000 })
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${tailOf(r.out)}`)
}

/** The m3u8's segments as start and duration. */
function playlistSegments(m3u8: string): Array<{ start: number; duration: number; file: string }> {
  const out: Array<{ start: number; duration: number; file: string }> = []
  let start = 0
  const lines = m3u8.split('\n').map((l) => l.trim())
  lines.forEach((l, i) => {
    const m = /^#EXTINF:([\d.]+)/.exec(l)
    if (!m) return
    const duration = Number(m[1])
    out.push({ start, duration, file: lines[i + 1] })
    start += duration
  })
  return out
}

interface Row {
  n: number
  reported: number
  shown: number
}
interface ClipResult {
  error?: string
  errorCode?: number
  rows?: Row[]
  /** the control: a seek to the frame's start time, read from the pixels */
  start?: Array<{ n: number; shown: number }>
  /** while playing: frame callbacks whose reported frame differed from the pixels */
  play?: { callbacks: number; wrong: number }
}

describe.skipIf(missing.length > 0)(`frame accuracy in Electron${missing.length ? ` (skipped: ${missing.join('; ')})` : ''}`, () => {
  it('shows the frame a note names on H.264, VP9, AV1, a 4K ProRes proxy and the HLS proxy', { timeout: 300_000 }, async () => {
    root = mkdtempSync(join(tmpdir(), 'tc-frame-accuracy-'))
    const src = (size: string, seconds: number): string[] => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=24:duration=${seconds}`]

    // a. the clips
    for (const [name, enc] of Object.entries(ENCODES)) {
      const audio = name === 'h264' ? ['-f', 'lavfi', '-i', 'sine=f=440:d=5', '-shortest'] : []
      await ff(['-threads', '2', ...src('640x360', 5), ...audio, '-vf', barcode(40), '-threads', '2', ...enc, join(root, `${name}.${EXT[name]}`)])
    }
    await ff(['-threads', '2', '-f', 'lavfi', '-i', 'color=c=0x303030:size=3840x2160:rate=24:duration=2', '-vf', barcode(240), '-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le', '-threads', '2', join(root, 'prores.mov')])

    const probed: Record<string, Awaited<ReturnType<typeof probeFile>>> = {}
    for (const f of ['h264.mp4', 'vp9.webm', 'av1.webm', 'prores.mov']) probed[f] = await probeFile(ffprobe!, join(root, f))
    for (const f of ['h264.mp4', 'vp9.webm', 'av1.webm']) expect(probed[f].probe.frames, f).toBe(120)

    // b. the ProRes proxy, by the host's command line: frame for frame
    const proxy = await runTool(ffmpeg!, proxyArgs({ input: join(root, 'prores.mov'), output: join(root, 'prores-proxy.mp4'), probe: probed['prores.mov'].probe, threads: 2 }), { gentle: true, timeoutMs: 180_000 })
    expect(proxy.code, tailOf(proxy.out)).toBe(0)
    probed['prores-proxy.mp4'] = await probeFile(ffprobe!, join(root, 'prores-proxy.mp4'))
    const [orig, made] = [probed['prores.mov'], probed['prores-proxy.mp4']]
    expect(orig.probe.frames).toBe(48)
    expect(made.probe.frames).toBe(48)
    expect(made.probe.width).toBe(1920)
    const starts = (t: FrameTable, n: number): number[] => Array.from({ length: n }, (_, i) => Number(frameStart(t, i).toFixed(6)))
    expect(starts(made.table!, 49)).toEqual(starts(orig.table!, 49))

    // the HLS proxy of the H.264 clip, by the host's command line
    mkdirSync(join(root, 'hls'))
    const hls = await runTool(ffmpeg!, proxyArgs({ input: join(root, 'h264.mp4'), output: join(root, 'hls', 'index.m3u8'), probe: probed['h264.mp4'].probe, threads: 2, hls: true }), { gentle: true, timeoutMs: 180_000 })
    expect(hls.code, tailOf(hls.out)).toBe(0)
    const segments = playlistSegments(readFileSync(join(root, 'hls', 'index.m3u8'), 'utf8'))
    expect(segments.length).toBeGreaterThan(1)
    // The fMP4 segments carry no edit list: the first frame shows at the encoder's B-frame delay (two
    // frames for x264), and Media Source plays it there. The HLS variant's table is the playlist's own.
    const hlsTable = (await probeFile(ffprobe!, join(root, 'hls', 'index.m3u8'))).table!
    const source = probed['h264.mp4'].table!
    const shift = frameStart(hlsTable, 0) - frameStart(source, 0)
    expect(starts(hlsTable, 121).map((t) => Number((t - shift).toFixed(6)))).toEqual(starts(source, 121))

    // c. one Electron page
    const clips = [
      { name: 'h264', url: '/h264.mp4', table: probed['h264.mp4'].table, targets: TARGETS },
      { name: 'vp9', url: '/vp9.webm', table: probed['vp9.webm'].table, targets: TARGETS },
      { name: 'av1', url: '/av1.webm', table: probed['av1.webm'].table, targets: TARGETS },
      { name: 'prores-original', url: '/prores.mov', table: orig.table, targets: [], unplayable: true },
      { name: 'prores-proxy', url: '/prores-proxy.mp4', table: made.table, targets: TARGETS_48 },
      {
        name: 'hls',
        hls: { init: '/hls/init.mp4', segments: segments.map(({ start, duration }) => ({ start, duration })), files: segments.map((s) => `/hls/${s.file}`), mime: 'video/mp4; codecs="avc1.640028,mp4a.40.2"' },
        table: hlsTable,
        targets: TARGETS
      }
    ]
    writeFileSync(join(root, 'config.json'), JSON.stringify({ clips }))
    writeFileSync(join(root, 'page.ts'), PAGE_TS.replaceAll('@MEDIA@', join(repo, 'src/renderer/src/work/media')).replaceAll('@SHARED@', join(repo, 'src/shared')))
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><body style="margin:0;background:#000"><video id="v" muted playsinline style="width:640px"></video><script src="/page.js"></script></body></html>')
    writeFileSync(join(root, 'main.cjs'), MAIN_CJS)
    const built = spawnSync(bun!, ['build', join(root, 'page.ts'), '--target=browser', '--outfile', join(root, 'page.js')], { cwd: repo, encoding: 'utf8', timeout: 60_000 })
    expect(built.status, `${built.stdout}${built.stderr}`).toBe(0)

    const resultFile = join(root, 'result.json')
    const env: Record<string, string | undefined> = { ...process.env, ROOT: root, OUT: resultFile, BUDGET_MS: '150000' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn('nice', ['-n', '10', xvfb!, '-a', dbus!, '--', electronBin!, '--no-sandbox', join(root, 'main.cjs')], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let log = ''
    child.stderr?.on('data', (d: Buffer) => void (log = (log + d.toString()).slice(-20_000)))
    try {
      // Chromium on the box can abort at quit (a D-Bus FATAL): judge by the results file, not the exit code.
      await new Promise<void>((done) => {
        const kill = setTimeout(done, 170_000)
        const poll = setInterval(() => {
          if (existsSync(resultFile)) {
            clearInterval(poll)
            clearTimeout(kill)
            done()
          }
        }, 250)
        child.on('exit', () => setTimeout(() => (clearInterval(poll), clearTimeout(kill), done()), 500))
      })
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    expect(existsSync(resultFile), `no results from Electron:\n${log.slice(-4000)}`).toBe(true)
    const result = JSON.parse(readFileSync(resultFile, 'utf8')) as { ua: string; fatal?: string; clips: Record<string, ClipResult> }
    expect(result.fatal, log.slice(-4000)).toBeUndefined()

    // d. 16 of 16 everywhere it plays; the original ProRes does not play in the viewer
    const table = Object.entries(result.clips).map(([name, c]) => ({
      name,
      error: c.error,
      wrong: c.rows?.filter((r) => r.shown !== r.n).map((r) => `${r.n}→${r.shown}`),
      reportedWrong: c.rows?.filter((r) => r.reported !== r.n).length,
      startWrong: c.start?.filter((r) => r.shown !== r.n).length,
      play: c.play
    }))
    console.log(`[frame accuracy] ${result.ua}; HLS starts ${shift.toFixed(6)} s after its source\n${JSON.stringify(table, null, 1)}`)
    if (process.env.TC_FRAME_ACCURACY_OUT) writeFileSync(process.env.TC_FRAME_ACCURACY_OUT, JSON.stringify(result, null, 1))
    expect(result.clips['prores-original'].errorCode).toBe(4)
    for (const name of ['h264', 'vp9', 'av1', 'prores-proxy', 'hls']) {
      const c = result.clips[name]
      expect(c.error, name).toBeUndefined()
      expect(c.rows!.length, name).toBe(16)
      expect(c.rows!.filter((r) => r.shown === r.n).length, `${name}: ${JSON.stringify(c.rows)}`).toBe(16)
      expect(c.rows!.filter((r) => r.reported === r.n).length, `${name} reported`).toBe(16)
    }
  })
})

/** The page: per clip, the 16 seeks by `seekToFrame` read back from the pixels, then the frame-start control. */
const PAGE_TS = String.raw`
import { frameStart } from "@SHARED@/contract-work-media";
import { seekToFrame, watchFrames } from "@MEDIA@/seek";
import { attachSegments } from "@MEDIA@/segments";

const v = document.getElementById("v") as HTMLVideoElement;
const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
const stage = (s: string) => fetch("/stage", { method: "POST", body: s });

/** The frame number from the 12 boxes across the top. */
function readBar(): number {
  const w = v.videoWidth, h = v.videoHeight, box = w / 16;
  canvas.width = w; canvas.height = h;
  ctx.drawImage(v, 0, 0, w, h);
  let n = 0;
  for (let k = 0; k < 12; k++) {
    const d = ctx.getImageData(Math.floor((k + 0.5) * box), Math.floor(box / 2), 1, 1).data;
    if (d[0] + d[1] + d[2] > 384) n |= 1 << k;
  }
  return n;
}

const once = (ev: string, ms: number) => new Promise<Event>((res, rej) => {
  const t = setTimeout(() => rej(new Error("no " + ev + " in " + ms + " ms")), ms);
  v.addEventListener(ev, (e) => { clearTimeout(t); res(e); }, { once: true });
});
async function loaded(): Promise<string | null> {
  try {
    await Promise.race([once("loadeddata", 20000), once("error", 20000).then(() => { throw new Error("media error " + v.error?.code); })]);
    return null;
  } catch (e) { return String((e as Error).message); }
}

async function startSeek(t: number): Promise<number> {
  const frame = new Promise<void>((r) => { const id = setTimeout(r, 500); v.requestVideoFrameCallback(() => { clearTimeout(id); r(); }); });
  const s = once("seeked", 10000);
  v.currentTime = t;
  await s; await frame;
  return readBar();
}

async function run() {
  const { clips } = await (await fetch("/config.json")).json();
  const out: Record<string, unknown> = {};
  for (const c of clips) {
    await stage(c.name);
    const r: Record<string, unknown> = {};
    out[c.name] = r;
    v.removeAttribute("src"); v.load();
    let feed: { destroy(): void } | null = null;
    if (c.hls) {
      const f = attachSegments(v, { init: c.hls.init, segments: c.hls.segments.slice(0, 1), ended: false, mime: c.hls.mime }, async (k) => (await fetch(k === "init" ? c.hls.init : c.hls.files[k])).arrayBuffer());
      feed = f;
      const err = await loaded();
      if (err) { r.error = err; f.destroy(); continue; }
      f.update(c.hls.segments, true);
    } else {
      v.src = c.url;
      const err = await loaded();
      if (err) { r.error = err; r.errorCode = v.error?.code; continue; }
      if (c.unplayable) { r.error = "it played"; continue; }
    }
    const rows = [];
    for (const n of c.targets) {
      const reported = await seekToFrame(v, c.table, n);
      rows.push({ n, reported, shown: readBar() });
    }
    r.rows = rows;
    // one second of play: does each frame callback name the frame on screen?
    await seekToFrame(v, c.table, 0);
    let callbacks = 0, wrong = 0;
    const stop = watchFrames(v, c.table, (n) => { callbacks++; if (readBar() !== n) wrong++; });
    await v.play().catch(() => {});
    await new Promise((res) => setTimeout(res, 1000));
    v.pause(); stop();
    r.play = { callbacks, wrong };
    const start = [];
    for (const n of c.targets) start.push({ n, shown: await startSeek(frameStart(c.table, n)) });
    r.start = start;
    feed?.destroy();
  }
  return out;
}

run().then(
  (clips) => fetch("/result", { method: "POST", body: JSON.stringify({ ua: navigator.userAgent, clips }) }),
  (e) => fetch("/result", { method: "POST", body: JSON.stringify({ ua: navigator.userAgent, fatal: String(e?.stack ?? e), clips: {} }) })
);
`

/** Electron's main: a Range-capable server over the temp dir, one window, the page's results written before quitting. */
const MAIN_CJS = String.raw`
const { app, BrowserWindow } = require("electron");
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const ROOT = process.env.ROOT, OUT = process.env.OUT;
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.disableHardwareAcceleration();
let stage = "start";
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4s": "video/iso.segment" };
const finish = (body) => { fs.writeFileSync(OUT + ".tmp", body); fs.renameSync(OUT + ".tmp", OUT); setTimeout(() => app.exit(0), 100); };
const server = http.createServer((req, res) => {
  if (req.method === "POST") {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", () => { res.end(); if (req.url === "/stage") stage = body; else finish(body); });
    return;
  }
  const file = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  const size = fs.statSync(file).size, type = types[path.extname(file)] || "application/octet-stream";
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (m) {
    const start = m[1] ? +m[1] : size - +m[2], end = m[1] && m[2] ? +m[2] : size - 1;
    res.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": "bytes " + start + "-" + end + "/" + size, "Content-Length": end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": size });
    fs.createReadStream(file).pipe(res);
  }
});
app.whenReady().then(() => server.listen(0, "127.0.0.1", () => {
  setTimeout(() => finish(JSON.stringify({ ua: "", fatal: "timed out at " + stage, clips: {} })), +process.env.BUDGET_MS || 150000);
  const w = new BrowserWindow({ show: true, width: 700, height: 420, webPreferences: { backgroundThrottling: false } });
  w.webContents.on("console-message", (e) => console.error("[page]", e.message));
  w.loadURL("http://127.0.0.1:" + server.address().port + "/index.html");
}));
`
