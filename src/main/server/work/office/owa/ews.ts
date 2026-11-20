import type { CalendarEvent, EventAnswer, EventOut, MailFull, MailOut, MailSummary, Recipients } from '../carrier'

/**
 * Outlook on the web's own requests, in the shapes its page sends to
 * `/owa/service.svc?action=<Action>`: Exchange Web Services' operations as
 * JSON, each part typed by `__type` (`CreateItemJsonRequest:#Exchange`). The
 * page signs them with its own headers (page.ts); this file only builds
 * bodies and reads answers, so it is tested without a browser.
 */

const T = (name: string) => `${name}:#Exchange`
const HEADER = { __type: T('JsonRequestHeaders'), RequestServerVersion: 'Exchange2016' }

const request = (op: string, body: Record<string, unknown>) => ({ __type: T(`${op}JsonRequest`), Header: HEADER, Body: { __type: T(`${op}Request`), ...body } })
const folder = (id: string) => ({ __type: T('DistinguishedFolderId'), Id: id })
const field = (uri: string) => ({ __type: T('PropertyUri'), FieldURI: uri })
const mailbox = (address: string) => ({ __type: T('EmailAddress'), EmailAddress: address, RoutingType: 'SMTP', MailboxType: 'Mailbox' })
const itemId = (id: string, changeKey?: string) => ({ __type: T('ItemId'), Id: id, ...(changeKey ? { ChangeKey: changeKey } : {}) })

export type Folder = 'inbox' | 'sentitems' | 'drafts' | 'calendar'

export function sendMail(m: MailOut, disposition: 'SendAndSaveCopy' | 'SaveOnly'): { action: string; body: unknown } {
  const message = {
    __type: T('Message'),
    Subject: m.subject,
    Body: { __type: T('BodyContentType'), BodyType: 'HTML', Value: m.html },
    ToRecipients: m.to.map(mailbox),
    CcRecipients: m.cc.map(mailbox),
    BccRecipients: m.bcc.map(mailbox)
  }
  // A reply or a forward goes as the answer to the mail it names, so Outlook threads it and quotes the original.
  const ref = m.replyTo ?? m.forward
  const item = ref
    ? { __type: T(m.replyTo ? 'ReplyToItem' : 'ForwardItem'), ReferenceItemId: itemId(ref), NewBodyContent: message.Body, ToRecipients: message.ToRecipients, CcRecipients: message.CcRecipients, BccRecipients: message.BccRecipients, Subject: m.subject }
    : message
  return {
    action: 'CreateItem',
    body: request('CreateItem', {
      Items: [item],
      MessageDisposition: disposition,
      SavedItemFolderId: { __type: T('TargetFolderId'), BaseFolderId: folder(disposition === 'SaveOnly' ? 'drafts' : 'sentitems') }
    })
  }
}

/** Who a saved mail is addressed to, field by field: a reply or forward made as a draft is read back before it goes. */
export function getRecipients(id: string): { action: string; body: unknown } {
  return {
    action: 'GetItem',
    body: request('GetItem', { ItemShape: { __type: T('ItemResponseShape'), BaseShape: 'IdOnly', AdditionalProperties: ['ToRecipients', 'CcRecipients', 'BccRecipients'].map((u) => field(`message:${u}`)) }, ItemIds: [itemId(id)] })
  }
}

/** A saved draft sent as it stands, its copy kept in Sent. */
export function sendItem(id: string, changeKey?: string): { action: string; body: unknown } {
  return {
    action: 'SendItem',
    body: request('SendItem', { ItemIds: [itemId(id, changeKey)], SaveItemToFolder: true, SavedItemFolderId: { __type: T('TargetFolderId'), BaseFolderId: folder('sentitems') } })
  }
}

/** A draft thrown away for good, never sent. */
export function deleteItem(id: string): { action: string; body: unknown } {
  return { action: 'DeleteItem', body: request('DeleteItem', { ItemIds: [itemId(id)], DeleteType: 'HardDelete' }) }
}

