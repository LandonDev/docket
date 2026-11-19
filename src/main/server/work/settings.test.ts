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
})
