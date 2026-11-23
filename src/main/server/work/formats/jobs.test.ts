import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkModule } from '../modules'
import { LIBREOFFICE_CONVERTERS, libreOffice } from '.'
import type { Readiness } from '@shared/contract-work-formats'
import { convertersOf, defaultCaps, extOf, JobRunner, NoConverterError, NotReadyError, pressed, pressOf, type ConvertJob, type Converter, type LinkedHost } from './jobs'
import { MCP_CEILING } from '../../remote/auth'
import { statePath, type ToolchainState } from './tools'

/**
 * The job runner: the registry by pair, the caps, the route to a linked
 * host when the tool is not here, and the far side's answer. Two runners
 * stand for two hosts; the link between them carries JSON, as the wire does.
 */
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-work-jobs-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A host's userData whose state.json names `tools` as installed, each with a real file for its bin. */
function host(name: string, tools: string[] = []): string {
  const dataDir = join(root, name)
  const state: ToolchainState = { platform: 'linux-x64', at: 1, tools: {} }
  for (const t of tools) {
    mkdirSync(join(dataDir, 'work-tools', t, '1.0'), { recursive: true })
    writeFileSync(join(dataDir, 'work-tools', t, '1.0', 'run'), '#!/bin/sh\n')
    chmodSync(join(dataDir, 'work-tools', t, '1.0', 'run'), 0o755)
    state.tools[t] = { name: t, pillar: 'toolchain', version: '1.0', licence: 'MIT', licenceNote: 'test', ok: true, dir: join(t, '1.0'), bin: 'run', at: 1 }
  }
  mkdirSync(join(dataDir, 'work-tools'), { recursive: true })
  writeFileSync(statePath(dataDir), JSON.stringify(state))
  return dataDir
}

/** A converter that upper-cases text, after `hold` resolves. */
function upper(from: string, to: string, needs?: string, extra: Partial<Converter> & { hold?: () => Promise<void>; seen?: number[] } = {}): Converter {
  return {
    from,
    to,
    ...(needs ? { needs } : {}),
    ...extra,
    async run(job, run) {
      extra.seen?.push(run.threads)
      await extra.hold?.()
      writeFileSync(job.output, readFileSync(job.input, 'utf8').toUpperCase())
      return { warnings: [`ran in slot ${run.slot}`] }
    }
  }
}

const mod = (id: string, convert: Converter[]): WorkModule => ({ id: id as WorkModule['id'], ensure() {}, convert })

/** A link from one runner to another, every request and reply passed through JSON. */
function link(id: string, far: JobRunner, calls: string[] = []): LinkedHost {
  return {
    id,
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push(method)
      const wire = JSON.parse(JSON.stringify(params ?? {}))
      const answer = method === 'work.formats.tools' ? await far.report() : method === 'work.formats.convert' ? await far.serveForwarded(wire) : null
      if (answer === null) throw new Error(`unknown method ${method}`)
      return JSON.parse(JSON.stringify(answer)) as T
    }
  }
}

function input(text = 'hello'): string {
  const p = join(root, `in-${Math.random().toString(36).slice(2)}.txt`)
  writeFileSync(p, text)
  return p
}

describe('the converter registry', () => {
  it("collects every module's converters by pair and refuses a second for the same pair", () => {
    const lines: string[] = []
    const first = upper('txt', 'md')
    const reg = convertersOf([mod('formats', [first]), mod('media', [upper('TXT', '.md'), upper('wav', 'mp3')])], (l) => lines.push(l))
    expect([...reg.keys()]).toEqual(['txt→md', 'wav→mp3'])
    expect(reg.get('txt→md')).toBe(first)
    expect(lines).toEqual(['media: a second converter for txt→md refused'])
  })

  it('the toolchain registers LibreOffice within each family and to PDF', () => {
    const reg = convertersOf([mod('formats', LIBREOFFICE_CONVERTERS)])
    for (const pair of ['odt→docx', 'docx→odt', 'rtf→docx', 'docx→pdf', 'pptx→pdf', 'odp→pptx', 'xlsx→ods', 'csv→xlsx']) expect(reg.has(pair)).toBe(true)
    expect(reg.has('docx→xlsx')).toBe(false)
    expect([...reg.values()].every((c) => c.needs === 'libreoffice')).toBe(true)
  })

  it('sizes the caps from the cores', () => {
    expect(defaultCaps(32)).toEqual({ jobs: 4, threads: 16 })
    expect(defaultCaps(10)).toEqual({ jobs: 2, threads: 5 })
    expect(defaultCaps(1)).toEqual({ jobs: 1, threads: 1 })
  })
})