export function createEvent(e: EventOut): { action: string; body: unknown } {
  return {
    action: 'CreateItem',
    body: request('CreateItem', {
      Items: [
        {
          __type: T('CalendarItem'),
          Subject: e.subject,
          Body: { __type: T('BodyContentType'), BodyType: 'Text', Value: e.body ?? '' },
          Start: e.start,
          End: e.end,
          ...(e.location ? { Location: e.location } : {}),
          RequiredAttendees: e.attendees.map((a) => ({ __type: T('AttendeeType'), Mailbox: mailbox(a) }))
        }
      ],
      SendMeetingInvitations: e.attendees.length ? 'SendToAllAndSaveCopy' : 'SendToNone',
      SavedItemFolderId: { __type: T('TargetFolderId'), BaseFolderId: folder('calendar') }
    })
  }
}

const ANSWER_ITEM: Record<EventAnswer, string> = { accept: 'AcceptItem', decline: 'DeclineItem', tentative: 'TentativelyAcceptItem' }

export function answerEvent(id: string, answer: EventAnswer, comment?: string): { action: string; body: unknown } {
  return {
    action: 'CreateItem',
    body: request('CreateItem', {
      Items: [{ __type: T(ANSWER_ITEM[answer]), ReferenceItemId: itemId(id), ...(comment ? { Body: { __type: T('BodyContentType'), BodyType: 'Text', Value: comment } } : {}) }],
      MessageDisposition: 'SendAndSaveCopy'
    })
  }
}

export function findMail(f: Folder, limit: number, query?: string): { action: string; body: unknown } {
  return {
    action: 'FindItem',
    body: request('FindItem', {
      ItemShape: { __type: T('ItemResponseShape'), BaseShape: 'IdOnly', AdditionalProperties: ['Subject', 'DateTimeReceived', 'DateTimeSent', 'From', 'IsRead'].map((u) => field(`${u === 'From' || u === 'IsRead' ? 'message' : 'item'}:${u}`)) },
      ParentFolderIds: [folder(f)],
      Traversal: 'Shallow',
      Paging: { __type: T('IndexedPageView'), BasePoint: 'Beginning', Offset: 0, MaxEntriesReturned: limit },
      SortOrder: [{ __type: T('SortResults'), Order: 'Descending', Path: field('item:DateTimeReceived') }],
      ...(query ? { QueryString: query } : {})
    })
  }
}

export function getItem(id: string, bodyType: 'Text' | 'HTML'): { action: string; body: unknown } {
  return {
    action: 'GetItem',
    body: request('GetItem', { ItemShape: { __type: T('ItemResponseShape'), BaseShape: 'AllProperties', BodyType: bodyType }, ItemIds: [itemId(id)] })
  }
}

export function calendarView(from: string, to: string): { action: string; body: unknown } {
  return {
    action: 'FindItem',
    body: request('FindItem', {
      ItemShape: {
        __type: T('ItemResponseShape'),
        BaseShape: 'IdOnly',
        AdditionalProperties: ['item:Subject', 'calendar:Start', 'calendar:End', 'calendar:Location', 'calendar:Organizer', 'calendar:MyResponseType', 'calendar:UID'].map(field)
      },
      ParentFolderIds: [folder('calendar')],
      Traversal: 'Shallow',
      CalendarView: { __type: T('CalendarPageView'), StartDate: from, EndDate: to, MaxEntriesReturned: 500 }
    })
  }
}

export const userConfiguration = (): { action: string; body: unknown } => ({ action: 'GetOwaUserConfiguration', body: {} })

// ── answers ────────────────────────────────────────────────────────────

export class EwsError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message)
  }
}

interface Message {
  ResponseClass?: string
  ResponseCode?: string
  MessageText?: string
  Items?: Item[]
  RootFolder?: { Items?: Item[] }
}
interface Mailbox {
  Name?: string
  EmailAddress?: string
}
export interface Item {
  ItemId?: { Id: string; ChangeKey?: string }
  Subject?: string
  DateTimeReceived?: string
  DateTimeSent?: string
  From?: { Mailbox?: Mailbox }
  IsRead?: boolean
  ToRecipients?: Mailbox[]
  CcRecipients?: Mailbox[]
  BccRecipients?: Mailbox[]
  Body?: { Value?: string; BodyType?: string }
  Start?: string
  End?: string
  Location?: string | { DisplayName?: string }
  Organizer?: { Mailbox?: Mailbox }
  MyResponseType?: string
  UID?: string
}

