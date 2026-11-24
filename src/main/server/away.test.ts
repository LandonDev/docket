import { afterEach, describe, expect, it, vi } from 'vitest'
import { requiredCapability } from '@shared/capabilities'
import { AWAY_DECIDED_SETTING, AWAY_SETTING, AWAY_TALLY_MS, AwayService } from './away'
import { AWAY_APPROVAL_REPLY, AWAY_ON, MAC_AWAY_REFUSAL, MAC_AWAY_REFUSAL_LEGACY, isMacAwayRefusal } from './awayPrompts'

const settingsStore = () => {
  const rows = new Map<string, string>()
  return {
    rows,
    getSetting: (key: string) => rows.get(key) ?? null,
    setSetting: (key: string, value: string | null) => {
      if (value === null) rows.delete(key)
      else rows.set(key, value)
    }
  }
}

const make = (now = () => 1_000) => {
  const settings = settingsStore()
  const away = new AwayService({ ...settings, environmentId: 'env_mac', now })
  return { away, settings }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AwayService', () => {
  it('starts off and stamps a flip with the time and this host', () => {
    let t = 5_000
    const { away, settings } = make(() => t)
    expect(away.get().state).toMatchObject({ enabled: false, code: false, work: false, at: 0, by: '' })
    expect(away.set({ enabled: true })).toMatchObject({ enabled: true, code: true, work: true, at: 5_000, by: 'env_mac' })
    expect(JSON.parse(settings.rows.get(AWAY_SETTING)!)).toMatchObject({ enabled: true, code: true, work: true, at: 5_000, by: 'env_mac' })
    t = 6_000
    // A flip to the value it already has changes nothing, not even the stamp.
    expect(away.set({ enabled: true }).at).toBe(5_000)
  })

  it('reads the state back from the settings table', () => {
    const settings = settingsStore()
    settings.setSetting(AWAY_SETTING, JSON.stringify({ enabled: true, at: 9, by: 'env_box' }))
    const away = new AwayService({ ...settings, environmentId: 'env_mac' })
    expect(away.kinds()).toEqual({ code: true, work: true })
    expect(away.get().state.by).toBe('env_box')
  })

  it('applies a peer state only when it is newer', () => {
    const { away } = make(() => 2_000)
    away.set({ enabled: true })
    expect(away.apply({ enabled: false, at: 1_500, by: 'env_box' })).toBe(false)
    expect(away.kinds()).toEqual({ code: true, work: true })
    expect(away.apply({ enabled: false, at: 2_000, by: 'env_box' })).toBe(false)
    expect(away.kinds()).toEqual({ code: true, work: true })
    expect(away.apply({ enabled: false, at: 2_500, by: 'env_box' })).toBe(true)
    expect(away.get().state).toMatchObject({ enabled: false, code: false, work: false, at: 2_500, by: 'env_box' })
  })

  it('takes a newer stamp of the same value without telling anyone', () => {
    const { away } = make(() => 2_000)
    away.set({ enabled: true })
    const heard = vi.fn()
    away.onChange(heard)
    expect(away.apply({ enabled: true, at: 3_000, by: 'env_box' })).toBe(false)
    expect(away.get().state.at).toBe(3_000)
    expect(heard).not.toHaveBeenCalled()
  })

  it('tells its listeners on every change of the state', () => {
    let t = 1_000
    const { away } = make(() => t)
    const heard = vi.fn()
    away.onChange(heard)
    away.set({ enabled: true })
    t = 2_000
    away.set({ enabled: false })
    away.set({ enabled: false })
    expect(heard).toHaveBeenCalledTimes(2)
    expect(heard.mock.calls[0][0].state.enabled).toBe(true)
    expect(heard.mock.calls[0][1]).toEqual(['code', 'work'])
    expect(heard.mock.calls[1][0].state.enabled).toBe(false)
  })

  it('writes the tally a second after its counts and pushes it', () => {
    vi.useFakeTimers()
    const { away, settings } = make()
    away.set({ enabled: true })
    const heard = vi.fn()
    away.onChange(heard)
    away.count('a')
    away.count('a')
    away.count('b')
    expect(away.get().decided.threads).toEqual([
      { sessionId: 'a', count: 2 },
      { sessionId: 'b', count: 1 }
    ])
    expect(JSON.parse(settings.rows.get(AWAY_DECIDED_SETTING)!).threads).toEqual([])
    expect(heard).not.toHaveBeenCalled()
    vi.advanceTimersByTime(AWAY_TALLY_MS)
    expect(JSON.parse(settings.rows.get(AWAY_DECIDED_SETTING)!).threads).toHaveLength(2)
    expect(heard).toHaveBeenCalledTimes(1)
    expect(heard.mock.calls[0][1]).toEqual([])
  })

  it('starts a new tally when away turns on and keeps it when it turns off', () => {
    let t = 1_000
    const { away } = make(() => t)
    away.set({ enabled: true })
    away.count('a')
    t = 2_000
    away.set({ enabled: false })
    expect(away.get().decided.threads).toEqual([{ sessionId: 'a', count: 1 }])
    t = 3_000
    away.set({ enabled: true })
    expect(away.get().decided).toEqual({ since: 3_000, threads: [] })
  })

  it('holds the four states: none, Code only, Work only, both', () => {
    let t = 1_000
    const { away } = make(() => t)
    expect(away.kinds()).toEqual({ code: false, work: false })
    t = 2_000
    expect(away.set({ code: true })).toMatchObject({ enabled: false, code: true, work: false })
    expect([away.on('code'), away.on('work')]).toEqual([true, false])
    t = 3_000
    expect(away.set({ code: false, work: true })).toMatchObject({ enabled: false, code: false, work: true })
    expect([away.on('code'), away.on('work')]).toEqual([false, true])
    t = 4_000
    // `enabled` is what an old reader sees: true only once both kinds are away.
    expect(away.set({ code: true })).toMatchObject({ enabled: true, code: true, work: true })
  })

  it('flips one kind and leaves the other, telling only the kind that changed', () => {
    const { away } = make()
    const heard = vi.fn()
    away.onChange(heard)
    away.set({ work: true })
    expect(heard.mock.calls[0][1]).toEqual(['work'])
    away.set({ code: true, work: true })
    expect(heard.mock.calls[1][1]).toEqual(['code'])
    // The same kinds again: nothing changes, nobody hears.
    away.set({ code: true })
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it("an old client's set true sets both, false clears both", () => {
    const { away } = make()
    away.set({ work: true })
    expect(away.set({ enabled: true })).toMatchObject({ enabled: true, code: true, work: true })
    expect(away.set({ enabled: false })).toMatchObject({ enabled: false, code: false, work: false })
  })

  it("an old client's get reads away only while both kinds are", () => {
    const { away } = make()
    away.set({ code: true })
    expect(away.get().state.enabled).toBe(false)
    away.set({ work: true })
    expect(away.get().state.enabled).toBe(true)
  })

  it('a flip that names a kind ignores `enabled`: a window that missed a flip never sets the other kind back', () => {
    const { away } = make()
    away.set({ code: true, work: true })
    // Another window turned Work off; this one still saw both on and turns Code off, sending its stale "both".
    away.set({ work: false })
    expect(away.set({ enabled: true, code: true })).toMatchObject({ code: true, work: false })
    expect(away.set({ enabled: false, code: false })).toMatchObject({ code: false, work: false })
  })

  it('migrates a row an older build wrote: on is both kinds, off is neither', () => {
    const on = settingsStore()
    on.setSetting(AWAY_SETTING, JSON.stringify({ enabled: true, at: 9, by: 'env_box' }))
    expect(new AwayService({ ...on, environmentId: 'env_mac' }).kinds()).toEqual({ code: true, work: true })
    const off = settingsStore()
    off.setSetting(AWAY_SETTING, JSON.stringify({ enabled: false, at: 9, by: 'env_box' }))
    expect(new AwayService({ ...off, environmentId: 'env_mac' }).kinds()).toEqual({ code: false, work: false })
  })

  it("takes an older peer's state as both kinds, and gives one `enabled` as both", () => {
    const { away } = make(() => 1_000)
    away.set({ code: true })
    expect(away.apply({ enabled: true, at: 2_000, by: 'env_box' })).toBe(true)
    expect(away.kinds()).toEqual({ code: true, work: true })
    expect(away.apply({ enabled: false, at: 3_000, by: 'env_box' })).toBe(true)
    expect(away.kinds()).toEqual({ code: false, work: false })
    // A newer peer's Work-only state stays Work only.
    expect(away.apply({ enabled: false, code: false, work: true, at: 4_000, by: 'env_box' })).toBe(true)
    expect(away.kinds()).toEqual({ code: false, work: true })
  })

  it('keeps one stretch while any kind is away', () => {
    let t = 1_000
    const { away } = make(() => t)
    away.set({ code: true })
    away.count('a')
    t = 2_000
    away.set({ work: true })
    away.set({ code: false })
    expect(away.get().decided).toEqual({ since: 1_000, threads: [{ sessionId: 'a', count: 1 }] })
    t = 3_000
    away.set({ work: false })
    away.set({ code: true })
    expect(away.get().decided).toEqual({ since: 3_000, threads: [] })
  })

  it('flushes a pending tally on dispose', () => {
    vi.useFakeTimers()
    const { away, settings } = make()
    away.set({ enabled: true })
    away.count('a')
    away.dispose()
    expect(JSON.parse(settings.rows.get(AWAY_DECIDED_SETTING)!).threads).toEqual([{ sessionId: 'a', count: 1 }])
  })
})

describe('away capabilities', () => {
  it('reads with read, flips with approve, applies a peer state with admin', () => {
    expect(requiredCapability({ method: 'away.get' })).toBe('read')
    expect(requiredCapability({ method: 'away.set', params: { enabled: true } })).toBe('approve')
    expect(requiredCapability({ method: 'away.apply', params: { state: { enabled: true, at: 1, by: 'x' } } })).toBe('admin')
  })
})

describe('what the thread hears', () => {
  it('says approvals are allowed while away and names pay and subscribe as the one denial', () => {
    expect(AWAY_ON).toContain('is allowed, and each one is recorded')
    expect(AWAY_ON).toContain('a computer act flagged pay or subscribe is denied')
    expect(AWAY_ON).not.toContain('are denied while they are away')
    expect(AWAY_APPROVAL_REPLY).toContain('spends money')
  })

  it('knows a Mac refusal of either build', () => {
    expect(isMacAwayRefusal(MAC_AWAY_REFUSAL)).toBe(true)
    expect(isMacAwayRefusal(`mac.run: ${MAC_AWAY_REFUSAL_LEGACY}`)).toBe(true)
    expect(isMacAwayRefusal('refused: the thread is paused')).toBe(false)
  })
})
