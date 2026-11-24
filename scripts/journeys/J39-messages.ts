import { createHash } from 'node:crypto'
import { evidence, PAGE, see, storedText, wordsIn } from './lib/lifeosJourney'
import { SECTOR } from './lib/lifeosSeed'
import { journey, step, type Context } from './lib/record'

const CHAT = 'Spring LAN'
const OPEN = 'Thanks, I have the setup notes.'
const REPLY = 'I will bring the room map.'
const FILE = 'Spring LAN notes.txt'
const TEXT = 'Doors open at noon.'
type File = { _id: string; name: string; status: string; url?: string }
type Message = { _id: string; text: string; files: File[]; reply?: { status: string; outboxId: string } }
const selected = new WeakMap<Context, string>()
const messages = (context: Context) => context.pair.sandbox!.query<{ page: Message[] }>('chats:messages', { chatId: selected.get(context)!, paginationOpts: PAGE })

export function queuedChatWords(line: string): boolean {
  return /\b(?:queued|sending)\b/i.test(line) && !/\bsent\b/i.test(line)
}

export default journey({
  id: 'J39', title: 'Open a conversation, queue a reply, and open its file', tier: 2, shapes: ['S'],
  steps: [
    step('Open the Slack conversation from Messages and read the stored message', async (context) => {
      const { pair, workspace } = context
      const chats = await pair.sandbox!.query<{ page: { _id: string; name: string; source: string }[] }>('chats:list', { sector: SECTOR, paginationOpts: PAGE })
      const chat = chats.page.find((row) => row.name === CHAT && row.source === 'slack')
      if (!chat) throw new Error('The sandbox has no Spring LAN Slack chat')
      selected.set(context, chat._id)
      await pair.showWork(workspace, 'Messages')
      await pair.page.clickOn(`[data-messages-list] [data-menu-id=${JSON.stringify(chat._id)}]`)
      await see(pair.page, '[data-conversation]', OPEN)
      const row = (await messages(context)).page.find((row) => row.text === OPEN)
      if (!row) throw new Error('LifeOS has no stored message matching the conversation')
      evidence(context, 'opened', { chat, row })
    }),
    step('Send his own reply and see it queued without a Sent claim', async (context) => {
      const { pair } = context
      await pair.page.clickOn('[data-conversation] [data-composer] textarea')
      await pair.page.typeKeys(REPLY)
      await pair.page.watchToasts()
      await pair.page.clickOn('[data-conversation] [data-composer] button', 'Send')
      let row: Message | undefined
      await pair.page.until('the queued reply and honest status', 10_000, async () => {
        row = (await messages(context)).page.find((row) => row.text === REPLY)
        if (row?.reply?.status !== 'queued') return false
        const line = await wordsIn(pair.page, `[data-block=${JSON.stringify(row._id)}] [data-reply]`)
        const said = await pair.page.toasts(true)
        return queuedChatWords(line) && !said.some((line) => /^Sent\b/.test(line))
      })
      const queue = await pair.sandbox!.query<{ _id: string; status: string }[]>('outbox:list', { status: 'queued' })
      if (!queue.some(({ _id }) => _id === row!.reply!.outboxId)) throw new Error('LifeOS has no queued outbox row for the reply')
      evidence(context, 'queued', { row, toasts: await pair.page.toasts(true) })
    }),
    step('end: the chat file opens beside the conversation and its bytes match LifeOS', async (context) => {
      const { pair } = context
      const file = (await messages(context)).page.flatMap((row) => row.files).find((file) => file.name === FILE)
      if (!file || file.status !== 'stored') throw new Error('The sandbox chat file has no stored bytes')
      const body = await storedText(context, file.url)
      if (!body.includes(TEXT)) throw new Error('The stored file does not contain the setup notes')
      evidence(context, 'stored-file', { id: file._id, sha256: createHash('sha256').update(body).digest('hex') })
      await pair.page.resize(1680)
      pair.later(() => pair.page.resize(1280))
      await pair.page.clickOn(`[data-conversation] [data-file=${JSON.stringify(file._id)}]`)
      await see(pair.page, '[data-canvas-seat]', FILE)
      await see(pair.page, '.tiptap', TEXT)
      if (!(await messages(context)).page.some((row) => row.text === REPLY && row.reply?.status === 'queued')) throw new Error('The reply left the sandbox queue')
      await see(pair.page, '[data-conversation]', OPEN)
      await pair.page.shot(context.folder + '/file.png')
    })
  ]
})
