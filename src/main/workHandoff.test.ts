import { EventEmitter } from 'node:events'
import type { App } from 'electron'
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { describe, expect, it, vi } from 'vitest'
import { WORK_HANDOFF, queueWorkHandoff, registerWorkHandoff, willContinueWork, workHandoffParams } from './workHandoff'

describe('Work Handoff', () => {
  it('claims the activity type declared for the Mac bundle', () => {
    const config = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8')
    const parsed = load(config) as { mac: { extendInfo: { NSUserActivityTypes?: string[] } } }
    expect(parsed.mac.extendInfo.NSUserActivityTypes).toContain(WORK_HANDOFF)
    expect(willContinueWork(WORK_HANDOFF)).toBe(true)
    expect(willContinueWork('another.app.open')).toBe(false)
  })

  it('passes a valid activity to the same Work route, keeping both held and thread', () => {
    const info = { target: { held: { at: 'lifeos', table: 'calendarOps', id: 'h1' }, thread: 's1' } }
    expect(workHandoffParams(WORK_HANDOFF, info)).toEqual(info)
    expect(workHandoffParams('another.app.open', info)).toBeNull()
  })

  it('keeps the latest launch activity until the first window is ready', () => {
    const open = vi.fn(async () => {})
    const handoff = queueWorkHandoff(open, vi.fn())
    const first = { target: { thread: 's1' } }
    const second = { target: { thread: 's2' } }
    handoff.receive(first)
    handoff.receive(second)
    expect(open).not.toHaveBeenCalled()
    handoff.windowReady()
    handoff.windowReady()
    expect(open.mock.calls).toEqual([[second]])
    handoff.receive(first)
    expect(open.mock.calls).toEqual([[second], [first]])
  })

  it('reports a failed local reveal with the host’s own words', async () => {
    const words = 'Open a TempCode window on this computer first.'
    const notice = vi.fn()
    const handoff = queueWorkHandoff(async () => { throw new Error(words) }, notice)
    handoff.windowReady()
    handoff.receive({ target: { thread: 's1' } })
    await Promise.resolve()
    expect(notice.mock.calls).toEqual([[words]])
  })

  it('reports invalid data for its own activity type and leaves other activities alone', () => {
    const app = new EventEmitter()
    const open = vi.fn()
    const refuse = vi.fn()
    const event = { preventDefault: vi.fn() }
    registerWorkHandoff(app as unknown as App, open, refuse)
    app.emit('continue-activity', event, 'other.activity', {})
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(refuse).not.toHaveBeenCalled()
    app.emit('continue-activity', event, WORK_HANDOFF, {})
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(refuse).toHaveBeenCalledWith('bad request: Pick a known Work destination by its ID.')
    expect(open).not.toHaveBeenCalled()
  })

  it.each([
    null, { target: { url: 'https://example.test' } },
    { target: { settings: 'unknown' } },
    { target: { item: '/tmp/file' } },
    { target: { item: 'i1', host: 'other' } },
    { target: { thread: 's1' }, extra: 'x' },
  ])('drops malformed activity data: %j', (info) => {
    expect(workHandoffParams(WORK_HANDOFF, info)).toBeNull()
  })
})
