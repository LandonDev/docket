import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'

/**
 * A stand-in for Outlook on the web, in its shapes, for the carrier's proofs
 * on the box (no agent may sign in to the owner's Outlook). Its `/mail/` page
 * sets the canary cookie and, as OWA's page does once its sign-in library
 * has a token, makes its own first `service.svc` call with a bearer token
 * and the canary; `service.svc` answers only calls signed with both, checks
 * every request's `__type`s as Exchange's JSON endpoint names them, and
 * answers in Exchange's response shapes. `expire()` ends the session (440),
 * as OWA does when its token runs out.
 */

export interface StoredMail {
  id: string
  folder: 'inbox' | 'sentitems' | 'drafts'
  subject: string
  html: string
  to: string[]
  cc: string[]
  bcc: string[]
  at: string
  reference?: { kind: string; id: string }
}
export interface StoredEvent {
  id: string
  uid: string
  subject: string
  start: string
  end: string
  location: string
  organizer: string
  attendees: string[]
  response: string
  invitations: boolean
}

export interface OwaFixture {
  url: string
  account: string
  mail: StoredMail[]
  events: StoredEvent[]
  /** every action the page or the carrier called, with whether it was signed */
  calls: { action: string; signed: boolean }[]
  expire(): void
  close(): Promise<void>
}

const T = (n: string) => `${n}:#Exchange`
const ok = (items: unknown[], extra: Record<string, unknown> = {}) => ({ Body: { ResponseMessages: { Items: [{ __type: T('ItemInfoResponseMessage'), ResponseClass: 'Success', ResponseCode: 'NoError', Items: items, ...extra }] } } })
const refused = (code: string, text: string) => ({ Body: { ResponseMessages: { Items: [{ __type: T('ItemInfoResponseMessage'), ResponseClass: 'Error', ResponseCode: code, MessageText: text }] } } })
const addresses = (list: unknown): string[] => ((list as { EmailAddress?: string; Mailbox?: { EmailAddress?: string } }[] | undefined) ?? []).map((m) => m.EmailAddress ?? m.Mailbox?.EmailAddress ?? '')
const stripTags = (html: string) => html.replace(/<[^>]+>/g, '').trim()

class Shape extends Error {}
const need = (v: unknown, type: string, where: string) => {
  if ((v as { __type?: string } | undefined)?.__type !== T(type)) throw new Shape(`${where} is not ${T(type)}`)
}