/** The one response message of an answer; a refusal throws its words. */
export function messageOf(answer: unknown): Message {
  const m = (answer as { Body?: { ResponseMessages?: { Items?: Message[] } } })?.Body?.ResponseMessages?.Items?.[0]
  if (!m) throw new EwsError('Outlook on the web gave no answer it could read', 'NoAnswer')
  // A warning did what was asked, with a note; only an error is a refusal.
  if (m.ResponseClass === 'Success' || m.ResponseClass === 'Warning') return m
  if (m.ResponseClass !== 'Error') throw new EwsError(`Outlook on the web answered "${m.ResponseClass ?? 'nothing'}"`, 'NoAnswer')
  throw new EwsError(m.MessageText || m.ResponseCode || 'Outlook on the web refused', m.ResponseCode ?? 'Error')
}

const address = (m: Mailbox | undefined): string => m?.EmailAddress ?? m?.Name ?? ''

export const createdId = (answer: unknown): string | null => messageOf(answer).Items?.[0]?.ItemId?.Id ?? null

/** A saved mail's recipients as Exchange holds them, with the change key its send names. */
export function recipientsOf(answer: unknown): Recipients & { changeKey?: string } {
  const i = messageOf(answer).Items?.[0]
  if (!i?.ItemId) throw new EwsError('No such mail', 'ErrorItemNotFound')
  return { to: (i.ToRecipients ?? []).map(address), cc: (i.CcRecipients ?? []).map(address), bcc: (i.BccRecipients ?? []).map(address), ...(i.ItemId.ChangeKey ? { changeKey: i.ItemId.ChangeKey } : {}) }
}

export function mailList(answer: unknown, account: string): MailSummary[] {
  return (messageOf(answer).RootFolder?.Items ?? []).map((i) => ({
    id: i.ItemId?.Id ?? '',
    account,
    from: address(i.From?.Mailbox),
    subject: i.Subject ?? '',
    at: i.DateTimeReceived ?? i.DateTimeSent ?? '',
    read: i.IsRead ?? true
  }))
}

export function mailFull(answer: unknown, account: string): MailFull & { html?: string } {
  const i = messageOf(answer).Items?.[0]
  if (!i?.ItemId) throw new EwsError('No such mail', 'ErrorItemNotFound')
  const html = i.Body?.BodyType === 'HTML' ? (i.Body.Value ?? '') : undefined
  return {
    id: i.ItemId.Id,
    account,
    from: address(i.From?.Mailbox),
    subject: i.Subject ?? '',
    at: i.DateTimeReceived ?? i.DateTimeSent ?? '',
    read: i.IsRead ?? true,
    to: (i.ToRecipients ?? []).map(address),
    cc: (i.CcRecipients ?? []).map(address),
    text: html === undefined ? (i.Body?.Value ?? '') : '',
    ...(html !== undefined ? { html } : {})
  }
}

const RESPONSE: Record<string, string> = { Accept: 'accepted', Decline: 'declined', Tentative: 'tentative', NoResponseReceived: 'none', Organizer: '', Unknown: 'none' }

export function eventList(answer: unknown): (CalendarEvent & { uid: string })[] {
  return (messageOf(answer).RootFolder?.Items ?? []).map((i) => ({
    id: i.ItemId?.Id ?? '',
    subject: i.Subject ?? '',
    start: i.Start ?? '',
    end: i.End ?? '',
    location: typeof i.Location === 'string' ? i.Location : (i.Location?.DisplayName ?? ''),
    organizer: address(i.Organizer?.Mailbox),
    attendees: [],
    response: RESPONSE[i.MyResponseType ?? ''] ?? '',
    uid: i.UID ?? ''
  }))
}

/** The signed-in address, from the page's own configuration. */
export function accountOf(config: unknown): string {
  const c = config as { SessionSettings?: { UserEmailAddress?: string; LogonEmailAddress?: string } }
  const a = c?.SessionSettings?.UserEmailAddress ?? c?.SessionSettings?.LogonEmailAddress
  if (!a) throw new EwsError('Outlook on the web did not say who is signed in', 'NoAccount')
  return a.trim().toLowerCase()
}
