import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { browserLapses, browserRows, EVALUATION_END_FALLBACK, evaluationEnd, signInCookies, standingVm, type BrowserProbe, type SignInCookie } from './health'

/** Connections' browser rows: the box browser, live video, sign-ins by cookie name alone, and the Windows VM. */
const NOW = Date.UTC(2026, 10, 20, 12)
const DAY = 86_400_000
/** Chromium's time for an epoch ms. */
const chromium = (ms: number): number => (ms + 11_644_473_600_000) * 1000
const SIGNED: SignInCookie[] = [{ host: '.login.microsoftonline.com', name: 'ESTSAUTHPERSISTENT', expires: chromium(NOW + 30 * DAY) }]

function probe(o: Partial<BrowserProbe> = {}): BrowserProbe {
  return {
    platform: 'linux',
    box: () => ({ running: true, headed: true, profile: '/p', root: '/r' }),
    chromium: () => true,
    videoOn: () => true,
    videoTools: () => true,
    cookies: () => SIGNED,
    owaAccount: () => 'ajohnson@purdue.edu',
    vm: () => ({ builtAt: Date.parse('2026-11-19T06:22:30.718Z'), disk: true, running: true }),
    now: () => NOW,
    ...o
  }
}
const byId = (rows: ReturnType<typeof browserRows>) => Object.fromEntries(rows.map((r) => [r.id, r]))

describe('the box browser', () => {
  it('says it runs, with live video, signed in to Outlook on the web as whom', () => {
    const rows = byId(browserRows(probe()))
    expect(rows['browser.box']).toMatchObject({ group: 'Browser', state: 'working', line: 'Running' })
    expect(rows['browser.video']).toMatchObject({ state: 'working', line: 'On' })
    expect(rows['browser.site:outlook']).toMatchObject({ title: 'Outlook on the web', state: 'working', line: 'Signed in as ajohnson@purdue.edu' })
  })

  it('is headless with no screen relay: he must install it', () => {
    const rows = byId(browserRows(probe({ box: () => ({ running: true, headed: false, profile: '/p', root: '/r' }), videoTools: () => false })))
    expect(rows['browser.video']).toMatchObject({ state: 'needs-you', line: expect.stringContaining('--only screen-relay') })
    const off = byId(browserRows(probe({ box: () => ({ running: false, headed: false, profile: '/p', root: '/r' }), videoOn: () => false })))
    expect(off['browser.video']).toMatchObject({ state: 'working', line: expect.stringMatching(/^Turned off/) })
    expect(off['browser.box']).toMatchObject({ line: 'Starts when a thread needs it' })
  })

  it('asks him to sign in when no live sign-in cookie is there, whatever the marker says', () => {
    const none = byId(browserRows(probe({ cookies: () => [] })))
    expect(none['browser.site:outlook']).toMatchObject({ state: 'needs-you', line: expect.stringMatching(/^Not signed in/) })
    const stale = byId(browserRows(probe({ cookies: () => [{ ...SIGNED[0]!, expires: chromium(NOW - DAY) }, { host: 'outlook.office.com', name: 'ClientId', expires: 0 }] })))
    expect(stale['browser.site:outlook']!.state).toBe('needs-you')
    // a store it cannot read leaves the marker to answer
    expect(byId(browserRows(probe({ cookies: () => null })))['browser.site:outlook']).toMatchObject({ state: 'working', line: 'Signed in as ajohnson@purdue.edu' })
    expect(byId(browserRows(probe({ cookies: () => null, owaAccount: () => null })))['browser.site:outlook']!.state).toBe('needs-you')
  })

  it('is broken with no Chromium, and left out where computer use is local or off Linux', () => {
    expect(byId(browserRows(probe({ box: () => null, chromium: () => false, vm: () => null })))).toEqual({
      'browser.box': expect.objectContaining({ state: 'broken', line: expect.stringContaining('No Chromium') })
    })
    expect(browserRows(probe({ box: () => null, vm: () => null }))).toEqual([])
    expect(browserRows(probe({ platform: 'darwin' }))).toEqual([])
  })
})

