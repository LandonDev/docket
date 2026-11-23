import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerFrame } from '@shared/contract'
import { CODE_CHUNK_BYTES, CODE_UPDATES_SETTING, type CodeHost, type CodeUpdateStatus } from '@shared/codeUpdate'
import { packCode } from '../../../scripts/lib/codePack'
import { BASE_FILE, CODE_DIR, pickCode, readState, type CodeBase, type CodeBoot } from '../codeChoice'
import { CODE_OFFER_SETTING, CodeOffers, offerHead } from './codeOffer'
import { CodeUpdates, INCOMING_DIR, treeProblem, unpackedBytes } from './codeUpdates'
import type { LinkRequest } from './remote/peerCalls'

const BASE: CodeBase = { electron: '39.8.10', lock: 'l'.repeat(64), beside: 'b'.repeat(64), native: 'n'.repeat(64), boot: 'o'.repeat(64) }
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const BOX = 'env-box'

let root: string
let bundle: string
let userData: string
let source: string
let packs: string

/** The host's checkout: a built out/ whose index says `marker`, on `base`. */
function build(marker: string, base: CodeBase = BASE, bulk = 0): void {
  const out = join(source, 'out')
  rmSync(out, { recursive: true, force: true })
  for (const dir of ['main/chunks', 'preload', 'renderer']) mkdirSync(join(out, dir), { recursive: true })
  writeFileSync(join(out, 'main/index.js'), `// ${marker}\n`)
  writeFileSync(join(out, 'main/boot.js'), '// boot\n')
  writeFileSync(join(out, 'main/gateway.js'), '// gateway\n')
  writeFileSync(join(out, 'main/chunks/a.js'), `// chunk ${marker}\n`)
  writeFileSync(join(out, 'preload/index.js'), '// preload\n')
  writeFileSync(join(out, 'renderer/index.html'), `<html>${marker}</html>`)
  // bytes gzip cannot shrink, so the pack crosses in more than one chunk
  if (bulk) writeFileSync(join(out, 'renderer/bulk.bin'), randomBytes(bulk))
  writeFileSync(join(out, BASE_FILE), JSON.stringify({ v: 1, ...base }))
}

const settingsOf = (): { get: (k: string) => string | null; set: (k: string, v: string) => void; map: Map<string, string> } => {
  const map = new Map<string, string>()
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v) }
}

function host(): { offers: CodeOffers; frames: ServerFrame[]; request: LinkRequest; calls: string[]; settings: ReturnType<typeof settingsOf> } {
  const frames: ServerFrame[] = []
  const calls: string[] = []
  const settings = settingsOf()
  const offers = new CodeOffers({ environmentId: 'box', notify: (f) => frames.push(f), getSetting: settings.get, setSetting: settings.set })
  const request: LinkRequest = async (method, params) => {
    calls.push(method)
    const p = params as { commit: string; offset: number; length: number }
    if (method === 'code.latest') return offers.latest()
    if (method === 'code.chunk') return offers.chunk(p.commit, p.offset, p.length)
    throw new Error(`unknown method ${method}`)
  }
  return { offers, frames, request, calls, settings }
}

const THE_BOX: CodeHost = { id: BOX, name: 'The box' }