describe('a job on this host', () => {
  it('runs a converter whose tool is installed and writes the output where asked, or in its own folder', async () => {
    const runner = new JobRunner({ host: 'box', dataDir: host('box', ['upper']), converters: convertersOf([mod('formats', [upper('txt', 'md', 'upper')])]) })
    const out = join(root, 'out.md')
    const r = await runner.convert({ from: 'txt', to: 'md', input: input(), output: out })
    expect(r).toEqual({ output: out, ranOn: 'box', warnings: ['ran in slot 0'] })
    expect(readFileSync(out, 'utf8')).toBe('HELLO')
    const own = await runner.convert({ from: 'TXT', to: 'md', input: input('x') })
    expect(own.output).toMatch(/work-tools\/jobs\/[^/]+\/in-[a-z0-9]+\.md$/)
    expect(readFileSync(own.output, 'utf8')).toBe('X')
  })

  it('says plainly when no converter exists, and when the tool is not here and nothing is linked', async () => {
    const runner = new JobRunner({ host: 'mac', dataDir: host('mac'), converters: convertersOf([mod('formats', [upper('txt', 'md', 'upper')])]) })
    await expect(runner.convert({ from: 'wav', to: 'md', input: input() })).rejects.toThrow('no converter from wav to md')
    await expect(runner.convert({ from: 'txt', to: 'md', input: input() })).rejects.toThrow(new NoConverterError('upper is not installed on mac, and no linked host converts txt to md'))
  })

  it('holds jobs past the job cap and the thread cap, in order, and gives each its own slot', async () => {
    const releases: (() => void)[] = []
    const hold = (): Promise<void> => new Promise((r) => releases.push(r))
    const seen: number[] = []
    const runner = new JobRunner({
      host: 'box',
      dataDir: host('box', ['upper']),
      caps: { jobs: 2, threads: 4 },
      converters: convertersOf([mod('formats', [upper('txt', 'md', 'upper', { hold, seen }), upper('wav', 'txt', 'upper', { hold, seen, threads: 3 }), upper('srt', 'txt', 'upper', { hold, seen, threads: 64 })])])
    })
    const a = runner.convert({ from: 'txt', to: 'md', input: input('a') })
    const b = runner.convert({ from: 'wav', to: 'txt', input: input('b') })
    const c = runner.convert({ from: 'txt', to: 'md', input: input('c') })
    await new Promise((r) => setTimeout(r, 20))
    expect(runner.queue()).toEqual({ cap: { jobs: 2, threads: 4 }, running: 2, queued: 1 })
    releases.shift()!()
    expect((await a).warnings).toEqual(['ran in slot 0'])
    await new Promise((r) => setTimeout(r, 20))
    // c takes the slot a left; b still holds 3 of 4 threads
    expect(runner.queue().running).toBe(2)
    releases.shift()!()
    releases.shift()!()
    expect((await b).warnings).toEqual(['ran in slot 1'])
    expect((await c).warnings).toEqual(['ran in slot 0'])
    // a job that asks for more threads than the cap gets the cap
    const d = runner.convert({ from: 'srt', to: 'txt', input: input('d') })
    await new Promise((r) => setTimeout(r, 20))
    releases.shift()!()
    await d
    expect(seen).toEqual([1, 3, 1, 4])
  })

  it('takes a cancelled job out of the queue, and cancels what waits when Work turns off', async () => {
    const releases: (() => void)[] = []
    const runner = new JobRunner({ host: 'box', dataDir: host('box', ['upper']), caps: { jobs: 1, threads: 1 }, converters: convertersOf([mod('formats', [upper('txt', 'md', 'upper', { hold: () => new Promise((r) => releases.push(r)) })])]) })
    const first = runner.convert({ from: 'txt', to: 'md', input: input() })
    const abort = new AbortController()
    const second = runner.convert({ from: 'txt', to: 'md', input: input(), signal: abort.signal })
    const third = runner.convert({ from: 'txt', to: 'md', input: input() })
    await new Promise((r) => setTimeout(r, 20))
    abort.abort()
    await expect(second).rejects.toThrow('cancelled')
    runner.cancelWaiting()
    await expect(third).rejects.toThrow('Work turned off')
    releases.shift()!()
    await first
  })

  it('gives the slot back when the job cannot even make its folder', async () => {
    const dataDir = host('box', ['upper'])
    const runner = new JobRunner({ host: 'box', dataDir, caps: { jobs: 1, threads: 1 }, converters: convertersOf([mod('formats', [upper('txt', 'md', 'upper')])]) })
    // a file where the jobs folder goes: the mkdir throws
    writeFileSync(join(dataDir, 'work-tools', 'jobs'), 'in the way')
    await expect(runner.convert({ from: 'txt', to: 'md', input: input() })).rejects.toThrow()
    await expect(runner.convert({ from: 'txt', to: 'md', input: input() })).rejects.toThrow()
    expect(runner.queue().running).toBe(0)
    rmSync(join(dataDir, 'work-tools', 'jobs'))
    expect(readFileSync((await runner.convert({ from: 'txt', to: 'md', input: input('ok') })).output, 'utf8')).toBe('OK')
  })

  it('kills a running job on its signal and frees its slot', async () => {
    const sleeper: Converter = {
      from: 'txt',
      to: 'md',
      needs: 'upper',
      async run(job, run) {
        const r = await run.run('sleep', ['30'])
        if (r.code !== 0) throw new Error(`sleep ended: ${r.code}`)
        writeFileSync(job.output, 'late')
        return {}
      }
    }
    const runner = new JobRunner({ host: 'box', dataDir: host('box', ['upper']), caps: { jobs: 1, threads: 1 }, converters: convertersOf([mod('formats', [sleeper])]) })
    const abort = new AbortController()
    const started = Date.now()
    const running = runner.convert({ from: 'txt', to: 'md', input: input(), signal: abort.signal })
    await new Promise((r) => setTimeout(r, 100))
    expect(runner.queue().running).toBe(1)
    abort.abort()
    await expect(running).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(runner.queue().running).toBe(0)
  })

  it('leaves no abort listener on a signal it is done with', async () => {
    const runner = new JobRunner({ host: 'box', dataDir: host('box', ['upper']), converters: convertersOf([mod('formats', [upper('txt', 'md', 'upper')])]) })
    const abort = new AbortController()
    let added = 0
    let removed = 0
    const add = abort.signal.addEventListener.bind(abort.signal)
    const remove = abort.signal.removeEventListener.bind(abort.signal)
    abort.signal.addEventListener = ((...a: Parameters<typeof add>) => (added++, add(...a))) as typeof add
    abort.signal.removeEventListener = ((...a: Parameters<typeof remove>) => (removed++, remove(...a))) as typeof remove
    for (let i = 0; i < 3; i++) await runner.convert({ from: 'txt', to: 'md', input: input(), signal: abort.signal })
    expect(added).toBe(removed)
  })

  it('sweeps job folders older than a day', () => {
    const dataDir = host('box')
    const runner = new JobRunner({ host: 'box', dataDir, converters: new Map() })
    const old = join(dataDir, 'work-tools', 'jobs', 'old')
    const fresh = join(dataDir, 'work-tools', 'jobs', 'fresh')
    mkdirSync(old, { recursive: true })
    mkdirSync(fresh, { recursive: true })
    const twoDaysAgo = (Date.now() - 2 * 86_400_000) / 1000
    utimesSync(old, twoDaysAgo, twoDaysAgo)
    runner.sweep()
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })
})

