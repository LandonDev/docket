import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { findLifeos, installLifeos, lifeosReaderOff, LIFEOS_FEED, parseFeed, parseRegQuery, RESULT_WAIT_MS, UNINSTALL_KEY, type InstallDeps, type StepReport } from './lifeosInstall'

const LOCAL = 'C:\\Users\\landon\\AppData\\Local'
const FOLDER = `${LOCAL}\\Programs\\lifeos-desktop`
const EXE = `${FOLDER}\\LifeOS.exe`
const CODE = `loe_${'a'.repeat(43)}`
const ASSET = 'https://objects.githubusercontent.com/github-production-release-asset/1/LifeOS-Setup-0.1.9.exe?sig=x'
const INSTALLER = Buffer.from('a fake LifeOS installer')
const sha = (b: Uint8Array): string => createHash('sha512').update(b).digest('base64')

type Entry = Record<string, string>
const lifeosEntry = (extra: Entry = {}): Entry => ({ DisplayName: 'LifeOS 0.1.10', DisplayVersion: '0.1.10', Publisher: 'Landon Hale', UninstallString: `"${FOLDER}\\Uninstall LifeOS.exe" /currentuser`, DisplayIcon: `${EXE},0`, ...extra })

/** What `reg.exe query … /s` prints for these entries. */
const regOut = (entries: Entry[]): string =>
  entries.map((e, i) => [`${UNINSTALL_KEY.replace('HKCU', 'HKEY_CURRENT_USER')}\\{guid-${i}}`, ...Object.entries(e).map(([k, v]) => `    ${k}    REG_SZ    ${v}`)].join('\r\n')).join('\r\n\r\n') + '\r\n'

let files: Map<string, string | Uint8Array>
/** Links and junctions: a path and where it really leads. */
const links = new Map<string, string>()
/** The version the feed's installer puts in place. */
let feedVersion = '0.1.10'
let renames: [string, string][]
let entries: Entry[]
let routes: Map<string, () => Response>
let fetched: string[]
let runs: { file: string; args: string[] }[]
let launches: string[]
let now: number
let sleeps: number
/** Called on each poll's sleep: LifeOS answering a while later. */
let onSleep: (n: number) => void
/** What LifeOS does when started: by default it takes the enroll file and answers ok. */
let lifeos: (attempt: string) => void
let reports: StepReport[]

function feed(sha512 = sha(INSTALLER)): string {
  return `version: 0.1.9\nfiles:\n  - url: LifeOS-Setup-0.1.9.exe\n    sha512: ${sha512}\n    size: ${INSTALLER.length}\npath: LifeOS-Setup-0.1.9.exe\nsha512: ${sha512}\nreleaseDate: '2026-11-24T02:42:00.000Z'\n`
}
const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } })

const deps = (): InstallDeps => ({
  fetch: async (url) => {
    fetched.push(url)
    const route = routes.get(url)
    if (!route) return new Response('not found', { status: 404 })
    return route()
  },
  fs: {
    readFile: async (p) => {
      const v = files.get(p)
      if (v === undefined) throw new Error('ENOENT')
      return typeof v === 'string' ? v : Buffer.from(v).toString('utf8')
    },
    writeFile: async (p, d) => void files.set(p, d),
    rename: async (a, b) => {
      renames.push([a, b])
      files.set(b, files.get(a)!)
      files.delete(a)
    },
    rm: async (p) => void files.delete(p),
    mkdir: async () => {},
    exists: async (p) => files.has(p),
    realpath: async (p) => links.get(p) ?? p
  },
  run: async (file, args) => {
    runs.push({ file, args })
    expect(files.get(file)).toEqual(new Uint8Array(INSTALLER))
    // The installer writes its entry anew.
    entries = [lifeosEntry({ DisplayName: `LifeOS ${feedVersion}`, DisplayVersion: feedVersion })]
    files.set(EXE, 'exe')
    return 0
  },
  launch: (file) => {
    launches.push(file)
    const name = [...files.keys()].find((k) => /\\lifeos\\enroll-[^.]+\.json$/.test(k))
    if (name) lifeos(/enroll-([^.]+)\.json$/.exec(name)![1]!)
  },
  regQuery: async () => {
    if (!entries.length) throw new Error('ERROR: The system was unable to find the specified registry key or value.')
    return regOut(entries)
  },
  env: { LOCALAPPDATA: LOCAL, TEMP: `${LOCAL}\\Temp` },
  now: () => now,
  sleep: async (ms) => {
    sleeps++
    now += ms
    onSleep(sleeps)
  }
})

