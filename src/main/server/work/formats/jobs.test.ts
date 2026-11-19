import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkModule } from '../modules'
import { LIBREOFFICE_CONVERTERS, libreOffice } from '.'
import { convertersOf, defaultCaps, JobRunner, NoConverterError, type Converter, type LinkedHost } from './jobs'
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
      const answer = method === 'work.formats.tools' ? far.report() : method === 'work.formats.convert' ? await far.serveForwarded(wire) : null
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
    expect(runner.report().queue).toEqual({ cap: { jobs: 2, threads: 4 }, running: 2, queued: 1 })
    releases.shift()!()
    expect((await a).warnings).toEqual(['ran in slot 0'])
    await new Promise((r) => setTimeout(r, 20))
    // c takes the slot a left; b still holds 3 of 4 threads
    expect(runner.report().queue.running).toBe(2)
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
    expect(runner.report().queue.running).toBe(0)
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
    expect(runner.report().queue.running).toBe(1)
    abort.abort()
    await expect(running).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(runner.report().queue.running).toBe(0)
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
