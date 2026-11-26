import { describe, expect, it } from 'vitest'
import { chainRestart } from './restarts'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('a restart of the fixed port', () => {
  it('is listening before its endpoints are published, so the boot goes on while the old proofs expire', async () => {
    const publish = deferred()
    const steps: string[] = []
    const restart = chainRestart(Promise.resolve(), async () => void steps.push('listen'), async () => {
      steps.push('publish start')
      await publish.promise
      steps.push('published')
    })
    await restart.listening
    await flush()
    expect(steps).toEqual(['listen', 'publish start'])
    publish.resolve()
    await restart.published
    expect(steps).toEqual(['listen', 'publish start', 'published'])
  })

  it('runs after the restart before it has published, one at a time as before', async () => {
    const firstPublish = deferred()
    const steps: string[] = []
    const first = chainRestart(Promise.resolve(), async () => void steps.push('listen 1'), () => firstPublish.promise.then(() => void steps.push('published 1')))
    const second = chainRestart(first.published, async () => void steps.push('listen 2'), async () => void steps.push('published 2'))
    await first.listening
    await flush()
    expect(steps).toEqual(['listen 1'])
    firstPublish.resolve()
    await second.published
    expect(steps).toEqual(['listen 1', 'published 1', 'listen 2', 'published 2'])
  })

  it('a listener that fails fails the boot as it did, and publishes nothing', async () => {
    let published = 0
    const restart = chainRestart(Promise.resolve(), async () => { throw new Error('port taken') }, async () => void published++)
    await expect(restart.listening).rejects.toThrow('port taken')
    await expect(restart.published).rejects.toThrow('port taken')
    expect(published).toBe(0)
  })
})
