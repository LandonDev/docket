import { describe, expect, it } from 'vitest'
import { APPROVAL, QUESTION, STREAM, STREAM_START, walkReply } from './docketWalkProvider'

describe('Docket walk provider', () => {
  it.each([
    { prompt: APPROVAL, name: 'Bash', id: 'toolu_walk_approval' },
    { prompt: QUESTION, name: 'AskUserQuestion', id: 'toolu_walk_question' }
  ])('offers $name once, when the harness advertises it', async ({ prompt, name, id }) => {
    const user = { role: 'user', content: prompt }
    expect(walkReply({ messages: [user] }, 'msg-test')).toBeUndefined()
    const tools = [{ name }]
    const reply = await walkReply({ tools, messages: [user] }, 'msg-test')?.text()
    expect(reply).toContain(`"id":"${id}","name":"${name}"`)
    expect(reply).toContain('"stop_reason":"tool_use"')
    expect(walkReply({ tools, messages: [user, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id }] }] }, 'msg-test')).toBeUndefined()
  })

  it('writes streaming text as distinct frames before its end marker', async () => {
    const reply = walkReply({ messages: [{ role: 'user', content: STREAM }] }, 'msg-stream')!
    const reader = reply.body!.getReader()
    const decoder = new TextDecoder()
    const read = async () => decoder.decode((await reader.read()).value)
    expect(await read()).toContain('event: message_start')
    expect(await read()).toContain('event: content_block_start')
    const first = await read()
    expect(first).toContain(STREAM_START)
    expect(first).not.toContain('The gateway starts a listener')
    expect(await read()).toContain('The gateway starts a listener')
    await reader.cancel()
  })
})