describe('a job this host lacks the tool for', () => {
  it('runs on the linked host that has it and comes back as a file here', async () => {
    const converters = convertersOf([mod('formats', [upper('txt', 'md', 'upper')])])
    const box = new JobRunner({ host: 'box', dataDir: host('box', ['upper']), converters })
    const calls: string[] = []
    const bare = new JobRunner({ host: 'mac', dataDir: host('bare'), converters, log: () => {}, links: () => [link('lifeless', new JobRunner({ host: 'lifeless', dataDir: host('lifeless'), converters })), link('box', box, calls)] })
    const out = join(root, 'back.md')
    const r = await bare.convert({ from: 'txt', to: 'md', input: input('across'), output: out })
    expect(r).toEqual({ output: out, ranOn: 'box', warnings: ['ran in slot 0'] })
    expect(readFileSync(out, 'utf8')).toBe('ACROSS')
    expect(calls).toEqual(['work.formats.tools', 'work.formats.convert'])
    // the far host's report is kept a minute: the next job asks it nothing first
    await bare.convert({ from: 'txt', to: 'md', input: input('again') })
    expect(calls).toEqual(['work.formats.tools', 'work.formats.convert', 'work.formats.convert'])
    // the far side leaves nothing behind
    expect(existsSync(join(root, 'box', 'work-tools', 'jobs'))).toBe(true)
    expect(readdirNames(join(root, 'box', 'work-tools', 'jobs'))).toEqual([])
  })

  it('refuses an output too big to carry back, rather than closing the link', async () => {
    const converters = convertersOf([mod('formats', [upper('txt', 'md', 'upper')])])
    const box = new JobRunner({ host: 'box', dataDir: host('box', ['upper']), converters, forwardMax: 10 })
    await expect(box.serveForwarded({ from: 'txt', to: 'md', name: 'a.txt', data: Buffer.from('short').toString('base64') })).resolves.toMatchObject({ ranOn: 'box' })
    await expect(box.serveForwarded({ from: 'txt', to: 'md', name: 'a.txt', data: Buffer.from('0123456789').toString('base64') })).resolves.toMatchObject({ ranOn: 'box' })
    const bigger = new JobRunner({ host: 'box', dataDir: host('box2', ['upper']), converters: convertersOf([mod('formats', [{ ...upper('txt', 'md', 'upper'), run: async (job) => (writeFileSync(job.output, 'x'.repeat(11)), {}) }])]), forwardMax: 10 })
    await expect(bigger.serveForwarded({ from: 'txt', to: 'md', name: 'a.txt', data: Buffer.from('x').toString('base64') })).rejects.toThrow(/a job carried back to another host takes at most/)
  })

  it('stops waiting on a forwarded job when it is cancelled, and asks a silent host again only after a minute', async () => {
    const converters = convertersOf([mod('formats', [upper('txt', 'md', 'upper')])])
    const calls: string[] = []
    const hung: LinkedHost = {
      id: 'box',
      request: <T,>(method: string) => {
        calls.push(method)
        return (method === 'work.formats.tools' ? Promise.resolve({ converts: [{ from: 'txt', to: 'md' }] }) : new Promise(() => {})) as Promise<T>
      }
    }
    const silent: LinkedHost = {
      id: 'quiet',
      request: <T,>(method: string) => {
        calls.push(`quiet:${method}`)
        return Promise.reject(new Error('timed out')) as Promise<T>
      }
    }
    const mac = new JobRunner({ host: 'mac', dataDir: host('mac'), converters, log: () => {}, links: () => [silent, hung] })
    const abort = new AbortController()
    const job = mac.convert({ from: 'txt', to: 'md', input: input(), signal: abort.signal })
    await new Promise((r) => setTimeout(r, 20))
    abort.abort()
    await expect(job).rejects.toThrow('cancelled')
    const again = new AbortController()
    const second = mac.convert({ from: 'txt', to: 'md', input: input(), signal: again.signal })
    await new Promise((r) => setTimeout(r, 20))
    again.abort()
    await expect(second).rejects.toThrow('cancelled')
    expect(calls).toEqual(['quiet:work.formats.tools', 'work.formats.tools', 'work.formats.convert', 'work.formats.convert'])
  })

  it('never forwards a job a host took from another', async () => {
    const converters = convertersOf([mod('formats', [upper('txt', 'md', 'upper')])])
    const box = new JobRunner({ host: 'box', dataDir: host('box', ['upper']), converters })
    const mac = new JobRunner({ host: 'mac', dataDir: host('mac'), converters, links: () => [link('box', box)] })
    await expect(mac.serveForwarded({ from: 'txt', to: 'md', name: 'a.txt', data: Buffer.from('x').toString('base64') })).rejects.toThrow('upper is not installed on mac')
  })

  it("names a forwarded file itself, whatever name the far host sent", async () => {
    const seen: string[] = []
    const converters = convertersOf([mod('formats', [{ ...upper('txt', 'md', 'upper'), run: async (job) => (seen.push(job.input, job.output), writeFileSync(job.output, 'SAFE'), {}) }])])
    const box = new JobRunner({ host: 'box', dataDir: host('box', ['upper']), converters })
    const r = await box.serveForwarded({ from: 'txt', to: 'md', name: '../../../etc/.passwd', data: Buffer.from('safe').toString('base64') })
    expect(Buffer.from(r.data, 'base64').toString()).toBe('SAFE')
    expect(seen.map((p) => p.split('/').at(-1))).toEqual(['input.txt', 'output.md'])
    expect(existsSync(join(root, 'etc'))).toBe(false)
  })
})