const enrollPath = (attempt: string): string => `${LOCAL}\\lifeos\\enroll-${attempt}.json`
const resultPath = (attempt: string): string => `${LOCAL}\\lifeos\\enroll-${attempt}.result.json`
const answer = (attempt: string, body: object): void => {
  files.delete(enrollPath(attempt))
  files.set(resultPath(attempt), JSON.stringify(body))
}
const run = (extra: Partial<Parameters<typeof installLifeos>[0]> = {}) => installLifeos({ code: CODE, owner: 'landon', reader: true, attempt: 'try1', ...extra }, deps(), (r) => reports.push(r))
const last = (step: StepReport['step']): StepReport | undefined => [...reports].reverse().find((r) => r.step === step)

beforeEach(() => {
  files = new Map()
  renames = []
  entries = []
  fetched = []
  runs = []
  launches = []
  now = 1_000_000
  sleeps = 0
  onSleep = () => {}
  reports = []
  routes = new Map([
    [`${LIFEOS_FEED}latest.yml`, redirect('https://release-assets.githubusercontent.com/github-production-release-asset/1/latest.yml?sig=y')],
    ['https://release-assets.githubusercontent.com/github-production-release-asset/1/latest.yml?sig=y', () => new Response(feed())],
    [`${LIFEOS_FEED}LifeOS-Setup-0.1.9.exe`, redirect(ASSET)],
    [ASSET, () => new Response(INSTALLER, { headers: { 'content-length': String(INSTALLER.length) } })]
  ])
  lifeos = (attempt) => answer(attempt, { attempt, ok: true })
})

