import { afterEach, beforeEach, expect, it } from 'vitest'
import { configure, type ServiceView, type UsageWindow } from 'aliax-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountsService } from './accounts'
import { rankAccounts } from './accountScore'
import { HeadroomStore, type HeadroomSnapshot } from './headroom'
import { HeadroomSnapshotSchema } from '@shared/contract-m3a'

/**
 * A scoped cap (Fable) after the account resets, by its clock or early: a
 * whole fresh poll answer retires what it no longer lists, on every host,
 * and a lone sample, a cache or a failed poll retires nothing.
 */

let vaultDir: string
beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'tc-scoped-vault-'))
  configure({ dataDir: vaultDir, secrets: { mode: 'fileKey' }, fetch: async () => { throw new Error('unexpected network') } })
})
afterEach(() => rmSync(vaultDir, { recursive: true, force: true }))

const NOW = 1_800_000_000_000
const WEEK = 7 * 86400_000
const FABLE = 'claude-fable-5-1'
/** The peer exchange crosses the wire schema, which drops what it does not name. */
const wire = (s: HeadroomSnapshot) => HeadroomSnapshotSchema.parse(JSON.parse(JSON.stringify(s))) as HeadroomSnapshot

function host(id: string) {
  let now = NOW
  let windows: UsageWindow[] = []
  let failing = false
  const headroom = new HeadroomStore({ environmentId: id, now: () => now })
  const svc = new AccountsService({
    vaultPresent: () => true, locked: () => false, owner: () => 'temp-code', now: () => now,
    listServices: async () => [{ id: 'claude-code', profiles: [{ name: 'a', createdAt: 0, active: true }] }] as ServiceView[],
    pinned: () => null, headroom: () => headroom,
    usage: async sid => {
      if (failing) throw new Error('provider timeout')
      return sid === 'claude-code' ? [{ profileName: 'a', windows }] : []
    },
    markStale: () => {}
  })
  /** What aliax-core does on a fresh poll: each window's sample, then the whole answer. */
  const poll = (answer: UsageWindow[]) => {
    windows = answer
    for (const w of answer) svc.observeFreshWindow('claude-code', 'a', w)
    svc.observeFreshAnswer('claude-code', 'a', answer.map(w => w.label))
  }
  const fable429 = () => headroom.observe({ service: 'claude-code', account: 'a', model: FABLE, status: 429, quotaWindow: 'Fable', headers: new Headers({ 'retry-after': String(WEEK / 1000) }) })
  return {
    headroom, svc, poll, fable429,
    at: () => now,
    advance: (ms = 1000) => { now += ms },
    setWindows: (w: UsageWindow[]) => { windows = w },
    fail: () => { failing = true }
  }
}

type Host = ReturnType<typeof host>
const fableOf = (h: Host) => h.svc.snapshot().providers.claude.reports[0]?.windows.find(w => w.label === 'Fable')
const fableScore = (h: Host) => rankAccounts({ serviceId: 'claude-code', model: FABLE, names: ['a'], reports: h.svc.snapshot().providers.claude.reports, headroom: {}, load: {}, now: h.at() })[0].window

/** Fable spent this week, the week itself not: the state before either reset. */
async function spentFable(h: Host, fableReset: number) {
  await h.svc.list()
  h.poll([{ label: '5h', usedPercent: 10 }, { label: 'Weekly', usedPercent: 60, resetsAt: NOW + WEEK }, { label: 'Fable', usedPercent: 100, resetsAt: fableReset }])
  await h.svc.rebuildNow()
  expect(h.svc.hasRoom('claude', FABLE, 'a')).toBe(false)
}

for (const fable of [undefined, { label: 'Fable', usedPercent: 0 }] as const) {
  const name = fable ? 'Fable at 0%' : 'no Fable row'
  it(`a timed reset reads Fable as reset: a whole answer with ${name}`, async () => {
    const h = host('mac')
    await spentFable(h, NOW + 60_000)
    h.advance(120_000)
    h.poll([{ label: '5h', usedPercent: 0 }, { label: 'Weekly', usedPercent: 0, resetsAt: NOW + 2 * WEEK }, ...(fable ? [fable] : [])])
    await h.svc.rebuildNow()
    expect(fableOf(h)?.usedPercent ?? 0).toBe(0)
    expect(h.svc.hasRoom('claude', FABLE, 'a')).toBe(true)
    expect(fableScore(h)).toBe(1)
    h.svc.stop()
  })

  it(`an early reset frees Fable and retires its quota mark: a whole answer with ${name}`, async () => {
    const h = host('mac')
    await spentFable(h, NOW + 3 * 86400_000)
    h.fable429()
    h.advance()
    h.poll([{ label: '5h', usedPercent: 0 }, { label: 'Weekly', usedPercent: 0, resetsAt: NOW + WEEK }, ...(fable ? [fable] : [])])
    await h.svc.rebuildNow()
    expect(fableOf(h)?.usedPercent ?? 0).toBe(0)
    expect(h.headroom.view('claude-code', 'a', h.at(), FABLE).throttledUntil).toBeUndefined()
    expect(h.svc.hasRoom('claude', FABLE, 'a')).toBe(true)
    expect(fableScore(h)).toBe(1)
    h.svc.stop()
  })
}