function mac(
  request: LinkRequest | null,
  patch: { hosts?: CodeHost[]; secure?: boolean; boot?: CodeBoot | null; pid?: number } = {}
): { updates: CodeUpdates; boot: CodeBoot; statuses: CodeUpdateStatus[]; settings: ReturnType<typeof settingsOf>; lines: string[]; hosts: CodeHost[] } {
  const boot = patch.boot === undefined ? pickCode({ packaged: true, platform: 'darwin', bundleRoot: bundle, userData, pid: patch.pid ?? 100, alive: () => false }).boot : patch.boot
  const statuses: CodeUpdateStatus[] = []
  const lines: string[] = []
  const settings = settingsOf()
  const hosts = patch.hosts ?? [THE_BOX]
  const updates = new CodeUpdates({
    boot,
    getSetting: settings.get,
    setSetting: settings.set,
    adminHosts: () => hosts,
    link: () => request,
    secure: () => patch.secure !== false,
    onStatus: (s) => statuses.push(s),
    log: (line) => lines.push(line)
  })
  return { updates, boot: boot as CodeBoot, statuses, settings, lines, hosts }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-code-updates-'))
  bundle = join(root, 'bundle')
  userData = join(root, 'userData')
  source = join(root, 'source')
  packs = join(root, 'packs')
  mkdirSync(join(bundle, 'out', 'main'), { recursive: true })
  mkdirSync(join(bundle, 'node_modules'), { recursive: true })
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ version: '1.0.10' }))
  writeFileSync(join(bundle, 'out', BASE_FILE), JSON.stringify({ v: 1, ...BASE }))
  mkdirSync(userData, { recursive: true })
  mkdirSync(source, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('the host', () => {
  it('remembers the newest pack, tells every Mac, and answers for its manifest and bytes', () => {
    build('one')
    const { dir, manifest } = packCode({ root: source, commit: A, release: 11, subject: 'A fix', to: packs, trustOut: true })
    const h = host()
    expect(h.offers.latest()).toBeNull()
    expect(h.offers.announce(dir)).toEqual({ commit: A, release: 11, subject: 'A fix', bytes: manifest.tar.bytes })
    expect(h.settings.map.get(CODE_OFFER_SETTING)).toBe(dir)
    expect(h.frames).toEqual([{ push: 'code-available', from: 'box', commit: A, release: 11, subject: 'A fix' }])
    expect(h.offers.latest()).toEqual(manifest)
    const whole = readFileSync(join(dir, 'code.tar.gz'))
    const first = h.offers.chunk(A, 0, 10)
    expect(first).toEqual({ data: whole.subarray(0, 10).toString('base64'), bytes: 10, done: false })
    const rest = h.offers.chunk(A, 10, CODE_CHUNK_BYTES)
    expect(rest.bytes).toBe(whole.length - 10)
    expect(rest.done).toBe(true)
    expect(() => h.offers.chunk(B, 0, 10)).toThrow('is gone')
    expect(() => h.offers.chunk(A, whole.length + 1, 10)).toThrow('offset past the end')
  })

  it('refuses a folder that holds no pack, and forgets one whose files are gone', () => {
    const h = host()
    expect(() => h.offers.announce(join(root, 'nowhere'))).toThrow('no code pack')
    build('one')
    const { dir } = packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true })
    h.offers.announce(dir)
    writeFileSync(join(dir, 'code.tar.gz'), 'cut short')
    expect(h.offers.latest()).toBeNull()
    expect(() => h.offers.announce(dir)).toThrow('no code pack')
    rmSync(dir, { recursive: true })
    expect(h.offers.latest()).toBeNull()
  })

  it('reads a manifest’s head and nothing it cannot trust the shape of', () => {
    expect(offerHead({ commit: A, release: 3, subject: 's', tar: { bytes: 5 } })).toEqual({ commit: A, release: 3, subject: 's', bytes: 5 })
    expect(offerHead({ commit: 'zz', release: 3, tar: { bytes: 5 } })).toBeNull()
    expect(offerHead({ commit: A, release: 3, tar: { bytes: 10 ** 12 } })).toBeNull()
    expect(offerHead(null)).toBeNull()
  })
})

