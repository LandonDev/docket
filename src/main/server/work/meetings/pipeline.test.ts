import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { convertersOf, JobRunner } from '../formats/jobs'
import { Toolchain, type ToolchainState } from '../formats/tools'
import { EventLines, meetingConverters, meetingThreads, meetingTimeoutMs, missingSentence, NOT_CARRIED, runTranscriber } from './pipeline'
import { MEDIA_EXTS, MEETING_FORMAT, type PipelineEvent } from './raw'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A userData whose state.json says these tools are installed, each with a file on disk. */
function userData(tools: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'tc-meetings-'))
  dirs.push(dir)
  const state: ToolchainState = { platform: 'linux-x64', at: 1, tools: {} }
  for (const name of tools) {
    mkdirSync(join(dir, 'work-tools', name, '1'), { recursive: true })
    writeFileSync(join(dir, 'work-tools', name, '1', 'bin'), '')
    writeFileSync(join(dir, 'work-tools', name, '1', 'ffprobe'), '')
    state.tools[name] = { name, pillar: 'meetings', version: '1', licence: 'MIT', licenceNote: 'test', ok: true, dir: `${name}/1`, bin: 'bin', bins: { ffprobe: 'ffprobe' }, at: 1 }
  }
  writeFileSync(join(dir, 'work-tools', 'state.json'), JSON.stringify(state))
  return dir
}

const blockOk = async (): Promise<{ ok: true; how: string }> => ({ ok: true, how: 'test' })

describe('the meeting converters', () => {
  it('one per recording format, each to tcmeeting, needing sherpa-onnx', () => {
    const cs = meetingConverters()
    expect(cs.map((c) => c.from)).toEqual([...MEDIA_EXTS])
    for (const c of cs) {
      expect(c.to).toBe(MEETING_FORMAT)
      expect(c.needs).toBe('sherpa-onnx')
      expect(c.threads).toBeLessThanOrEqual(16)
    }
  })

  it('a job another host forwarded is refused, through the real serveForwarded', async () => {
    const dataDir = userData(['sherpa-onnx'])
    const runner = new JobRunner({ host: 'test', dataDir, converters: convertersOf([{ id: 'meetings', ensure() {}, convert: meetingConverters({ networkBlock: blockOk }) }]), log: () => {} })
    await expect(runner.serveForwarded({ from: 'wav', to: MEETING_FORMAT, name: 'm.wav', data: Buffer.from('RIFF').toString('base64') })).rejects.toThrow(NOT_CARRIED)
  })

  it('names each missing tool in a sentence', async () => {
    expect(missingSentence(['parakeet-tdt-v2'])).toBe('parakeet-tdt-v2 is not installed on this host; run scripts/work-tools/install.ts.')
    expect(missingSentence(['ffmpeg', 'silero-vad', 'parakeet-tdt-v2'])).toBe('ffmpeg, silero-vad and parakeet-tdt-v2 are not installed on this host; run scripts/work-tools/install.ts.')
    const dataDir = userData(['sherpa-onnx', 'ffmpeg', 'pyannote-segmentation', 'wespeaker-resnet34-lm'])
    const [c] = meetingConverters({ networkBlock: blockOk })
    const fake = { tools: new Toolchain(dataDir), threads: 2, slot: 0, tmp: dataDir, signal: new AbortController().signal, run: async () => ({ code: 0, out: '' }) }
    await expect(c.run({ from: 'wav', to: MEETING_FORMAT, input: join(dataDir, 'a.wav'), output: join(dataDir, 'o') }, fake)).rejects.toThrow('parakeet-tdt-v2 and silero-vad are not installed on this host; run scripts/work-tools/install.ts.')
  })

  it('threads: half the cores less one, at least 2, never above 16', () => {
    expect(meetingThreads(32)).toBe(15)
    expect(meetingThreads(14)).toBe(6)
    expect(meetingThreads(8)).toBe(3)
    expect(meetingThreads(2)).toBe(2)
    expect(meetingThreads(1)).toBe(2)
    expect(meetingThreads(128)).toBe(16)
  })

  it('the default limit: 20 minutes plus half the length, at most 6 hours', () => {
    expect(meetingTimeoutMs(600)).toBe(25 * 60_000)
    expect(meetingTimeoutMs(100_000)).toBe(6 * 60 * 60_000)
    expect(meetingTimeoutMs(null)).toBe(6 * 60 * 60_000)
  })
})

describe('the event stream', () => {
  it('reads events split across chunks and skips junk', () => {
    const got: PipelineEvent[] = []
    const junk: string[] = []
    let fail = ''
    const lines = new EventLines((e) => got.push(e), (s) => (fail = s), (l) => junk.push(l))
    lines.push('{"event":"start","durationSec":3,"med')
    lines.push('ia":"audio"}\nnot json\n{"other":1}\n')
    lines.push('{"event":"peaks","peaks":[0,1]}\n{"event":"words","uptoSec":2,"words":[{"w":"hi","s":0,"e":0.4}]}')
    expect(got.map((e) => e.event)).toEqual(['start', 'peaks'])
    lines.push('\n{"fail":"the speaker models did not load"}')
    lines.end()
    expect(got.map((e) => e.event)).toEqual(['start', 'peaks', 'words'])
    expect(junk).toEqual(['not json', '{"other":1}'])
    expect(fail).toBe('the speaker models did not load')
  })
})

describe('the transcriber child', () => {
  it('an abort kills its whole process group', async () => {
    // A stand-in: says start, leaves a grandchild in its group, then waits.
    const script = `const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(JSON.stringify({ event: 'start', durationSec: 1, media: 'audio', grandchild: g.pid })); setInterval(() => {}, 1000)`
    const ctl = new AbortController()
    let grandchild = 0
    const done = runTranscriber({
      cmd: process.execPath,
      args: ['-e', script],
      env: { PATH: process.env.PATH ?? '' },
      signal: ctl.signal,
      timeoutMs: 60_000,
      onEvent: (e) => {
        grandchild = (e as unknown as { grandchild: number }).grandchild
        ctl.abort()
      }
    })
    await expect(done).rejects.toThrow('cancelled')
    expect(grandchild).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 200))
    expect(() => process.kill(grandchild, 0)).toThrow()
  }, 20_000)

  it('a timeout stops it with a sentence', async () => {
    const done = runTranscriber({ cmd: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: { PATH: process.env.PATH ?? '' }, signal: new AbortController().signal, timeoutMs: 300, onEvent: () => {} })
    await expect(done).rejects.toThrow(/took longer than \d+ minutes and was stopped/)
  })
})
