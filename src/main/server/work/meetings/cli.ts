#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertersOf, JobRunner } from '../formats/jobs'
import { blockHow, networkBlock, noNetwork } from './egress'
import { onPipelineEvents } from './events'
import { meetingConverters, meetingThreads } from './pipeline'
import { MEETING_FORMAT, type RawTranscript } from './raw'

/**
 * The transcriber on a host, outside the app: the pipeline's proof
 * (docs/agents/work-meetings.md, "The pipeline").
 *
 *   bun src/main/server/work/meetings/cli.ts --data <userData> [--threads n] [--audio-out file.m4a] [--out transcript.json] <recording>
 *   bun src/main/server/work/meetings/cli.ts --egress-check
 *
 * Progress goes to stderr, a JSON summary to stdout; `--out` keeps the
 * RawTranscript itself. `--egress-check` runs a
 * child that tries to reach a listener on 127.0.0.1 and 1.1.1.1:443, inside
 * the block and without it. Bundles with `bun build … --target=bun`.
 */
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const r1 = (n: number): number => Math.round(n * 10) / 10
const load = (): number[] => loadavg().map((n) => Math.round(n * 100) / 100)

/** A child that tries both addresses and prints what happened to each. */
const PROBE = `
const net = require('node:net')
const tryOne = (host, port) => new Promise((done) => {
  const s = net.connect({ host, port })
  const t = setTimeout(() => { s.destroy(); done('timed out') }, 4000)
  s.on('connect', () => { clearTimeout(t); s.end(); done('connected') })
  s.on('error', (e) => { clearTimeout(t); done(e.code || e.message) })
})
Promise.all([tryOne('127.0.0.1', Number(process.argv.at(-1))), tryOne('1.1.1.1', 443)]).then(([local, remote]) => console.log(JSON.stringify({ local, remote })))
`

function child(cmd: string, args: string[]): Promise<{ local: string; remote: string } | { error: string }> {
  return new Promise((resolve) => {
    let out = ''
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    c.stdout.on('data', (d: Buffer) => (out += d.toString()))
    c.stderr.on('data', (d: Buffer) => (out += d.toString()))
    c.on('error', (e) => resolve({ error: e.message }))
    c.on('close', () => {
      try {
        resolve(JSON.parse(out.trim().split('\n').at(-1) ?? ''))
      } catch {
        resolve({ error: out.trim().slice(-300) })
      }
    })
  })
}

async function egressCheck(): Promise<number> {
  let seen = 0
  const server = createServer((s) => {
    seen++
    s.destroy()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  const args = ['-e', PROBE, String(port)]
  try {
    const wrapped = noNetwork(process.execPath, args)
    const block = await networkBlock()
    const inside = wrapped ? await child(wrapped.cmd, wrapped.args) : { error: 'no block on this host' }
    const seenInside = seen
    const outside = await child(process.execPath, args)
    const ok = 'local' in inside && inside.local !== 'connected' && inside.remote !== 'connected' && seenInside === 0 && 'local' in outside && outside.local === 'connected'
    console.log(JSON.stringify({ ok, platform: `${process.platform}-${process.arch}`, how: blockHow(), block, inside, listenerSawInside: seenInside, outside, listenerSawOutside: seen - seenInside }, null, 2))
    return ok ? 0 : 1
  } finally {
    server.close()
  }
}

async function transcribeOne(): Promise<number> {
  const dataDir = arg('--data') ?? process.env.TEMP_CODE_USER_DATA
  const input = process.argv.at(-1)
  if (!dataDir || !input || input.startsWith('--') || input === dataDir) {
    console.error('usage: cli.ts --data <userData> [--threads n] [--audio-out file.m4a] [--out transcript.json] <recording> | cli.ts --egress-check')
    return 2
  }
  const threads = Number(arg('--threads') ?? meetingThreads())
  const audioOut = arg('--audio-out')
  const ext = input.split('.').pop()!.toLowerCase()
  const runner = new JobRunner({
    host: 'cli',
    dataDir,
    caps: { jobs: 1, threads },
    converters: convertersOf([{ id: 'meetings', ensure() {}, convert: meetingConverters({ threads }) }]),
    log: (l) => console.error(l)
  })
  const token = `cli-${process.pid}`
  const started = Date.now()
  const stages: Record<string, number> = {}
  let last = started
  const off = onPipelineEvents(token, (e) => {
    const now = Date.now()
    if (!(e.event in stages)) stages[e.event] = r1((now - started) / 1000)
    if (e.event === 'speakers') process.stderr.write(`\rspeakers ${e.done}/${e.total}   `)
    else if (e.event === 'words') process.stderr.write(`\rwords up to ${Math.round(e.uptoSec)} s   `)
    else process.stderr.write(`${now - last > 0 ? '\n' : ''}${e.event}${e.event === 'start' ? ` ${r1(e.durationSec)} s ${e.media}` : e.event === 'turns' ? ` ${e.turns.length} turns, ${Object.keys(e.voices).length} voices` : ''}\n`)
    last = now
  })
  const loadBefore = load()
  const scratch = mkdtempSync(join(tmpdir(), 'tc-meeting-'))
  const output = arg('--out') ?? join(scratch, `out.${MEETING_FORMAT}`)
  try {
    const block = await networkBlock()
    await runner.convert({ from: ext, to: MEETING_FORMAT, input, output, here: true, signal: stop.signal, options: { progress: token, ...(audioOut ? { audioOut } : {}) } })
    process.stderr.write('\n')
    const t = JSON.parse(readFileSync(output, 'utf8')) as RawTranscript
    console.log(
      JSON.stringify(
        {
          ok: true,
          input,
          durationSec: r1(t.durationSec),
          media: t.media,
          words: t.words.length,
          turns: t.turns.length,
          speakers: new Set(t.turns.map((x) => x.speaker)).size,
          voices: Object.keys(t.voices).length,
          timings: t.timings,
          wallSec: r1((Date.now() - started) / 1000),
          firstEventAtSec: stages,
          threads: t.timings.threads,
          loadBefore,
          loadAfter: load(),
          networkBlocked: block.ok,
          how: block.ok ? block.how : block.why,
          engine: t.engine,
          ...(audioOut ? { audioOut } : {}),
          text: t.words.slice(0, 40).map((w) => w.w).join(' ')
        },
        null,
        2
      )
    )
    return 0
  } catch (err) {
    process.stderr.write('\n')
    console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), loadBefore, loadAfter: load() }))
    return 1
  } finally {
    off()
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Ctrl-C stops the job, and with it the transcriber's process group (it runs detached). */
const stop = new AbortController()

if (import.meta.main) {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => stop.abort())
  process.exit(process.argv.includes('--egress-check') ? await egressCheck() : await transcribeOne())
}
