import { describe, expect, it, vi } from 'vitest'
import { HeldAnswers } from './heldAnswer'

const never = <V>(): Promise<V> => new Promise<V>(() => {})

function deferred<V>(): { promise: Promise<V>; resolve: (value: V) => void } {
  let resolve!: (value: V) => void
  const promise = new Promise<V>((r) => (resolve = r))
  return { promise, resolve }
}

describe('HeldAnswers', () => {
  it('a first ask whose work never ends gets the fallback within the bound', async () => {
    const answers = new HeldAnswers<string[]>({ waitMs: 30, fallback: () => [] })
    const started = performance.now()
    await expect(answers.get('k', never)).resolves.toEqual([])
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('a held answer comes at once while its refresh never ends', async () => {
    const answers = new HeldAnswers<number>({ waitMs: 1_000, fallback: () => -1 })
    await answers.get('k', async () => 1)
    const started = performance.now()
    await expect(answers.get('k', never)).resolves.toBe(1)
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('one refresh per key at a time, and none while the held answer is fresh', async () => {
    let now = 0
    const answers = new HeldAnswers<number>({ waitMs: 1_000, freshMs: 100, fallback: () => -1, now: () => now })
    const compute = vi.fn(async () => 1)
    await answers.get('k', compute)
    await answers.get('k', compute)
    expect(compute).toHaveBeenCalledTimes(1)
    now = 100
    const slow = deferred<number>()
    const behind = vi.fn(() => slow.promise)
    await answers.get('k', behind)
    await answers.get('k', behind)
    expect(behind).toHaveBeenCalledTimes(1)
  })

  it('a refresh that changes the answer tells; one that does not stays quiet', async () => {
    const onFresh = vi.fn()
    const answers = new HeldAnswers<number>({ waitMs: 1_000, fallback: () => -1, onFresh })
    await answers.get('k', async () => 1)
    const same = deferred<number>()
    await answers.get('k', () => same.promise)
    same.resolve(1)
    await same.promise
    await Promise.resolve()
    expect(onFresh).not.toHaveBeenCalled()
    const moved = deferred<number>()
    await answers.get('k', () => moved.promise)
    moved.resolve(2)
    await vi.waitFor(() => expect(onFresh).toHaveBeenCalledWith('k', 2))
    await expect(answers.get('k', never)).resolves.toBe(2)
  })

  it('a first ask that got the fallback is told when its answer lands, and the next ask reads it', async () => {
    const onFresh = vi.fn()
    const answers = new HeldAnswers<number>({ waitMs: 10, fallback: () => -1, onFresh })
    const late = deferred<number>()
    await expect(answers.get('k', () => late.promise)).resolves.toBe(-1)
    late.resolve(7)
    await vi.waitFor(() => expect(onFresh).toHaveBeenCalledWith('k', 7))
    await expect(answers.get('k', never)).resolves.toBe(7)
  })

  it('stale makes the next ask refresh whatever its age; set holds a known answer', async () => {
    const now = 0
    const answers = new HeldAnswers<number>({ waitMs: 1_000, freshMs: 60_000, fallback: () => -1, now: () => now })
    await answers.get('k', async () => 1)
    const compute = vi.fn(async () => 2)
    await answers.get('k', compute)
    expect(compute).not.toHaveBeenCalled()
    answers.stale('k')
    await answers.get('k', compute)
    expect(compute).toHaveBeenCalledTimes(1)
    answers.set('k', 9)
    await expect(answers.get('k', never)).resolves.toBe(9)
  })

  it('keeps at most `max` keys, dropping the longest unasked', async () => {
    const answers = new HeldAnswers<number>({ waitMs: 10, fallback: () => -1, max: 2, freshMs: 60_000 })
    await answers.get('a', async () => 1)
    await answers.get('b', async () => 2)
    await answers.get('a', never)
    await answers.get('c', async () => 3)
    await expect(answers.get('a', never)).resolves.toBe(1)
    await expect(answers.get('b', never)).resolves.toBe(-1)
  })

  it('a first ask whose work fails inside the bound fails', async () => {
    const answers = new HeldAnswers<number>({ waitMs: 1_000, fallback: () => -1 })
    await expect(answers.get('k', async () => Promise.reject(new Error('no repo')))).rejects.toThrow('no repo')
  })
})