describe('a format drawn by a named program', () => {
  it("takes a +renderer suffix as part of the pair and names the file by the extension before it", async () => {
    expect(extOf('pdf+word')).toBe('pdf')
    expect(extOf('.DOCX')).toBe('docx')
    const runner = new JobRunner({ host: 'box', dataDir: host('box'), converters: convertersOf([mod('office', [upper('docx', 'pdf+word')])]) })
    const own = await runner.convert({ from: 'docx', to: 'pdf+word', input: input('x') })
    expect(own.output).toMatch(/work-tools\/jobs\/[^/]+\/in-[a-z0-9]+\.pdf$/)
    expect(await runner.pairs()).toEqual([{ from: 'docx', to: 'pdf+word' }])
    // the plain pair is another pair: nothing claims it here
    await expect(runner.convert({ from: 'docx', to: 'pdf', input: input('x') })).rejects.toThrow('no converter from docx to pdf')
  })

  it('carries the suffix to a linked host and back, the far side naming its own files by the extension', async () => {
    const seen: string[] = []
    const far = convertersOf([mod('office', [{ ...upper('docx', 'pdf+word'), run: async (job) => (seen.push(job.input, job.output), writeFileSync(job.output, 'WORD'), {}) }])])
    const box = new JobRunner({ host: 'box', dataDir: host('box'), converters: far })
    // The Mac knows the pair and cannot run it: Word is not on it.
    const mac = new JobRunner({ host: 'mac', dataDir: host('mac'), log: () => {}, converters: convertersOf([mod('office', [{ ...upper('docx', 'pdf+word'), ready: () => 'none' }])]), links: () => [link('box', box)] })
    const r = await mac.convert({ from: 'docx', to: 'pdf+word', input: input('x') })
    expect(r.ranOn).toBe('box')
    expect(r.output).toMatch(/\.pdf$/)
    expect(readFileSync(r.output, 'utf8')).toBe('WORD')
    expect(seen.map((p) => p.split('/').at(-1))).toEqual(['input.docx', 'output.pdf'])
  })
})

