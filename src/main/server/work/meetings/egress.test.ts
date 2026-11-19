import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Toolchain } from '../formats/tools'
import { noNetwork } from './egress'
import { onPipelineEvents } from './events'
import { meetingConverters, TRANSCRIBER_PY } from './pipeline'
import type { PipelineEvent, RawTranscript } from './raw'

const CONNECT = `const s = require('node:net').connect({ host: '127.0.0.1', port: Number(process.argv.at(-1)) }); s.on('connect', () => { console.log('connected'); s.end() }); s.on('error', (e) => console.log('refused', e.code)); setTimeout(() => process.exit(0), 4000).unref()`

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    c.stdout.on('data', (d: Buffer) => (out += d.toString()))
    c.stderr.on('data', (d: Buffer) => (out += d.toString()))
    c.on('close', () => resolve(out))
  })
}

const blockable = process.platform === 'linux' || process.platform === 'darwin'

describe('the network block', () => {
  it('a child inside it cannot reach a listener on 127.0.0.1; the same child outside it can', async () => {
    if (!blockable) {
      expect(noNetwork(process.execPath, [])).toBeNull()
      return
    }
    let seen = 0
    const server = createServer((s) => {
      seen++
      s.destroy()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      const args = ['-e', CONNECT, String((server.address() as AddressInfo).port)]
      const w = noNetwork(process.execPath, args)
      expect(w).not.toBeNull()
      const inside = await run(w!.cmd, w!.args)
      expect(inside).not.toMatch(/connected/)
      expect(seen).toBe(0)
      const outside = await run(process.execPath, args)
      expect(outside).toMatch(/connected/)
      expect(seen).toBe(1)
    } finally {
      server.close()
    }
  }, 20_000)

  it('there is no block on a platform without one', () => {
    expect(noNetwork('x', [], { platform: 'win32' })).toBeNull()
    expect(noNetwork('x', [], { platform: 'linux', exists: () => false })).toBeNull()
    expect(noNetwork('py', ['-I'], { platform: 'linux', exists: () => true })).toEqual({ cmd: '/usr/bin/unshare', args: ['-r', '-n', '--', 'py', '-I'] })
    expect(noNetwork('py', [], { platform: 'darwin', exists: () => true })?.cmd).toBe('/usr/bin/sandbox-exec')
  })

  it('a transcription refuses to run when the block is not there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-egress-'))
    try {
      const [c] = meetingConverters({ networkBlock: async () => ({ ok: false, why: 'no namespaces here' }) })
      const fake = { tools: new Toolchain(dir), threads: 2, slot: 0, tmp: dir, signal: new AbortController().signal, run: async () => ({ code: 0, out: '' }) }
      await expect(c.run({ from: 'wav', to: 'tcmeeting', input: join(dir, 'a.wav'), output: join(dir, 'o') }, fake)).rejects.toThrow(/cannot run a transcription with the network blocked: no namespaces here/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the transcriber imports no network module', () => {
    expect(TRANSCRIBER_PY).not.toMatch(/\b(socket|urllib|http\.client|http|requests|ssl|ftplib|smtplib)\b/)
    const imports = [...TRANSCRIBER_PY.matchAll(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/gm)].map((m) => m[1].split('.')[0])
    expect(new Set(imports)).toEqual(new Set(['json', 'sys', 'time', 'numpy', 'sherpa_onnx']))
    expect(TRANSCRIBER_PY).not.toMatch(/__import__|importlib|subprocess|\bexec\(|\beval\(/)
  })
})

// The real thing, on a host whose tools are installed: TEMP_CODE_WORK_TOOLS_DATA names its userData.
const data = process.env.TEMP_CODE_WORK_TOOLS_DATA
const audio = process.env.TEMP_CODE_MEETING_AUDIO
const fixture = join(import.meta.dirname, 'fixtures', 'two-speakers.ogg')
const linux = process.platform === 'linux'

/** Every process under this one, with its command line and network namespace (Linux /proc). */
function descendants(root: number): { pid: number; cmd: string; net: string }[] {
  const out: { pid: number; cmd: string; net: string }[] = []
  const walk = (pid: number): void => {
    let tasks: string[] = []
    try {
      tasks = readdirSync(`/proc/${pid}/task`)
    } catch {
      return
    }
    for (const tid of tasks) {
      let kids: string[] = []
      try {
        kids = readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)
      } catch {
        continue
      }
      for (const k of kids) {
        const kid = Number(k)
        try {
          out.push({ pid: kid, cmd: readFileSync(`/proc/${kid}/cmdline`, 'utf8').split('\0').join(' ').trim(), net: readlinkSync(`/proc/${kid}/ns/net`) })
        } catch {
          continue
        }
        walk(kid)
      }
    }
  }
  walk(root)
  return out
}

async function realRunner(): Promise<{ runner: import('../formats/jobs').JobRunner }> {
  const { JobRunner, convertersOf } = await import('../formats/jobs')
  return { runner: new JobRunner({ host: 'test', dataDir: data!, caps: { jobs: 1, threads: 16 }, converters: convertersOf([{ id: 'meetings', ensure() {}, convert: meetingConverters() }]), log: () => {} }) }
}

describe.skipIf(!data || !new Toolchain(data ?? '/nonexistent').has('parakeet-tdt-v2'))('a real transcription inside the block', () => {
  let out = ''
  afterAll(() => out && rmSync(out, { recursive: true, force: true }))

  it(`${audio ? 'TEMP_CODE_MEETING_AUDIO' : 'the fixture'} runs to the end with words and speakers, events in order, every child it starts cut off from the network`, async () => {
    const { runner } = await realRunner()
    out = mkdtempSync(join(tmpdir(), 'tc-egress-real-'))
    const input = audio ?? fixture
    const events: PipelineEvent['event'][] = []
    const off = onPipelineEvents('egress-test', (e) => events.push(e.event))
    // Watch every process the job starts, as it runs: none may share this process's network.
    const ours = linux ? readlinkSync('/proc/self/ns/net') : ''
    const seen: { pid: number; cmd: string; net: string }[] = []
    const watch = linux ? setInterval(() => seen.push(...descendants(process.pid)), 50) : null
    try {
      const output = join(out, 'out.tcmeeting')
      await runner.convert({ from: input.split('.').pop()!, to: 'tcmeeting', input, output, here: true, options: { progress: 'egress-test', audioOut: join(out, 'play.m4a') } })
      const t = JSON.parse(readFileSync(output, 'utf8')) as RawTranscript
      expect(t.words.length).toBeGreaterThan(10)
      expect(t.turns.length).toBeGreaterThan(0)
      expect(new Set(t.turns.map((x) => x.speaker)).size).toBeGreaterThanOrEqual(2)
      expect(t.peaks).toHaveLength(400)
      expect(existsSync(join(out, 'play.m4a'))).toBe(true)
      const rank = { start: 0, peaks: 1, speakers: 2, turns: 3, words: 4 }
      expect(events.slice(0, 2)).toEqual(['start', 'peaks'])
      expect(events.map((e) => rank[e])).toEqual([...events.map((e) => rank[e])].sort((a, b) => a - b))
      expect(events.filter((e) => e === 'turns')).toHaveLength(1)
      if (linux) {
        // unshare is the only thing that runs in our namespace, for the instant before it makes its own and execs.
        const work = seen.filter((p) => !p.cmd.startsWith('/usr/bin/unshare '))
        expect(work.some((p) => p.cmd.includes('transcribe.py'))).toBe(true)
        expect(work.some((p) => /ffmpeg/.test(p.cmd))).toBe(true)
        expect(work.filter((p) => p.net === ours)).toEqual([])
      }
    } finally {
      if (watch) clearInterval(watch)
      off()
    }
  }, 30 * 60_000)

  it.skipIf(!linux)("the whole transcription, the app's code and every child, finishes with no network at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-egress-cli-'))
    try {
      const json = join(dir, 't.json')
      const cli = join(import.meta.dirname, 'cli.ts')
      const said = await run('/usr/bin/unshare', ['-r', '-n', '--', 'bun', cli, '--data', data!, '--threads', '4', '--out', json, fixture])
      const t = JSON.parse(readFileSync(json, 'utf8')) as RawTranscript
      expect(t.words.length, said.slice(-800)).toBeGreaterThan(10)
      expect(new Set(t.turns.map((x) => x.speaker)).size).toBeGreaterThanOrEqual(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10 * 60_000)

  it('a file that names other files (an ffconcat list called .wav) is refused before anything is read', async () => {
    const { runner } = await realRunner()
    const dir = mkdtempSync(join(tmpdir(), 'tc-egress-concat-'))
    try {
      copyFileSync(fixture, join(dir, 'beside.ogg'))
      writeFileSync(join(dir, 'list.wav'), 'ffconcat version 1.0\nfile beside.ogg\n')
      await expect(runner.convert({ from: 'wav', to: 'tcmeeting', input: join(dir, 'list.wav'), output: join(dir, 'o.tcmeeting'), here: true })).rejects.toThrow(/could not read this file as a recording/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
