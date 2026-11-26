import { setTimeout as delay } from 'node:timers/promises'
import { fakeMessage, startFakeProvider, type FakeRequest, type FakeTool } from './fakeProvider'

export const QUESTION = 'Which sign-in should the practice site use?'
export const APPROVAL = 'Write a marker for the Docket walk.'
export const STREAM = 'Describe the practice site in a few short paragraphs.'
export const STREAM_START = 'The practice site has one small gateway.'
const STREAM_TEXT = [
  STREAM_START,
  ' The gateway starts a listener and reports when it is ready.',
  ' The test waits for that report before it opens a connection.',
  '\n\nA second test gives each profile its own port.',
  ' This lets the two profiles run side by side.',
  ' The logs name each listener so its result is easy to find.',
  '\n\nThe last step checks that both listeners close.',
  ' The next test can then use either port without waiting.'
]

function walkTool(body: FakeRequest, prompt: string): FakeTool | undefined {
  const tool = prompt.includes(QUESTION) ? {
    id: 'toolu_walk_question', name: 'AskUserQuestion',
    input: { questions: [
      { question: QUESTION, header: 'Sign-in', multiSelect: false, options: [
        { label: 'Email link', description: 'Send a link for each sign-in.' },
        { label: 'Passkey', description: 'Use a passkey saved on this device.' },
        { label: 'Password', description: 'Keep a password and offer a reset link.' }
      ] }
    ] }
  } : prompt.includes(APPROVAL) ? {
    id: 'toolu_walk_approval', name: 'Bash',
    input: { command: "printf '%s\\n' 'Practice marker' > walk-marker.txt", description: 'Write a practice marker' }
  } : undefined
  if (tool && body.tools?.some(({ name }) => name === tool.name)
    && !JSON.stringify(body.messages).includes(`"tool_use_id":"${tool.id}"`)) return tool
}

async function* streamFrames(model: string, id: string): AsyncGenerator<string> {
  const [start, block, , ...end] = fakeMessage(model, undefined, id).trimEnd().split('\n\n')
  yield start + '\n\n'
  yield block + '\n\n'
  for (const text of STREAM_TEXT) {
    await delay(450)
    yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`
  }
  for (const frame of end) yield frame + '\n\n'
}

export function walkReply(body: FakeRequest, id: string): Response | undefined {
  const prompt = (body.messages ?? []).filter(message => message.role === 'user').flatMap(({ content }) =>
    typeof content === 'string' ? [content] : content.filter(block => block.type === 'text').map(block => block.text ?? '')
  ).join('\n')
  const model = body.model ?? 'claude-haiku-5-5'
  const tool = walkTool(body, prompt)
  const headers = { 'content-type': 'text/event-stream' }
  if (tool) return new Response(fakeMessage(model, tool, id), { headers })
  if (!prompt.includes(STREAM)) return

  const frames = streamFrames(model, id)
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    async pull(controller) {
      const frame = await frames.next()
      if (frame.done) controller.close()
      else controller.enqueue(encoder.encode(frame.value))
    },
    async cancel() { await frames.return(undefined) }
  }), { headers })
}

export const startWalkProvider: typeof startFakeProvider = (onMessage, browserTurn, mailReply) =>
  startFakeProvider(onMessage, browserTurn, mailReply, walkReply)