it("the box's whole answer retires the Mac's stale Fable on both hosts", async () => {
  const mac = host('mac'), box = host('box')
  await spentFable(mac, NOW + 3 * 86400_000)
  mac.fable429()
  // The Mac's cache keeps its last answer; only the box polls after the early reset.
  await box.svc.list()
  for (const h of [mac, box]) h.advance()
  box.headroom.merge('mac', wire(mac.headroom.own()))
  box.poll([{ label: '5h', usedPercent: 0 }, { label: 'Weekly', usedPercent: 0, resetsAt: NOW + WEEK }])
  mac.headroom.merge('box', wire(box.headroom.own()))
  for (const h of [mac, box]) {
    await h.svc.rebuildNow()
    expect(h.svc.hasRoom('claude', FABLE, 'a')).toBe(true)
    expect(fableOf(h)).toBeUndefined()
  }
  expect(mac.headroom.view('claude-code', 'a', mac.at(), FABLE).throttledUntil).toBeUndefined()
  mac.svc.stop()
  box.svc.stop()
})

it("the Mac's older 100% arriving after the box's answer does not win", async () => {
  const mac = host('mac'), box = host('box')
  await spentFable(mac, NOW + 3 * 86400_000)
  await box.svc.list()
  for (const h of [mac, box]) h.advance()
  // The box answered before it ever heard of the Mac's Fable sample.
  box.poll([{ label: '5h', usedPercent: 0 }, { label: 'Weekly', usedPercent: 0, resetsAt: NOW + WEEK }])
  box.headroom.merge('mac', wire(mac.headroom.own()))
  mac.headroom.merge('box', wire(box.headroom.own()))
  for (const h of [mac, box]) {
    await h.svc.rebuildNow()
    expect(h.svc.hasRoom('claude', FABLE, 'a')).toBe(true)
  }
  mac.svc.stop()
  box.svc.stop()
})

it('a failed poll, a cached answer or a lone header window retires nothing', async () => {
  const h = host('mac')
  await spentFable(h, NOW + 3 * 86400_000)
  h.fable429()
  h.advance()
  // A lone window (a header sample) and an empty answer are not a whole answer.
  h.svc.observeFreshWindow('claude-code', 'a', { label: 'Weekly', usedPercent: 0, resetsAt: NOW + WEEK })
  h.svc.observeFreshAnswer('claude-code', 'a', [])
  // The cache answers without Fable: aliax-core fires no hook for it.
  h.setWindows([{ label: 'Weekly', usedPercent: 0, resetsAt: NOW + WEEK }])
  await h.svc.rebuildNow()
  expect(fableOf(h)?.usedPercent).toBe(100)
  expect(h.svc.hasRoom('claude', FABLE, 'a')).toBe(false)
  h.fail()
  await expect(h.svc.refresh('claude')).rejects.toThrow('usage unavailable')
  await h.svc.rebuildNow()
  expect(h.svc.hasRoom('claude', FABLE, 'a')).toBe(false)
  expect(h.headroom.view('claude-code', 'a', h.at(), FABLE).throttledUntil).toBeGreaterThan(h.at())
  h.svc.stop()
})

it('a whole answer with Fable still full keeps the account out for Fable alone', async () => {
  const h = host('mac')
  await spentFable(h, NOW + 3 * 86400_000)
  h.fable429()
  h.advance()
  h.poll([{ label: '5h', usedPercent: 0 }, { label: 'Weekly', usedPercent: 0, resetsAt: NOW + WEEK }, { label: 'Fable', usedPercent: 100, resetsAt: NOW + 3 * 86400_000 }])
  await h.svc.rebuildNow()
  expect(h.svc.hasRoom('claude', FABLE, 'a')).toBe(false)
  expect(h.svc.hasRoom('claude', 'claude-opus-5-5', 'a')).toBe(true)
  expect(fableScore(h)).toBe(0)
  expect(h.headroom.view('claude-code', 'a', h.at(), FABLE).throttledUntil).toBeGreaterThan(h.at())
  h.svc.stop()
})