describe('the sign-in cookies', () => {
  let dir: string
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'browser-health-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const store = (): string => {
    const file = join(dir, 'Cookies')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER)')
    const add = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?)')
    add.run('.login.microsoftonline.com', 'ESTSAUTHPERSISTENT', 'secret-session-value', Buffer.from('v10-secret-bytes'), chromium(NOW + DAY))
    add.run('.example.com', 'sid', 'other-secret', Buffer.alloc(0), 0)
    db.close()
    return file
  }

  it('reads names and sites only, never a value, and no other site', () => {
    const got = signInCookies(store())
    expect(got).toEqual([{ host: '.login.microsoftonline.com', name: 'ESTSAUTHPERSISTENT', expires: chromium(NOW + DAY) }])
    const rows = browserRows(probe({ cookies: () => got }))
    expect(JSON.stringify(rows)).not.toMatch(/secret/)
  })

  it('reads a store the browser holds locked, and answers null for none', () => {
    const file = store()
    const holder = new DatabaseSync(file)
    holder.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; INSERT INTO cookies VALUES (\'x\', \'y\', \'z\', NULL, 0);')
    try {
      expect(signInCookies(file)).toHaveLength(1)
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
    expect(signInCookies(join(dir, 'missing'))).toBeNull()
  })
})

describe('the Windows VM', () => {
  it('says the standing machine runs, is stopped, or was never made', () => {
    expect(byId(browserRows(probe()))['browser.winvm.machine']).toMatchObject({ group: 'Windows VM', state: 'working', line: 'Running' })
    expect(byId(browserRows(probe({ vm: () => ({ builtAt: null, disk: true, running: false }) })))['browser.winvm.machine']).toMatchObject({ state: 'broken', line: expect.stringContaining('up.sh --instance standing') })
    expect(byId(browserRows(probe({ vm: () => ({ builtAt: null, disk: false, running: false }) })))['browser.winvm.machine']!.state).toBe('needs-you')
    expect(browserRows(probe({ vm: () => null })).some((r) => r.group === 'Windows VM')).toBe(false)
  })

  it("ends the evaluation 90 days after the image was built, on the 17th of February in his time", () => {
    const vm = { builtAt: Date.parse('2026-11-19T06:22:30.718Z'), disk: true, running: true }
    const until = evaluationEnd(vm)
    expect(new Date(until).toISOString()).toBe('2027-02-17T06:22:30.718Z')
    expect(new Date(until).toLocaleDateString('en-US', { timeZone: 'America/New_York' })).toBe('2/17/2027')
    expect(new Date(EVALUATION_END_FALLBACK).toLocaleDateString('en-US', { timeZone: 'America/New_York' })).toBe('2/17/2027')
    expect(evaluationEnd({ ...vm, builtAt: null })).toBe(EVALUATION_END_FALLBACK)
    const rows = byId(browserRows(probe()))
    expect(rows['browser.winvm.evaluation']).toMatchObject({ state: 'working', until })
    expect(byId(browserRows(probe({ now: () => until - 3 * DAY })))['browser.winvm.evaluation']!.state).toBe('needs-you')
    expect(byId(browserRows(probe({ now: () => until + DAY })))['browser.winvm.evaluation']!.state).toBe('broken')
    expect(browserLapses(probe())).toEqual([{ id: 'browser.winvm.evaluation', pillar: 'browser', title: 'Windows evaluation', until }])
    expect(browserLapses(probe({ platform: 'darwin' }))).toEqual([])
  })

  it('reads the machine from its files without starting it', () => {
    const root = mkdtempSync(join(tmpdir(), 'winvm-health-'))
    try {
      expect(standingVm({ WINVM_DIR: root })).toBeNull()
      mkdirSync(join(root, 'base'))
      writeFileSync(join(root, 'base', 'READY'), JSON.stringify({ builtAt: '2026-11-19T06:22:30.718Z' }))
      expect(standingVm({ WINVM_DIR: root })).toEqual({ builtAt: Date.parse('2026-11-19T06:22:30.718Z'), disk: false, running: false })
      mkdirSync(join(root, 'standing', 'run'), { recursive: true })
      writeFileSync(join(root, 'standing', 'run', 'disk.qcow2'), '')
      // a pid file naming a live process that is not this machine's QEMU
      writeFileSync(join(root, 'standing', 'run', 'qemu.pid'), String(process.pid))
      expect(standingVm({ WINVM_DIR: root })).toMatchObject({ disk: true, running: false })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