describe('a converter that is an app or a machine', () => {
  /** A converter whose state the test sets, recording the press each run saw. */
  function office(state: { now: Readiness }, runs: boolean[] = [], asked: (ConvertJob | null)[] = []): Converter {
    return {
      from: 'docx',
      to: 'pdf+word',
      ready: (job) => (asked.push(job), state.now),
      async run(job) {
        runs.push(pressed(job))
        writeFileSync(job.output, 'WORD')
        return {}
      }
    }
  }
  const owner = { kind: 'local', caps: ['admin'] } as const

  it('is asked when the job comes, with the job, and told in the report with null', async () => {
    const state = { now: 'ready' as Readiness }
    const asked: (ConvertJob | null)[] = []
    const runner = new JobRunner({ host: 'box', dataDir: host('box'), log: () => {}, converters: convertersOf([mod('office', [office(state, [], asked)])]) })
    expect((await runner.report()).converts).toEqual([{ from: 'docx', to: 'pdf+word' }])
    expect(asked).toEqual([null])
    const job = { from: 'docx', to: 'pdf+word', input: input() }
    await runner.convert(job)
    expect(asked[1]).toMatchObject(job)
    state.now = 'asleep'
    expect((await runner.report()).converts).toEqual([{ from: 'docx', to: 'pdf+word', state: 'asleep' }])
    state.now = 'not open'
    expect((await runner.report()).converts).toEqual([{ from: 'docx', to: 'pdf+word', state: 'not open' }])
    state.now = 'none'
    expect((await runner.report()).converts).toEqual([])
  })

  it('runs when ready; asleep, runs only for his press; not open or none, never', async () => {
    const state = { now: 'ready' as Readiness }
    const runs: boolean[] = []
    const runner = new JobRunner({ host: 'box', dataDir: host('box'), log: () => {}, converters: convertersOf([mod('office', [office(state, runs)])]) })
    const job = (): ConvertJob => ({ from: 'docx', to: 'pdf+word', input: input() })
    await runner.convert(job())
    expect(runs).toEqual([false])

    state.now = 'asleep'
    await expect(runner.convert(job())).rejects.toThrow(NotReadyError)
    await expect(runner.convert(job())).rejects.toMatchObject({ state: 'asleep', message: 'the machine that converts docx to pdf+word is asleep, and only his own press wakes it' })
    await runner.convert({ ...job(), pressed: pressOf(owner)! })
    expect(runs).toEqual([false, true])

    state.now = 'not open'
    await expect(runner.convert({ ...job(), pressed: pressOf(owner)! })).rejects.toMatchObject({ state: 'not open', message: 'the app that converts docx to pdf+word is not open on box' })
    state.now = 'none'
    await expect(runner.convert({ ...job(), pressed: pressOf(owner)! })).rejects.toThrow(new NoConverterError('box cannot convert docx to pdf+word now, and no linked host converts docx to pdf+word'))
    expect(runs).toEqual([false, true])
  })

  it('a converter that cannot say is not here, and the job says so rather than failing oddly', async () => {
    const lines: string[] = []
    const broken: Converter = { ...upper('docx', 'pdf+word'), ready: () => Promise.reject(new Error('the helper did not answer')) }
    const runner = new JobRunner({ host: 'box', dataDir: host('box'), log: (l) => lines.push(l), converters: convertersOf([mod('office', [broken])]) })
    await expect(runner.convert({ from: 'docx', to: 'pdf+word', input: input() })).rejects.toThrow(NoConverterError)
    expect(lines.join('\n')).toContain('could not say whether it is ready: the helper did not answer')
  })

  it('a converter that does not answer in time is not here: its jobs fail at once and the report still says the rest', async () => {
    const lines: string[] = []
    const hung: Converter = { ...upper('docx', 'pdf+word'), ready: () => new Promise<Readiness>(() => {}) }
    const runner = new JobRunner({ host: 'box', dataDir: host('box', ['upper']), log: (l) => lines.push(l), readyTimeoutMs: 30, converters: convertersOf([mod('office', [hung]), mod('formats', [upper('txt', 'md', 'upper')])]) })
    const started = Date.now()
    await expect(runner.convert({ from: 'docx', to: 'pdf+word', input: input() })).rejects.toThrow(NoConverterError)
    expect((await runner.report()).converts).toEqual([{ from: 'txt', to: 'md' }])
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(lines.join('\n')).toContain('docx→pdf+word could not say whether it is ready: it did not answer')
  })

  it("a press is this host's own: only the owner's window makes one, and nothing sent passes for one", async () => {
    expect(pressOf({ kind: 'local', caps: [] })).toBeDefined()
    // his own paired device, which could approve as it pressed
    expect(pressOf({ kind: 'remote', caps: ['read', 'operate', 'approve'] })).toBeDefined()
    expect(pressOf({ kind: 'remote', caps: ['admin'] })).toBeDefined()
    // a thread; another host of his; a read-only key; and a key that can run jobs but not approve, which is all an agent's key
    // through the MCP door may ever hold (MCP_CEILING)
    expect(pressOf({ kind: 'model', caps: ['admin'], sessionId: 's1' })).toBeUndefined()
    expect(pressOf({ kind: 'remote', caps: ['admin'], peer: 'mac' })).toBeUndefined()
    expect(pressOf({ kind: 'remote', caps: ['read'] })).toBeUndefined()
    expect(pressOf({ kind: 'remote', caps: ['read', 'operate'] })).toBeUndefined()
    expect(MCP_CEILING.includes('approve') || MCP_CEILING.includes('admin')).toBe(false)
    expect(pressed({ pressed: pressOf(owner) })).toBe(true)
    expect(pressed({ pressed: true })).toBe(false)
    expect(pressed({ pressed: { pressed: true } })).toBe(false)
    expect(pressed(JSON.parse(JSON.stringify({ pressed: pressOf(owner) })))).toBe(false)

    // A job that claims a press it was not given is run as an unpressed job: asleep stays asleep.
    const state = { now: 'asleep' as Readiness }
    const runs: boolean[] = []
    const runner = new JobRunner({ host: 'box', dataDir: host('box'), log: () => {}, converters: convertersOf([mod('office', [office(state, runs)])]) })
    const forged = { from: 'docx', to: 'pdf+word', input: input(), pressed: { pressed: true } } as ConvertJob
    await expect(runner.convert(forged)).rejects.toMatchObject({ state: 'asleep' })
    expect(runs).toEqual([])
  })

  it('a forwarded job carries no press: it runs on a far host that is ready, passes one that sleeps, and wakes nothing', async () => {
    const farState = { now: 'ready' as Readiness }
    const farRuns: boolean[] = []
    const sent: unknown[] = []
    const box = new JobRunner({ host: 'box', dataDir: host('box'), log: () => {}, converters: convertersOf([mod('office', [office(farState, farRuns)])]) })
    const wire: LinkedHost = {
      id: 'box',
      async request<T>(method: string, params?: unknown): Promise<T> {
        if (method === 'work.formats.convert') sent.push(JSON.parse(JSON.stringify(params)))
        return link('box', box).request<T>(method, params)
      }
    }
    const mac = (): JobRunner => new JobRunner({ host: 'mac', dataDir: host(`mac-${Math.random().toString(36).slice(2)}`), log: () => {}, converters: convertersOf([mod('office', [{ ...upper('docx', 'pdf+word'), ready: () => 'none' }])]), links: () => [wire] })

    const r = await mac().convert({ from: 'docx', to: 'pdf+word', input: input(), pressed: pressOf(owner)!, options: { quality: 'print', pressed: true } })
    expect(r.ranOn).toBe('box')
    // the far run saw no press, and neither the field nor an option of that name crossed the link
    expect(farRuns).toEqual([false])
    expect(sent).toHaveLength(1)
    expect(Object.keys(sent[0] as object).sort()).toEqual(['data', 'from', 'name', 'options', 'to'])
    expect((sent[0] as { options: unknown }).options).toEqual({ quality: 'print' })

    // asleep there: his press here cannot wake it over a link, so the job is not sent at all
    farState.now = 'asleep'
    await expect(mac().convert({ from: 'docx', to: 'pdf+word', input: input(), pressed: pressOf(owner)! })).rejects.toMatchObject({
      state: 'asleep',
      message: 'the machine that converts docx to pdf+word is asleep on box, and only his own press at a window of that host wakes it'
    })
    expect(sent).toHaveLength(1)
    farState.now = 'not open'
    await expect(mac().convert({ from: 'docx', to: 'pdf+word', input: input() })).rejects.toMatchObject({ state: 'not open', message: 'the app that converts docx to pdf+word is not open on box' })
    farState.now = 'asleep'

    // and a far host asked directly with a `pressed` in the request runs it unpressed, or not at all
    await expect(box.serveForwarded({ from: 'docx', to: 'pdf+word', name: 'a.docx', data: Buffer.from('x').toString('base64'), pressed: true, options: { pressed: true } } as Parameters<JobRunner['serveForwarded']>[0])).rejects.toMatchObject({ state: 'asleep' })
    expect(farRuns).toEqual([false])
  })

  it("never carries a shared library's file to another host", async () => {
    const calls: string[] = []
    const converters = convertersOf([mod('formats', [upper('txt', 'md', 'upper')])])
    const box = new JobRunner({ host: 'box', dataDir: host('box', ['upper']), converters })
    const mac = new JobRunner({ host: 'mac', dataDir: host('mac'), converters, log: () => {}, links: () => [link('box', box, calls)] })
    await expect(mac.convert({ from: 'txt', to: 'md', input: input('roster'), shared: true })).rejects.toThrow(new NoConverterError("upper is not installed on mac, and a shared library's file is never carried to another host"))
    // not even asked what it converts
    expect(calls).toEqual([])
    // the same job, not shared, goes; and a shared job runs where its tool is
    await expect(mac.convert({ from: 'txt', to: 'md', input: input('plan') })).resolves.toMatchObject({ ranOn: 'box' })
    await expect(box.convert({ from: 'txt', to: 'md', input: input('roster'), shared: true })).resolves.toMatchObject({ ranOn: 'box' })
  })

  it('refuses in words a result that comes back past the cap, and keeps none of it', async () => {
    const converters = convertersOf([mod('formats', [upper('txt', 'md', 'upper')])])
    const big: LinkedHost = {
      id: 'box',
      request: <T,>(method: string) =>
        Promise.resolve(method === 'work.formats.tools' ? { converts: [{ from: 'txt', to: 'md' }] } : { data: Buffer.from('x'.repeat(11)).toString('base64'), ranOn: 'box', warnings: [] }) as Promise<T>
    }
    const mac = new JobRunner({ host: 'mac', dataDir: host('mac'), converters, log: () => {}, links: () => [big], forwardMax: 10 })
    const out = join(root, 'never.md')
    await expect(mac.convert({ from: 'txt', to: 'md', input: input('x'), output: out })).rejects.toThrow('the md that came back is 0 MB; a job carried from another host takes at most 0 MB')
    expect(existsSync(out)).toBe(false)
  })
})

