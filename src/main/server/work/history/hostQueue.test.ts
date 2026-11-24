import { describe, expect, it } from 'vitest'
import type { History } from 'work-kit/collab-server'
import { queuedHistory } from './hostQueue'

/** The host's one turn per document around the history (hostQueue.ts): a decision's check runs after a write asked before it. */

function fakeHistory() {
  const branch = { id: 'b1', editedAt: 1, text: 'Alpha!' }
  const log: string[] = []
  const tick = () => new Promise((done) => setTimeout(done, 5))
  const raw = {
    branches: async () => [{ ...branch }],
    write: async (_name: string, _who: string, markdown: string) => {
      await tick()
      branch.editedAt += 1
      branch.text = markdown
      log.push(`write ${markdown}`)
      return { mode: 'branch', branchId: 'b1', versionId: 'v1' }
    },
    accept: async () => {
      log.push(`accept ${branch.text}`)
      return { versionId: 'v2', left: 0 }
    }
  } as unknown as History
  return { raw, branch, log }
}

describe("the host's turn per document", () => {
  it("runs a decision's check after an agent's write asked just before it, so the branch he took is the one checked", async () => {
    const { raw, log } = fakeHistory()
    const h = queuedHistory(raw)
    const read = 1
    // The agent rewrites its branch; his Accept, bound to the branch as he read it, comes before that write lands.
    const write = h.write('doc', 'agent:box:t1', 'Alpha, sent to everyone', { because: 'own', shared: true })
    const decide = h.inTurn('doc', async (under) => {
      const now = (await under.branches('doc')).find((b) => b.id === 'b1')!
      if (now.editedAt !== read) throw new Error('moved')
      return under.accept('doc', 'b1', 'all')
    })
    await write
    await expect(decide).rejects.toThrow('moved')
    expect(log).toEqual(['write Alpha, sent to everyone'])
    // Without the turn, the same check reads the branch before the write lands, and takes words he never saw.
    const { raw: bare, log: bareLog } = fakeHistory()
    const racing = bare.write('doc', 'agent:box:t1', 'Alpha, sent to everyone', { because: 'own', shared: true })
    const seen = (await bare.branches('doc')).find((b) => b.id === 'b1')!.editedAt
    await racing
    if (seen === read) await bare.accept('doc', 'b1', 'all')
    expect(bareLog).toEqual(['write Alpha, sent to everyone', 'accept Alpha, sent to everyone'])
  })

  it('keeps one document from waiting on another, and goes on after an act that failed', async () => {
    const { raw } = fakeHistory()
    const h = queuedHistory(raw)
    const order: string[] = []
    const slow = h.inTurn('a', async () => (await new Promise((done) => setTimeout(done, 20)), order.push('a')))
    const quick = h.inTurn('b', async () => order.push('b'))
    await Promise.all([slow, quick])
    expect(order).toEqual(['b', 'a'])
    await expect(h.inTurn('a', async () => Promise.reject(new Error('no')))).rejects.toThrow('no')
    expect(await h.inTurn('a', async () => 'after')).toBe('after')
  })
})
