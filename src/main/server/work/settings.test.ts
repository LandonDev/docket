import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDb, Store } from '../db'
import { WorkSettingsStore } from './settings'

let dir: string
let db: ReturnType<typeof openDb>
let store: Store
let settings: WorkSettingsStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-work-settings-'))
  db = openDb(join(dir, 'test.db'))
  store = new Store(db)
  settings = new WorkSettingsStore(store)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

it('the switch is off until it is set, one row in the host settings table', () => {
  expect(settings.get()).toEqual({ enabled: false })
  expect(settings.enabled()).toBe(false)
  expect(store.getSetting('work')).toBeNull()
  expect(settings.set({ enabled: true })).toEqual({ enabled: true })
  expect(store.getSetting('work')).toBe('{"enabled":true}')
  expect(new WorkSettingsStore(store).enabled()).toBe(true)
})

it('a stored value that is not the switch reads as off', () => {
  store.setSetting('work', '{"enabled":"yes"}')
  expect(settings.get()).toEqual({ enabled: false })
  store.setSetting('work', 'not json')
  expect(settings.enabled()).toBe(false)
})

it('listeners hear a change once, and nothing when the value stays', () => {
  const heard: boolean[] = []
  const off = settings.onChange((s) => heard.push(s.enabled))
  settings.set({ enabled: true })
  settings.set({ enabled: true })
  settings.set({ enabled: false })
  off()
  settings.set({ enabled: true })
  expect(heard).toEqual([true, false])
})

it("a workspace's Work settings default, merge a patch, and refuse a workspace this host lacks", () => {
  store.insertWorkspace({ id: 'w1', name: 'Purdue', path: '/work/Purdue', git: false, createdAt: 1 })
  expect(settings.workspace('w1')).toEqual({ mayUseDesktop: [], voice: false })
  settings.setWorkspace('w1', { mayUseDesktop: ['env_mac'] })
  settings.setWorkspace('w1', { voice: true, model: 'claude-fable-5-1' })
  expect(settings.workspace('w1')).toEqual({ mayUseDesktop: ['env_mac'], voice: true, model: 'claude-fable-5-1' })
  expect(() => settings.setWorkspace('nope', { voice: true })).toThrow('no such workspace: nope')
  expect(settings.workspace('nope')).toEqual({ mayUseDesktop: [], voice: false })
  // the Windows VM is a setting of its own, off until it is turned on, and never a host in mayUseDesktop
  expect(settings.workspace('w1').windowsVm).toBeUndefined()
  settings.setWorkspace('w1', { windowsVm: true })
  expect(settings.workspace('w1')).toMatchObject({ windowsVm: true, mayUseDesktop: ['env_mac'] })
})

it('a removed computer leaves every workspace for good: a later binding of the same env id regains nothing (F10)', () => {
  store.insertWorkspace({ id: 'w1', name: 'Purdue', path: '/work/Purdue', git: false, createdAt: 1 })
  store.insertWorkspace({ id: 'w2', name: 'Cosmic', path: '/work/Cosmic', git: false, createdAt: 1 })
  let live = false
  const gated = new WorkSettingsStore(store, () => live)
  settings.setWorkspace('w1', { mayUseDesktop: ['env_mac', 'env_pc'] })
  settings.setWorkspace('w2', { mayUseDesktop: ['env_pc'] })
  expect(gated.dropHost('env_pc')).toBe(2)
  live = true
  expect(gated.workspace('w1').mayUseDesktop).toEqual(['env_mac'])
  expect(gated.workspace('w2').mayUseDesktop).toEqual([])
})

it('a hundred reads of the switch read the setting once, and a write by anyone is seen by the very next read', () => {
  let reads = 0
  const counted = new WorkSettingsStore({
    getSetting: (key) => (reads++, store.getSetting(key)),
    setSetting: (key, value) => store.setSetting(key, value),
    getWorkspaceWorkSettings: (id) => store.getWorkspaceWorkSettings(id),
    setWorkspaceWorkSettings: (id, value) => store.setWorkspaceWorkSettings(id, value),
    onSettingSet: (key, fn) => store.onSettingSet(key, fn)
  })
  for (let i = 0; i < 100; i++) expect(counted.enabled()).toBe(false)
  expect(reads).toBe(1)
  // Its own set, then a write that never went through this object (another part of the host, a restore).
  counted.set({ enabled: true })
  expect(counted.enabled()).toBe(true)
  store.setSetting('work', '{"enabled":false}')
  expect(counted.enabled()).toBe(false)
  store.setSetting('work', null)
  expect(counted.enabled()).toBe(false)
  // Another setting's write drops nothing.
  const before = reads
  store.setSetting('other', 'x')
  for (let i = 0; i < 10; i++) counted.enabled()
  expect(reads).toBe(before)
})

it('a store that cannot say when the switch is written is read every time: nothing is kept', () => {
  let reads = 0
  let value: string | null = null
  const plain = new WorkSettingsStore({
    getSetting: () => (reads++, value),
    setSetting: (_key, next) => void (value = next),
    getWorkspaceWorkSettings: () => null,
    setWorkspaceWorkSettings: () => true
  })
  expect(plain.enabled()).toBe(false)
  value = '{"enabled":true}'
  expect(plain.enabled()).toBe(true)
  expect(reads).toBe(2)
})