describe('the LibreOffice converter', () => {
  /** A stand-in soffice that records its arguments and writes what soffice would. */
  function sofficeHost(): { dataDir: string; argv: () => string[] } {
    const dataDir = host('box', ['libreoffice'])
    const bin = join(dataDir, 'work-tools', 'libreoffice', '1.0', 'run')
    const log = join(root, 'argv.txt')
    writeFileSync(
      bin,
      `#!/bin/sh
printf '%s\n' "$@" > ${log}
out=""; to=""; last=""
while [ $# -gt 0 ]; do case "$1" in --outdir) out="$2"; shift;; --convert-to) to="$2"; shift;; *) last="$1";; esac; shift; done
base=$(basename "$last"); base="\${base%.*}"
cp "$last" "$out/$base.\${to%%:*}"
`
    )
    return { dataDir, argv: () => readFileSync(log, 'utf8').trim().split('\n') }
  }

  it("runs soffice headless with its slot's own seeded profile and the filter asked for", async () => {
    const { dataDir, argv } = sofficeHost()
    const runner = new JobRunner({ host: 'box', dataDir, converters: convertersOf([mod('formats', [libreOffice('odt', 'docx')])]) })
    const r = await runner.convert({ from: 'odt', to: 'docx', input: input('doc'), options: { filter: 'MS Word 2007 XML' } })
    expect(readFileSync(r.output, 'utf8')).toBe('doc')
    const args = argv()
    expect(args[0]).toMatch(/^-env:UserInstallation=file:\/\/.*\/work-tools\/run\/libreoffice-profile-v1-0$/)
    expect(args).toContain('--headless')
    expect(args).toContain('docx:MS Word 2007 XML')
    const profile = readFileSync(join(dataDir, 'work-tools', 'run', 'libreoffice-profile-v1-0', 'user', 'registrymodifications.xcu'), 'utf8')
    expect(profile).toContain('<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value>')
    expect(profile).toContain('<prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value>')
  })

  it('refuses a filter that is not a filter name', async () => {
    const { dataDir } = sofficeHost()
    const runner = new JobRunner({ host: 'box', dataDir, converters: convertersOf([mod('formats', [libreOffice('odt', 'docx')])]) })
    await expect(runner.convert({ from: 'odt', to: 'docx', input: input(), options: { filter: 'x\n--infilter=evil' } })).rejects.toThrow('not a LibreOffice filter name')
  })
})

const readdirNames = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : [])
