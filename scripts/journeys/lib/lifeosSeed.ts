import type { Value } from 'convex/values'

export const SECTOR = 'purdue'
export const GUEST_DOC = 'Spring LAN practice invitation'
export const GUEST_WORDS = 'Practice starts at noon. Check-in opens at the north doors.'
export const FIRST_MAIL = 'Spring LAN room plan'
export const SECOND_MAIL = 'Spring LAN check-in'
export const MOVED_EVENT = 'Test the projectors'
export const FIRST_CLASH = 'Check the microphones'
export const NEXT_CLASH = 'Lock the equipment cupboard'
export const ZONE = 'America/New_York'
const DANA = { name: 'Dana Lee', address: 'dana@example.com' }
const SAM = { name: 'Sam Ortiz', address: 'sam@example.org' }
const CLUB = { name: 'Purdue Esports', address: 'spring-lan@example.org' }
const HOUR = 3_600_000
type Args = Record<string, Value>
type Write = <T = unknown>(fn: string, args: Args) => Promise<T>
type Seed = {
  query: <T>(fn: string, args: Args) => Promise<T>
  mutate: Write
  internal: Write
  upload(body: string): Promise<string>
}

/** Midday test dates follow the same zone as the app, including across a DST change. */
export function seedDay(now: Date, days: number, hour: number): number {
  const parts = new Intl.DateTimeFormat('en', { timeZone: ZONE, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value)
  const local = Date.UTC(part('year'), part('month') - 1, part('day') + days, hour)
  const offset = new Intl.DateTimeFormat('en', { timeZone: ZONE, timeZoneName: 'longOffset' })
    .formatToParts(local).find(({ type }) => type === 'timeZoneName')?.value
  const [, sign, hours, minutes] = offset?.match(/^GMT([+-])(\d{2}):(\d{2})$/) ?? []
  if (!sign) throw new Error('Could not read the journey time zone')
  return local + (sign === '-' ? 1 : -1) * (Number(hours) * 60 + Number(minutes)) * 60_000
}

export async function seedDeadline(internal: Write, title: string, startsAt: number): Promise<() => Promise<void>> {
  const uid = 'journey-deadline-' + startsAt
  const sourceId = await internal<string>('sources:upsert', {
    kind: 'gcal', account: 'practice@example.com', channel: uid, label: title, sector: SECTOR, enabled: true
  })
  const range = { sourceId, from: startsAt - HOUR, to: startsAt + 2 * HOUR }
  await internal('events:syncFeed', {
    ...range,
    events: [{ uid, title, startsAt, endsAt: startsAt + HOUR, allDay: false, location: 'East room' }],
    provider: [{ uid, providerEventId: uid, attendees: [{ ...DANA, response: 'accepted' }] }]
  })
  return async () => {
    await internal('events:syncFeed', { ...range, events: [], provider: [] })
  }
}

export async function seedLifeos({ query, mutate, internal, upload }: Seed, now = new Date()): Promise<void> {
  const at = (days: number, hour: number) => seedDay(now, days, hour)
  const accounts = await Promise.all([
    internal<string>('mail:upsertAccount', { provider: 'gmail', address: CLUB.address, label: CLUB.name, defaultSector: SECTOR }),
    internal<string>('mail:upsertAccount', { provider: 'gmail', address: 'practice@example.com', label: 'Practice', defaultSector: 'life' })
  ])
  const notes = 'Spring LAN\nDoors open at noon.\n'
  const storageId = await upload(notes)
  const attachment = { name: 'Spring LAN notes.txt', size: Buffer.byteLength(notes), contentType: 'text/plain', storageId, inline: false }
  const subjects = [FIRST_MAIL, SECOND_MAIL, 'Spring LAN floor plan', 'Spring LAN cables', 'Spring LAN tables',
    'Spring LAN power', 'Spring LAN brackets', 'Spring LAN sign-in sheet', 'Spring LAN volunteer shifts', 'Spring LAN budget',
    'Spring LAN monitor count', 'Spring LAN trophy proofs', 'Practice checklist', 'Practice time', 'Practice notes',
    'Practice room', 'Practice agenda', 'Practice roster', 'Practice signup', 'Spring LAN unanswered room request']
  const waiting = subjects.length - 1
  for (const [account, accountId] of accounts.entries()) {
    const rows = subjects.flatMap((subject, i) => {
      if ((i >= 12 && i < waiting ? 1 : 0) !== account) return []
      const fromMe = i === waiting
      const peer = i % 2 ? SAM : DANA
      const body = fromMe ? 'Can you hold the east room for Spring LAN?' : 'Here are the notes for ' + subject + '.'
      const labels = fromMe ? ['SENT'] : ['INBOX', ...(i % 2 ? [] : ['UNREAD'])]
      const sentAt = fromMe ? at(-18, 10) : now.getTime() - (i + 1) * HOUR
      const providerThreadId = `journey-mail-${i}`
      const sector = account === 0 ? SECTOR : 'life'
      return [{
        thread: { providerThreadId, subject, snippet: body, participants: [peer.name], lastMessageAt: sentAt,
          labels, unread: labels.includes('UNREAD'), archived: fromMe, sector },
        message: { providerThreadId, providerMessageId: `journey-message-${i}`, rfcMessageId: `<journey-${i}@example.org>`,
          from: fromMe ? CLUB : peer, to: [fromMe ? peer : CLUB], cc: [], sentAt, snippet: body, bodyText: body,
          attachments: [0, 2, 12].includes(i) ? [{ ...attachment, providerAttachmentId: `journey-file-${i}` }] : [],
          labels, references: [], fromMe, capture: false }
      }]
    })
    await internal('mail:upsertThreads', { accountId, threads: rows.map(({ thread }) => thread) })
    await internal('mail:upsertMessages', { accountId, messages: rows.map(({ message }) => message) })
  }
  await mutate('compose:save', {
    message: { kind: 'mail', accountId: accounts[0]!, to: [DANA], cc: [], bcc: [], subject: 'Spring LAN signs',
      html: '<p>I can bring the signs.</p>', text: 'I can bring the signs.' }
  })
  await mutate('docs:create', { sector: SECTOR, title: GUEST_DOC, markdown: GUEST_WORDS })
  const projectId = await mutate<string>('projects:create', { sector: SECTOR, name: 'Spring LAN', status: 'active' })
  await mutate('tasks:create', { sector: SECTOR, title: 'Count the spare cables', projectId })
  const done = await mutate<string>('tasks:create', { sector: SECTOR, title: 'Reserve the east room', projectId })
  await mutate('tasks:complete', { id: done })
  await mutate('tasks:create', { sector: SECTOR, title: 'Print the room map', dueAt: at(-1, 15) })
  const blocked = await mutate<string>('tasks:create', { sector: SECTOR, title: 'Get the final roster', projectId })
  const personId = await mutate<string>('people:create', { name: DANA.name, emails: [DANA.address], sectors: [SECTOR] })
  await mutate('people:create', { name: SAM.name, emails: [SAM.address], sectors: [SECTOR] })
  await mutate('tasks:setWaitingOn', { id: blocked, waitingOn: { name: DANA.name, personId } })
  await mutate('events:create', { sector: SECTOR, title: MOVED_EVENT, startsAt: at(1, 17), endsAt: at(1, 19), location: 'East room' })
  await mutate('events:create', { sector: SECTOR, title: FIRST_CLASH, startsAt: at(1, 18), endsAt: at(1, 20), location: 'West room' })
  await mutate('events:create', { sector: SECTOR, title: 'Open the equipment cupboard', startsAt: at(0, 13), endsAt: at(0, 14) })
  await mutate('events:create', { sector: SECTOR, title: NEXT_CLASH, startsAt: at(1, 21), endsAt: at(1, 22) })
  await mutate('events:create', { sector: SECTOR, title: 'Spring LAN equipment check', startsAt: at(0, 0), allDay: true })
  const sourceId = await internal<string>('sources:upsert', {
    kind: 'gcal', account: 'practice@example.com', channel: 'spring-lan', label: 'Spring LAN calendar', sector: SECTOR, enabled: true
  })
  await internal('events:syncFeed', {
    sourceId, from: at(0, 0), to: at(8, 0),
    events: [{ uid: 'journey-invite', title: 'Spring LAN setup', startsAt: at(2, 15), endsAt: at(2, 17), allDay: false, location: 'East room' }],
    provider: [{ uid: 'journey-invite', providerEventId: 'journey-calendar-1', attendees: [{ ...DANA, response: 'accepted' }] }]
  })
  await internal('sources:upsert', {
    kind: 'slack', account: 'journey-chat', channel: 'spring-lan', label: 'Spring LAN', sector: SECTOR, enabled: true
  })
  await internal('rawMessages:insertBatch', {
    messages: [DANA, SAM].map((person, i) => ({
      source: 'slack', account: 'journey-chat', accountName: CLUB.name, channel: 'spring-lan', channelName: 'Spring LAN',
      thread: 'spring-lan-setup', externalId: `journey-chat-${i}`, author: { id: `journey-person-${i}`, name: person.name, email: person.address },
      fromMe: false, addressed: ['dm'], text: i ? 'Thanks, I have the setup notes.' : 'The setup notes are in the Spring LAN project.',
      sentAt: now.getTime() - (2 - i) * HOUR, context: [],
      ...(!i ? { files: [{ ref: 'journey-chat-file', name: attachment.name, contentType: attachment.contentType, size: attachment.size }] } : {})
    }))
  })
  await internal('sources:upsert', {
    kind: 'slack', account: 'journey-chat', channel: 'spring-lan-volunteers', label: 'Spring LAN volunteers', sector: SECTOR, enabled: true
  })
  await internal('rawMessages:insertBatch', {
    messages: [{
      source: 'slack', account: 'journey-chat', channel: 'spring-lan-volunteers', channelName: 'Spring LAN volunteers',
      externalId: 'journey-chat-volunteers', author: { id: 'journey-person-0', name: DANA.name, email: DANA.address },
      fromMe: false, addressed: ['dm'], text: 'Can you confirm the volunteer desk?', sentAt: now.getTime() - HOUR / 2, context: []
    }]
  })
  const paginationOpts = { numItems: 10, cursor: null }
  const chats = await query<{ page: { _id: string; name: string }[] }>('chats:list', { sector: SECTOR, paginationOpts })
  const chat = chats.page.find(({ name }) => name === 'Spring LAN')
  if (!chat) throw new Error('LifeOS did not file the Spring LAN chat')
  const messages = await query<{ page: { _id: string; files: { _id: string; name: string }[] }[] }>(
    'chats:messages', { chatId: chat._id, paginationOpts })
  const message = messages.page.find(({ files }) => files.some(({ name }) => name === attachment.name))
  const file = message?.files.find(({ name }) => name === attachment.name)
  if (!message || !file) throw new Error('LifeOS did not list the Spring LAN chat file')
  await mutate('chats:requestFiles', { messageId: message._id })
  const stored = await internal<boolean>('chats:fileStored', {
    id: file._id, storageId: await upload(notes), contentType: attachment.contentType, size: attachment.size
  })
  if (!stored) throw new Error('LifeOS did not store the Spring LAN chat file')
  await mutate('projectDocs:addFile', { projectId, storageId, name: attachment.name, contentType: attachment.contentType, size: attachment.size })
}