export function serveOwaFixture(account = 'Dana.Lee@contoso.com'): Promise<OwaFixture> {
  let token = `tok-${randomUUID()}`
  const canary = `canary-${randomUUID()}`
  const mail: StoredMail[] = []
  const events: StoredEvent[] = []
  const calls: OwaFixture['calls'] = []

  const page = () => `<!doctype html><html><head><title>Mail - Dana Lee - Outlook</title></head><body><div role="main">Inbox</div><script>
    const canary = (document.cookie.match(/(?:^|; )X-OWA-CANARY=([^;]+)/) || [])[1];
    fetch('/owa/service.svc?action=GetOwaUserConfiguration&app=Mail', { method: 'POST', credentials: 'include', headers: { action: 'GetOwaUserConfiguration', authorization: 'Bearer ${token}', 'x-owa-canary': canary, 'x-req-source': 'Mail', 'content-type': 'application/json; charset=utf-8' }, body: '{}' });
  </script></body></html>`

  const signed = (req: IncomingMessage) => {
    const cookie = /(?:^|; )X-OWA-CANARY=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]
    return req.headers.authorization === `Bearer ${token}` && req.headers['x-owa-canary'] === canary && cookie === canary
  }

  const handle = (action: string, body: Record<string, unknown>): unknown => {
    if (action === 'GetOwaUserConfiguration') return { SessionSettings: { UserEmailAddress: account, UserDisplayName: 'Dana Lee' } }
    const b = body.Body as Record<string, unknown>
    if (action === 'CreateItem') {
      need(body, 'CreateItemJsonRequest', 'the request')
      need(b, 'CreateItemRequest', 'its Body')
      const item = (b.Items as Record<string, unknown>[])[0]!
      const type = String(item.__type)
      if (type === T('Message') || type === T('ReplyToItem') || type === T('ForwardItem')) {
        const content = (type === T('Message') ? item.Body : item.NewBodyContent) as { __type: string; BodyType: string; Value: string }
        need(content, 'BodyContentType', 'the mail body')
        if (content.BodyType !== 'HTML') throw new Shape('a mail body goes as HTML')
        const send = b.MessageDisposition === 'SendAndSaveCopy'
        if (!send && b.MessageDisposition !== 'SaveOnly') throw new Shape('MessageDisposition')
        const m: StoredMail = {
          id: `AAMk-${randomUUID()}`,
          folder: send ? 'sentitems' : 'drafts',
          subject: String(item.Subject ?? ''),
          html: content.Value,
          to: addresses(item.ToRecipients),
          cc: addresses(item.CcRecipients),
          bcc: addresses(item.BccRecipients),
          at: new Date().toISOString(),
          ...(type !== T('Message') ? { reference: { kind: type, id: (item.ReferenceItemId as { Id: string }).Id } } : {})
        }
        mail.push(m)
        // Exchange answers no item for a mail it sent; a saved draft comes back with its id.
        return ok(send ? [] : [{ __type: T('Message'), ItemId: { __type: T('ItemId'), Id: m.id, ChangeKey: 'CQ' } }])
      }
      if (type === T('CalendarItem')) {
        const e: StoredEvent = {
          id: `AAMkCal-${randomUUID()}`,
          uid: `040000008200E00074C5B7101A82E008${randomUUID().replace(/-/g, '')}`,
          subject: String(item.Subject ?? ''),
          start: String(item.Start),
          end: String(item.End),
          location: String(item.Location ?? ''),
          organizer: account,
          attendees: addresses(item.RequiredAttendees),
          response: 'Organizer',
          invitations: b.SendMeetingInvitations === 'SendToAllAndSaveCopy'
        }
        events.push(e)
        return ok([{ __type: T('CalendarItem'), ItemId: { __type: T('ItemId'), Id: e.id, ChangeKey: 'DQ' } }])
      }
      const answer = { [T('AcceptItem')]: 'Accept', [T('DeclineItem')]: 'Decline', [T('TentativelyAcceptItem')]: 'Tentative' }[type]
      if (answer) {
        const e = events.find((x) => x.id === (item.ReferenceItemId as { Id: string }).Id)
        if (!e) return refused('ErrorItemNotFound', 'The specified object was not found in the store.')
        e.response = answer
        return ok([])
      }
      throw new Shape(`an item of ${type}`)
    }
    if (action === 'FindItem') {
      need(body, 'FindItemJsonRequest', 'the request')
      need(b, 'FindItemRequest', 'its Body')
      const parent = (b.ParentFolderIds as { __type: string; Id: string }[])[0]!
      need(parent, 'DistinguishedFolderId', 'the folder')
      if (b.CalendarView) {
        const v = b.CalendarView as { StartDate: string; EndDate: string }
        need(v, 'CalendarPageView', 'the view')
        const items = events
          .filter((e) => e.end > v.StartDate && e.start < v.EndDate)
          .map((e) => ({ __type: T('CalendarItem'), ItemId: { Id: e.id }, Subject: e.subject, Start: e.start, End: e.end, Location: e.location, Organizer: { Mailbox: { EmailAddress: e.organizer } }, MyResponseType: e.response, UID: e.uid }))
        return ok([], { RootFolder: { TotalItemsInView: items.length, IncludesLastItemInRange: true, Items: items } })
      }
      const view = b.Paging as { MaxEntriesReturned: number }
      need(view, 'IndexedPageView', 'the paging')
      const items = mail
        .filter((m) => m.folder === parent.Id)
        .slice(-view.MaxEntriesReturned)
        .reverse()
        .map((m) => ({ __type: T('Message'), ItemId: { Id: m.id }, Subject: m.subject, DateTimeSent: m.at, From: { Mailbox: { Name: 'Dana Lee', EmailAddress: account } }, IsRead: true }))
      return ok([], { RootFolder: { TotalItemsInView: items.length, IncludesLastItemInRange: true, Items: items } })
    }
    if (action === 'GetItem') {
      need(body, 'GetItemJsonRequest', 'the request')
      const shape = b.ItemShape as { BodyType: 'Text' | 'HTML' }
      const id = (b.ItemIds as { Id: string }[])[0]!.Id
      const m = mail.find((x) => x.id === id)
      if (!m) return refused('ErrorItemNotFound', 'The specified object was not found in the store.')
      const mb = (a: string) => ({ Name: a, EmailAddress: a })
      return ok([
        {
          __type: T('Message'),
          ItemId: { Id: m.id },
          Subject: m.subject,
          DateTimeSent: m.at,
          From: { Mailbox: mb(account) },
          ToRecipients: m.to.map(mb),
          CcRecipients: m.cc.map(mb),
          IsRead: true,
          Body: { BodyType: shape.BodyType, Value: shape.BodyType === 'HTML' ? `<html><body>${m.html}</body></html>` : stripTags(m.html) }
        }
      ])
    }
    throw new Shape(`no action ${action}`)
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/mail/' || url.pathname === '/mail') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `X-OWA-CANARY=${canary}; Path=/` })
      return void res.end(page())
    }
    if (url.pathname !== '/owa/service.svc' || req.method !== 'POST') return void (res.writeHead(404), res.end())
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const action = url.searchParams.get('action') ?? ''
      const isSigned = signed(req) && req.headers.action === action
      calls.push({ action, signed: isSigned })
      if (!isSigned) return void (res.writeHead(440), res.end())
      try {
        const answer = handle(action, raw ? JSON.parse(raw) : {})
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(answer))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${port}/mail/`,
        account,
        mail,
        events,
        calls,
        expire: () => void (token = `tok-${randomUUID()}`),
        close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r())))
      })
    })
  )
}
