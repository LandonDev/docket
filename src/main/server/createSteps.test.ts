import { describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import { CHAT_DID_NOT_START, hasCreateSteps, runCreateSteps, type CreateStepParams } from './createSteps'

/**
 * A window's folded first send (createSteps.ts): the steps it ran between the create and the message run on the host,
 * in its order, each as its own request, so a fold reaches nothing its parts could not.
 */

const file = { at: 'file', host: 'box', path: '/w/Budget.xlsx' } as const
const far = { at: 'file', path: 'C:\\\\Budget.xlsx', host: 'pc' } as const

/** A step's params, whatever its method. */
const paramsOf = (req: ClientRequest): unknown => (req as { params?: unknown }).params

function stepper(fail: Partial<Record<string, string>> = {}) {
  const asked: ClientRequest[] = []
  let n = 0
  const step = async (req: ClientRequest): Promise<unknown> => {
    asked.push(req)
    if (fail[req.method]) throw new Error(fail[req.method])
    if (req.method === 'work.office.filesCopy') return { source: { at: 'file', host: 'box', path: '/w/.copies/Budget.xlsx' } }
    return {}
  }
  return { asked, step, id: () => `s${++n}` }
}

describe('a folded create', () => {
  it('runs nothing when it carries no step', async () => {
    expect(hasCreateSteps({})).toBe(false)
    expect(hasCreateSteps({ items: [] })).toBe(false)
    const s = stepper()
    expect(await runCreateSteps('t1', {}, s.step, s.id)).toEqual({ itemsFailed: [] })
    expect(s.asked).toEqual([])
  })

  it("a file's dock: one work.canvas.open for the new thread, as the window's hold sent it", async () => {
    const s = stepper()
    const p: CreateStepParams = { items: [{ kind: 'sheet', source: file, title: 'Budget' }] }
    expect(hasCreateSteps(p)).toBe(true)
    await runCreateSteps('t1', p, s.step, s.id)
    expect(s.asked.map((r) => r.method)).toEqual(['work.canvas.open'])
    expect(paramsOf(s.asked[0])).toEqual({ sessionId: 't1', kind: 'sheet', source: file, title: 'Budget' })
  })

  it("a far file's copy is made first and the thread opens the copy", async () => {
    const s = stepper()
    await runCreateSteps('t1', { items: [{ kind: 'sheet', source: far, title: 'Budget', copy: true }] }, s.step, s.id)
    expect(s.asked.map((r) => r.method)).toEqual(['work.office.filesCopy', 'work.canvas.open'])
    expect(paramsOf(s.asked[0])).toEqual({ sessionId: 't1', source: far })
    expect((paramsOf(s.asked[1]) as { source: unknown }).source).toEqual({ at: 'file', host: 'box', path: '/w/.copies/Budget.xlsx' })
  })

  it('the bridge, then the mail chat, then the items: each its own request with its own id', async () => {
    const s = stepper()
    await runCreateSteps('t1', { bridge: { macPeer: 'mac-1' }, mailAdopt: { workspaceId: 'w1', kind: 'mail', mailThreadId: 'mt1' }, items: [{ kind: 'sheet', source: file, title: 'B' }] }, s.step, s.id)
    expect(s.asked.map((r) => r.method)).toEqual(['macBridge.thread.set', 'work.mail.chat.adopt', 'work.canvas.open'])
    expect(paramsOf(s.asked[1])).toEqual({ workspaceId: 'w1', kind: 'mail', mailThreadId: 'mt1', sessionId: 't1' })
    expect(new Set(s.asked.map((r) => r.id)).size).toBe(3)
  })

  it('a mail chat the host will not adopt stops the message: nothing after it runs', async () => {
    const s = stepper({ 'work.mail.chat.adopt': 'Mail chats are off for this job.' })
    await expect(runCreateSteps('t1', { mailAdopt: { workspaceId: 'w1', kind: 'box' }, items: [{ kind: 'sheet', source: file, title: 'B' }] }, s.step, s.id)).rejects.toThrow(CHAT_DID_NOT_START)
    expect(s.asked.map((r) => r.method)).toEqual(['work.mail.chat.adopt'])
  })

  it('an item that does not open is named, and the message goes; a bridge that fails is let be', async () => {
    const s = stepper({ 'work.canvas.open': 'forbidden: outside the roots', 'macBridge.thread.set': 'needs approve' })
    const got = await runCreateSteps('t1', { bridge: { macPeer: 'mac-1' }, items: [{ kind: 'sheet', source: file, title: 'Budget' }] }, s.step, s.id)
    expect(got.itemsFailed).toEqual([{ title: 'Budget', error: 'forbidden: outside the roots' }])
  })

  it("an ordinary draft's speed and message run last, as session.tune then session.send for the new thread", async () => {
    const s = stepper()
    const p: CreateStepParams = { bridge: { macPeer: 'mac-1' }, tune: { ultrafast: true }, send: { text: 'hello', attachments: [{ path: '/w/a.txt', name: 'a.txt', kind: 'file' }] } }
    expect(hasCreateSteps({ send: { text: 'hello' } })).toBe(true)
    expect(hasCreateSteps({ tune: { fast: true } })).toBe(true)
    expect(await runCreateSteps('t1', p, s.step, s.id)).toEqual({ itemsFailed: [] })
    expect(s.asked.map((r) => r.method)).toEqual(['macBridge.thread.set', 'session.tune', 'session.send'])
    expect(paramsOf(s.asked[1])).toEqual({ sessionId: 't1', ultrafast: true })
    expect(paramsOf(s.asked[2])).toEqual({ sessionId: 't1', text: 'hello', attachments: [{ path: '/w/a.txt', name: 'a.txt', kind: 'file' }] })
  })

  it("a send the host refuses is answered as the send's own error; the steps before it stand", async () => {
    const s = stepper({ 'session.send': 'forbidden: session.send is outside app-managed roots', 'work.canvas.open': 'no such file' })
    const got = await runCreateSteps('t1', { items: [{ kind: 'sheet', source: file, title: 'B' }], send: { text: 'hello' } }, s.step, s.id)
    expect(got).toEqual({ itemsFailed: [{ title: 'B', error: 'no such file' }], sendError: 'forbidden: session.send is outside app-managed roots' })
  })

  it('a tune that fails stops the message, as the awaited tune did', async () => {
    const s = stepper({ 'session.tune': 'unknown session: t1' })
    const got = await runCreateSteps('t1', { tune: { fast: true }, send: { text: 'hello' } }, s.step, s.id)
    expect(got.sendError).toBe('unknown session: t1')
    expect(s.asked.map((r) => r.method)).toEqual(['session.tune'])
  })

  it('a mail chat the host will not adopt sends nothing, the tune and the message included', async () => {
    const s = stepper({ 'work.mail.chat.adopt': 'off' })
    await expect(runCreateSteps('t1', { mailAdopt: { workspaceId: 'w1', kind: 'box' }, tune: { fast: true }, send: { text: 'hello' } }, s.step, s.id)).rejects.toThrow(CHAT_DID_NOT_START)
    expect(s.asked.map((r) => r.method)).toEqual(['work.mail.chat.adopt'])
  })
})