describe('the Mac', () => {
  it('takes an offer: fetches in chunks, checks, unpacks, hands it to boot and offers the restart', async () => {
    build('two', BASE, 3 * 1024 * 1024)
    const { dir, manifest } = packCode({ root: source, commit: A, release: 11, subject: 'A fix', to: packs, trustOut: true })
    expect(manifest.tar.bytes).toBeGreaterThan(CODE_CHUNK_BYTES)
    const h = host()
    h.offers.announce(dir)
    const m = mac(h.request)
    m.updates.start()
    expect(m.updates.onPeerPush(BOX, h.frames[0] as never)).toBe(true)
    await m.updates.idle()
    expect(h.calls.filter((c) => c === 'code.chunk').length).toBe(Math.ceil(manifest.tar.bytes / CODE_CHUNK_BYTES))
    const last = m.statuses.at(-1)!
    expect(last).toEqual({ offer: { commit: A, release: 11, subject: 'A fix', phase: 'ready' }, notice: undefined })
    expect(m.statuses.some((s) => s.offer?.phase === 'downloading' && s.offer.percent === 100)).toBe(true)
    const code = join(userData, CODE_DIR)
    expect(readState(code).current).toEqual({ commit: A, state: 'staged' })
    expect(readFileSync(join(code, A, 'out/main/index.js'), 'utf8')).toBe('// two\n')
    expect(existsSync(join(code, A, 'out/main/chunks/a.js'))).toBe(true)
    expect(readdirSync(join(code, INCOMING_DIR))).toEqual([])
    expect(m.boot.staged()).toEqual(manifest)

    // the only admin host was chosen and written down
    expect(m.settings.map.get(CODE_UPDATES_SETTING)).toBe(BOX)
    // a launch without the owner's Restart leaves it waiting, still offered
    const idle = pickCode({ packaged: true, platform: 'darwin', bundleRoot: bundle, userData, pid: 150, alive: () => false })
    expect(idle.out).toBe(join(bundle, 'out'))
    const waiting = mac(h.request, { boot: idle.boot })
    waiting.updates.start()
    expect(waiting.statuses.at(-1)).toEqual({ offer: { commit: A, release: 11, subject: 'A fix', phase: 'ready' } })

    // the Restart: boot runs it on trial; the app says it started once its window mounted AND was answered,
    // and boot alone turns it good
    idle.boot.arm()
    const next = pickCode({ packaged: true, platform: 'darwin', bundleRoot: bundle, userData, pid: 200, alive: () => false, later: () => {} })
    expect(next.out).toBe(join(code, A, 'out'))
    expect(next.trial).toBe(true)
    const again = mac(h.request, { boot: next.boot })
    again.updates.start()
    expect(again.statuses.at(-1)).toEqual({ running: { commit: A, release: 11, subject: 'A fix' } })
    again.updates.windowAnswered()
    next.settle()
    expect(readState(code).current).toEqual({ commit: A, state: 'trying' })
    again.updates.windowMounted()
    next.settle()
    expect(readState(code).current).toEqual({ commit: A, state: 'good' })
    // the same offer again changes nothing
    again.updates.linkUp(BOX)
    await again.updates.idle()
    expect(again.lines.join('\n')).toMatch(/skipped: this code is running/)
  })

  it('asks the host when the link comes up, with no push', async () => {
    build('two')
    const h = host()
    h.offers.announce(packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true }).dir)
    const m = mac(h.request)
    m.updates.linkUp(BOX)
    await m.updates.idle()
    expect(m.boot.staged()?.commit).toBe(A)
  })

  it('refuses a pack on another base with the plain line, and fetches nothing', async () => {
    build('two', { ...BASE, lock: 'x'.repeat(64) })
    const h = host()
    h.offers.announce(packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true }).dir)
    const m = mac(h.request)
    m.updates.linkUp(BOX)
    await m.updates.idle()
    expect(h.calls).toEqual(['code.latest'])
    expect(m.statuses.at(-1)).toEqual({ notice: 'Code update aaaaaaa needs a full release: node_modules changed.' })
    expect(readState(join(userData, CODE_DIR)).current).toBeUndefined()
  })

  it('takes nothing from a host with no admin standing, and does not even ask it', async () => {
    build('two')
    const h = host()
    h.offers.announce(packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true }).dir)
    const m = mac(h.request, { hosts: [] })
    m.updates.onPeerPush(BOX, h.frames[0] as never)
    m.updates.linkUp(BOX)
    m.updates.onPeerPush('env-stranger', h.frames[0] as never)
    await m.updates.idle()
    expect(h.calls).toEqual([])
    expect(m.boot.staged()).toBeNull()
  })

  it('takes code from one host: a second host saved later offers in vain, whatever it says of itself', async () => {
    build('two')
    const h = host()
    h.offers.announce(packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true }).dir)
    const m = mac(h.request)
    expect(m.updates.settings().host).toBe(BOX)
    // the owner links another machine; its hello says admin
    m.hosts.push({ id: 'env-other', name: 'Another' })
    m.updates.onPeerPush('env-other', h.frames[0] as never)
    m.updates.linkUp('env-other')
    await m.updates.idle()
    expect(h.calls).toEqual([])
    expect(m.updates.settings()).toEqual({ host: BOX, hosts: [THE_BOX, { id: 'env-other', name: 'Another' }], cannot: null })
  })

  it('with several admin hosts and none picked, takes from none until the owner picks', async () => {
    build('two')
    const h = host()
    h.offers.announce(packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true }).dir)
    const m = mac(h.request, { hosts: [THE_BOX, { id: 'env-other', name: 'Another' }] })
    expect(m.updates.settings().host).toBeNull()
    m.updates.linkUp(BOX)
    m.updates.linkUp('env-other')
    await m.updates.idle()
    expect(h.calls).toEqual([])
    expect(m.settings.map.has(CODE_UPDATES_SETTING)).toBe(false)
    expect(() => m.updates.setHost('env-stranger')).toThrow('not a host this Mac holds an admin key for')
    expect(m.updates.setHost(BOX).host).toBe(BOX)
    await m.updates.idle()
    expect(m.boot.staged()?.commit).toBe(A)
  })

  it('a chosen host that is no longer saved with admin is no host', async () => {
    const h = host()
    const m = mac(h.request)
    m.settings.set(CODE_UPDATES_SETTING, 'env-gone')
    expect(m.updates.settings().host).toBeNull()
    m.updates.linkUp(BOX)
    await m.updates.idle()
    expect(h.calls).toEqual([])
  })

  it('takes nothing over a link the network can read, and says so once', async () => {
    build('two')
    const h = host()
    h.offers.announce(packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true }).dir)
    const m = mac(h.request, { secure: false })
    m.updates.linkUp(BOX)
    m.updates.onPeerPush(BOX, h.frames[0] as never)
    await m.updates.idle()
    expect(h.calls).toEqual([])
    expect(m.statuses).toEqual([{ notice: 'Code updates need an encrypted link to The box.' }])
  })

  it('takes the host from the link, never from the frame’s own word', async () => {
    build('two')
    const h = host()
    h.offers.announce(packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true }).dir)
    const m = mac(h.request)
    // a frame that names the box, heard on another host's link
    m.updates.onPeerPush('env-stranger', { push: 'code-available', from: BOX, commit: A, release: 11, subject: 's' })
    await m.updates.idle()
    expect(h.calls).toEqual([])
  })

  it('the choice: off takes nothing and names no tree; a host picked is asked at once', async () => {
    build('two')
    const h = host()
    h.offers.announce(packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true }).dir)
    const m = mac(h.request)
    expect(m.updates.settings()).toEqual({ host: BOX, hosts: [THE_BOX], cannot: null })
    expect(m.updates.setHost(null)).toEqual({ host: null, hosts: [THE_BOX], cannot: null })
    expect(m.settings.map.get(CODE_UPDATES_SETTING)).toBe('off')
    m.updates.linkUp(BOX)
    await m.updates.idle()
    expect(h.calls).toEqual([])
    m.updates.setHost(BOX)
    await m.updates.idle()
    expect(m.boot.staged()?.commit).toBe(A)
    // the same host picked again keeps what is staged
    m.updates.setHost(BOX)
    await m.updates.idle()
    expect(m.boot.staged()?.commit).toBe(A)
    // off again: the staged tree is forgotten and the next launch runs the bundle
    m.updates.setHost(null)
    expect(m.statuses.at(-1)?.offer).toBeUndefined()
    expect(readState(join(userData, CODE_DIR)).current).toBeUndefined()
    expect(existsSync(join(userData, CODE_DIR, A))).toBe(false)
    expect(pickCode({ packaged: true, platform: 'darwin', bundleRoot: bundle, userData, pid: 300, alive: () => false }).out).toBe(join(bundle, 'out'))
  })

  it('a build that cannot take code says why and asks no host', async () => {
    build('two')
    const h = host()
    h.offers.announce(packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true }).dir)
    const dev = pickCode({ packaged: false, platform: 'darwin', bundleRoot: bundle, userData, pid: 1, alive: () => false }).boot
    const m = mac(h.request, { boot: dev })
    expect(m.updates.settings()).toEqual({ host: BOX, hosts: [THE_BOX], cannot: 'not a packaged build' })
    m.updates.linkUp(BOX)
    await m.updates.idle()
    expect(h.calls).toEqual([])
    expect(mac(h.request, { boot: null }).updates.settings().cannot).toBe('not a packaged build')
  })

  it('refuses bytes that are not the manifest’s, and keeps nothing of them', async () => {
    build('two')
    const { dir } = packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true })
    const h = host()
    h.offers.announce(dir)
    const tampered: LinkRequest = async (method, params) => {
      const answer = (await h.request(method, params)) as { data?: string }
      if (method !== 'code.chunk') return answer
      const bytes = Buffer.from(answer.data!, 'base64')
      bytes[bytes.length - 1] ^= 0xff
      return { ...answer, data: bytes.toString('base64') }
    }
    const m = mac(tampered)
    m.updates.linkUp(BOX)
    await m.updates.idle()
    expect(m.lines.join('\n')).toMatch(/the pack's sha256 is .*, not the manifest's/)
    expect(m.boot.staged()).toBeNull()
    expect(m.statuses.at(-1)?.offer).toBeUndefined()
    expect(readdirSync(join(userData, CODE_DIR, INCOMING_DIR))).toEqual([])
    // the same bad pack is not fetched a second time: the link coming back asks for the manifest alone
    const chunks = h.calls.filter((c) => c === 'code.chunk').length
    m.updates.linkUp(BOX)
    await m.updates.idle()
    expect(h.calls.filter((c) => c === 'code.chunk').length).toBe(chunks)
    expect(m.lines.join('\n')).toMatch(/skipped: this pack failed its checks/)
  })

  it('stops a fetch when the choice turns off mid-way, and shows no download left behind', async () => {
    build('two', BASE, 5 * 1024 * 1024)
    const h = host()
    h.offers.announce(packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true }).dir)
    const holder: { m?: ReturnType<typeof mac> } = {}
    let served = 0
    const slow: LinkRequest = async (method, params) => {
      if (method === 'code.chunk' && ++served === 2) holder.m!.updates.setHost(null)
      return h.request(method, params)
    }
    holder.m = mac(slow)
    holder.m.updates.linkUp(BOX)
    await holder.m.updates.idle()
    expect(holder.m.boot.staged()).toBeNull()
    expect(holder.m.statuses.at(-1)?.offer).toBeUndefined()
    expect(h.calls.filter((c) => c === 'code.chunk').length).toBe(2)
  })

  it('a pack that unpacks past the limit is refused before anything is unpacked', async () => {
    build('two', BASE, 3 * 1024 * 1024)
    const { dir } = packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true })
    await expect(unpackedBytes(join(dir, 'code.tar.gz'), 1024 * 1024)).rejects.toThrow('the pack unpacks to more than 1 MB')
    expect(await unpackedBytes(join(dir, 'code.tar.gz'), 64 * 1024 * 1024)).toBeGreaterThan(3 * 1024 * 1024)
  })

  it('an archive that sets unreadable modes is still walked and removed', async () => {
    build('two')
    const h = host()
    h.offers.announce(packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true }).dir)
    const m = mac(h.request)
    // the same checks run with an unpacker that leaves a locked folder and a link behind
    const locked = new CodeUpdates({
      boot: m.boot,
      getSetting: m.settings.get,
      setSetting: m.settings.set,
      adminHosts: () => [THE_BOX],
      link: () => h.request,
      secure: () => true,
      log: (line) => m.lines.push(line),
      extract: async (_tarball, dest) => {
        mkdirSync(join(dest, 'out', 'main'), { recursive: true })
        symlinkSync('/etc/hosts', join(dest, 'out', 'main', 'index.js'))
        chmodSync(join(dest, 'out', 'main'), 0o000)
      }
    })
    locked.linkUp(BOX)
    await locked.idle()
    expect(m.lines.join('\n')).toMatch(/out\/main\/index\.js is not a plain file/)
    expect(readdirSync(join(userData, CODE_DIR, INCOMING_DIR))).toEqual([])
    expect(m.boot.staged()).toBeNull()
  })

  it('goes on from the part file after a link that broke off', async () => {
    build('two', BASE, 5 * 1024 * 1024)
    const { dir, manifest } = packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true })
    const h = host()
    h.offers.announce(dir)
    let served = 0
    const flaky: LinkRequest = async (method, params) => {
      if (method === 'code.chunk' && ++served === 2) throw new Error('env-box closed the socket')
      return h.request(method, params)
    }
    const m = mac(flaky)
    m.updates.linkUp(BOX)
    await m.updates.idle()
    const part = join(userData, CODE_DIR, INCOMING_DIR, `${A}.tar.gz.part`)
    expect(statSync(part).size).toBe(CODE_CHUNK_BYTES)
    expect(m.statuses.at(-1)?.offer).toBeUndefined()
    const before = h.calls.filter((c) => c === 'code.chunk').length
    m.updates.linkUp(BOX)
    await m.updates.idle()
    expect(m.boot.staged()?.commit).toBe(A)
    // the second pass asked only for what was missing
    expect(h.calls.filter((c) => c === 'code.chunk').length - before).toBe(Math.ceil((manifest.tar.bytes - CODE_CHUNK_BYTES) / CODE_CHUNK_BYTES))
  })

  it('a newer offer takes the place of a staged one', async () => {
    build('two')
    const h = host()
    h.offers.announce(packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true }).dir)
    const m = mac(h.request)
    m.updates.linkUp(BOX)
    await m.updates.idle()
    build('three')
    h.offers.announce(packCode({ root: source, commit: B, release: 12, subject: 'Next', to: packs, trustOut: true }).dir)
    m.updates.onPeerPush(BOX, h.frames[1] as never)
    await m.updates.idle()
    const code = join(userData, CODE_DIR)
    expect(readState(code).current).toEqual({ commit: B, state: 'staged' })
    expect(existsSync(join(code, A))).toBe(false)
    expect(m.statuses.at(-1)?.offer).toEqual({ commit: B, release: 12, subject: 'Next', phase: 'ready' })
  })

  it('says a tree that did not start once, and does not take that commit again', async () => {
    build('two')
    const h = host()
    h.offers.announce(packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true }).dir)
    const first = mac(h.request)
    first.updates.linkUp(BOX)
    await first.updates.idle()
    const input = { packaged: true, platform: 'darwin' as const, bundleRoot: bundle, userData, alive: () => false }
    first.boot.arm()
    pickCode({ ...input, pid: 200 }) // the trial that never settled as good
    const after = pickCode({ ...input, pid: 300 })
    const m = mac(h.request, { boot: after.boot })
    m.updates.start()
    expect(m.statuses.at(-1)).toEqual({ notice: 'Code update aaaaaaa did not start. Running 1.0.10.' })
    expect(existsSync(join(userData, CODE_DIR, A))).toBe(false)
    m.updates.linkUp(BOX)
    await m.updates.idle()
    expect(m.statuses.at(-1)?.notice).toBe('Code update aaaaaaa was not taken: this code did not start here.')
    expect(m.boot.staged()).toBeNull()
  })

  it('an offer heard while a fetch runs is asked for once the fetch ends', async () => {
    build('two')
    const h = host()
    h.offers.announce(packCode({ root: source, commit: A, release: 11, subject: 's', to: packs, trustOut: true }).dir)
    const m = mac(h.request)
    m.updates.linkUp(BOX)
    m.updates.onPeerPush(BOX, h.frames[0] as never)
    await m.updates.idle()
    expect(h.calls.filter((c) => c === 'code.latest').length).toBe(2)
    expect(m.boot.staged()?.commit).toBe(A)
  })
})

describe('treeProblem', () => {
  it('passes one out/ of plain files and refuses anything else', () => {
    const dest = join(root, 'tree')
    mkdirSync(join(dest, 'out', 'main'), { recursive: true })
    writeFileSync(join(dest, 'out', 'main', 'index.js'), '')
    expect(treeProblem(dest)).toBeNull()
    symlinkSync('/etc/hosts', join(dest, 'out', 'main', 'link.js'))
    expect(treeProblem(dest)).toBe('out/main/link.js is not a plain file')
    rmSync(join(dest, 'out', 'main', 'link.js'))
    writeFileSync(join(dest, 'extra.txt'), '')
    expect(treeProblem(dest)).toBe('the pack holds extra.txt, out, not one out/')
    rmSync(join(dest, 'out'), { recursive: true })
    rmSync(join(dest, 'extra.txt'))
    expect(treeProblem(dest)).toBe('the pack holds nothing, not one out/')
  })
})