describe('the LifeOS step on a PC', () => {
  it('a good feed: downloads, checks, installs /S, finds LifeOS by its entry, leaves the enroll file whole and starts it', async () => {
    let enroll: unknown
    lifeos = (attempt) => {
      enroll = JSON.parse(files.get(enrollPath(attempt)) as string)
      answer(attempt, { attempt, ok: true })
    }
    expect(await run()).toEqual({ ok: true, signedIn: true })
    expect(reports).toEqual([
      { step: 'download', state: 'working' },
      { step: 'download', state: 'done' },
      { step: 'install', state: 'working' },
      { step: 'install', state: 'done' },
      { step: 'sign-in', state: 'working' },
      { step: 'reader', state: 'working' },
      { step: 'sign-in', state: 'done' },
      { step: 'reader', state: 'done' }
    ])
    expect(runs).toEqual([{ file: `${LOCAL}\\Temp\\tempcode-lifeos-try1.exe`, args: ['/S'] }])
    expect(launches).toEqual([EXE])
    expect(enroll).toEqual({ attempt: 'try1', code: CODE, backend: 'https://lifeos.landonhale.com', owner: 'landon', reader: true })
    // Written under another name, then renamed into place.
    expect(renames).toEqual([[`${LOCAL}\\lifeos\\.enroll-try1.json.tmp`, enrollPath('try1')]])
    // The installer and the answer are cleaned up; the code is in no report.
    expect([...files.keys()]).toEqual([EXE])
    expect(JSON.stringify(reports)).not.toContain(CODE)
  })

  it('a redirect to a host that is not GitHub’s is refused, and nothing is run', async () => {
    routes.set(`${LIFEOS_FEED}LifeOS-Setup-0.1.9.exe`, redirect('https://evil.example/LifeOS-Setup.exe'))
    expect(await run()).toMatchObject({ ok: false, step: 'download' })
    expect(last('download')).toEqual({ step: 'download', state: 'failed', reason: "The download was sent to evil.example, which is not GitHub's" })
    expect(fetched).not.toContain('https://evil.example/LifeOS-Setup.exe')
    expect(runs).toEqual([])
    expect(last('reader')).toMatchObject({ state: 'failed' })
  })

  it('a plain http hop on a GitHub host is refused too', async () => {
    routes.set(`${LIFEOS_FEED}LifeOS-Setup-0.1.9.exe`, redirect('http://objects.githubusercontent.com/x.exe'))
    expect(await run()).toMatchObject({ ok: false, step: 'download' })
    expect(runs).toEqual([])
  })

  it('an installer that does not match the feed’s sha512 is refused and never written', async () => {
    routes.set('https://release-assets.githubusercontent.com/github-production-release-asset/1/latest.yml?sig=y', () => new Response(feed(sha(Buffer.from('another file')))))
    expect(await run()).toMatchObject({ ok: false, step: 'download', reason: 'The installer did not match its checksum' })
    expect(runs).toEqual([])
    expect(files.size).toBe(0)
  })

  it('an entry named LifeOS from another publisher, or in a folder outside %LOCALAPPDATA%\\Programs, is refused and never run', async () => {
    entries = [lifeosEntry({ Publisher: 'Someone Else' })]
    files.set(EXE, 'exe')
    expect(await run()).toMatchObject({ ok: false, step: 'install' })
    expect(last('install')!.reason).toBe("An app named LifeOS from Someone Else is installed; it is not LifeOS's")
    expect(launches).toEqual([])

    reports = []
    entries = [lifeosEntry({ InstallLocation: 'C:\\Tools\\LifeOS' })]
    files.set('C:\\Tools\\LifeOS\\LifeOS.exe', 'exe')
    expect(await run()).toMatchObject({ ok: false, step: 'install' })
    expect(last('install')!.reason).toMatch(/outside this user's programs folder/)

    // A path that climbs out of Programs is outside it too.
    entries = [lifeosEntry({ InstallLocation: `${LOCAL}\\Programs\\..\\Evil` })]
    expect(await findLifeos(deps())).toMatchObject({ state: 'refused' })
    expect(launches).toEqual([])
    expect(runs).toEqual([])
  })

  it('already installed: no download and no install, straight to the sign-in', async () => {
    entries = [lifeosEntry()]
    files.set(EXE, 'exe')
    expect(await run()).toEqual({ ok: true, signedIn: true })
    expect(fetched).toEqual([])
    expect(runs).toEqual([])
    expect(reports.slice(0, 2)).toEqual([
      { step: 'download', state: 'done', reason: 'Already installed' },
      { step: 'install', state: 'done', reason: 'Already installed' }
    ])
    expect(launches).toEqual([EXE])
  })

  it('an installed LifeOS older than the enroll protocol is installed over from the checked feed, never handed a code (F24)', async () => {
    entries = [lifeosEntry({ DisplayName: 'LifeOS 0.1.9', DisplayVersion: '0.1.9' })]
    files.set(EXE, 'exe')
    expect(await run()).toEqual({ ok: true, signedIn: true })
    expect(runs).toHaveLength(1)
    // A feed whose release is still too old: the step says so and leaves no code.
    entries = [lifeosEntry({ DisplayName: 'LifeOS 0.1.9', DisplayVersion: '0.1.9' })]
    launches.length = 0
    feedVersion = '0.1.9'
    try {
      expect(await run()).toMatchObject({ ok: false, step: 'install', reason: expect.stringMatching(/newer LifeOS release/) })
    } finally {
      feedVersion = '0.1.10'
    }
    expect(launches).toEqual([])
    expect([...files.keys()].some((k) => /enroll-/.test(k))).toBe(false)
  })

  it('a LifeOS.exe that leads outside the programs folder is refused, never run (F24)', async () => {
    entries = [lifeosEntry()]
    files.set(EXE, 'exe')
    links.set(EXE, 'C:\\Users\\pc\\Downloads\\evil.exe')
    try {
      expect(await run()).toMatchObject({ ok: false, step: 'install', reason: expect.stringMatching(/outside/) })
    } finally {
      links.clear()
    }
    expect(launches).toEqual([])
  })

  it('a result file for another attempt is ignored until the one for this attempt comes', async () => {
    entries = [lifeosEntry()]
    files.set(EXE, 'exe')
    lifeos = () => files.set(resultPath('try1'), JSON.stringify({ attempt: 'other', ok: false, error: 'enroll-used' }))
    // LifeOS answers for this attempt a few polls later.
    onSleep = (n) => n === 3 && answer('try1', { attempt: 'try1', ok: true })
    expect(await run()).toEqual({ ok: true, signedIn: true })
    expect(sleeps).toBe(3)
    expect(last('sign-in')).toEqual({ step: 'sign-in', state: 'done' })
  })

  it('no answer in two minutes: the sign-in fails and the code left for LifeOS is taken back', async () => {
    entries = [lifeosEntry()]
    files.set(EXE, 'exe')
    lifeos = () => {}
    const start = now
    expect(await run()).toEqual({ ok: false, step: 'sign-in', reason: 'LifeOS did not answer in two minutes' })
    expect(now - start).toBeGreaterThanOrEqual(RESULT_WAIT_MS)
    expect(now - start).toBeLessThan(RESULT_WAIT_MS + 2_000)
    expect(files.has(enrollPath('try1'))).toBe(false)
    expect(last('reader')).toMatchObject({ state: 'failed' })
  })

  it("'already signed in' is the step's outcome: done, his session and his reader left as they were", async () => {
    entries = [lifeosEntry()]
    files.set(EXE, 'exe')
    lifeos = (attempt) => answer(attempt, { attempt, ok: false, error: 'already signed in' })
    expect(await run()).toEqual({ ok: true })
    expect(last('sign-in')).toEqual({ step: 'sign-in', state: 'done', reason: 'Already signed in' })
    expect(last('reader')).toEqual({ step: 'reader', state: 'done', reason: 'Left as set in LifeOS' })
  })

  it('a refusal from LifeOS reads in words, and no reader row is drawn when none was asked for', async () => {
    entries = [lifeosEntry()]
    files.set(EXE, 'exe')
    lifeos = (attempt) => answer(attempt, { attempt, ok: false, error: 'enroll-expired' })
    expect(await run({ reader: false })).toEqual({ ok: false, step: 'sign-in', reason: 'This sign-in code has expired; make a new link on the Mac' })
    expect(reports.some((r) => r.step === 'reader')).toBe(false)
  })
})

describe("Remove's reader step", () => {
  it("writes read: false into LifeOS's purdue.json, keeps every other field, and turns the old flag off", async () => {
    const ROAMING = 'C:\\Users\\landon\\AppData\\Roaming'
    const path = `${ROAMING}\\lifeos\\purdue.json`
    const d = { ...deps(), env: { APPDATA: ROAMING } }
    expect(await lifeosReaderOff(d)).toBe(false)
    expect(files.has(path)).toBe(false)
    files.set(path, JSON.stringify({ read: true, send: true, mailWatermarkMs: 5 }))
    expect(await lifeosReaderOff(d)).toBe(true)
    expect(JSON.parse(files.get(path) as string)).toEqual({ read: false, send: true, mailWatermarkMs: 5 })
    files.set(path, JSON.stringify({ enabled: true }))
    await lifeosReaderOff(d)
    expect(JSON.parse(files.get(path) as string)).toEqual({ enabled: false, read: false })
    expect([...files.keys()].filter((k) => k.endsWith('.tmp'))).toEqual([])
  })
})

describe('the pieces', () => {
  it("reads latest.yml's top-level path and sha512, and refuses a path that is not a bare .exe", () => {
    expect(parseFeed(feed())).toEqual({ path: 'LifeOS-Setup-0.1.9.exe', sha512: sha(INSTALLER) })
    expect(() => parseFeed(feed().replace('path: LifeOS-Setup-0.1.9.exe', 'path: ../x.exe'))).toThrow(/names no installer/)
    expect(() => parseFeed('path: LifeOS-Setup.exe\nsha512: short\n')).toThrow(/no checksum/)
  })

  it("parses reg.exe's output, names with spaces and empty values included", () => {
    const out = `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{a}\r\n    DisplayName    REG_SZ    LifeOS 0.1.9\r\n    Empty Value    REG_SZ\r\n    EstimatedSize    REG_DWORD    0x1d4c0\r\n\r\n`
    expect([...parseRegQuery(out).values()]).toEqual([{ DisplayName: 'LifeOS 0.1.9', 'Empty Value': '', EstimatedSize: '0x1d4c0' }])
  })

  it('finds LifeOS.exe in the folder of its uninstaller when the entry has no InstallLocation', async () => {
    entries = [{ DisplayName: 'Something else', Publisher: 'Landon Hale' }, lifeosEntry()]
    files.set(EXE, 'exe')
    expect(await findLifeos(deps())).toEqual({ state: 'found', exe: EXE, version: '0.1.10' })
    expect(win32.dirname(EXE)).toBe(FOLDER)
  })
})
