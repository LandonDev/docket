import { z } from 'zod'
import type { SectorKey } from './ids'

/**
 * The chat beside the mail (docs/agents/work-mail.md "The chat beside the mail"): its names and the rules the
 * host and the window share. A mail chat is a Work thread of the job's workspace, made only on his first send,
 * that reads mail and writes drafts. Every other change comes back as a `mail_offer` card for his press.
 */

/** What a mail chat is about: the open mail thread, the rows he ticked, or the mailbox or search in view. */
export const MAIL_CHAT_KINDS = ['mail', 'picked', 'box'] as const
export type MailChatKind = (typeof MAIL_CHAT_KINDS)[number]

/**
 * What a mail chat may call. An allow-list: a tool LifeOS or Work adds later is refused until it is named here.
 * `narrow: false` gives a mail chat an ordinary Work thread's powers (and its shell and web).
 */
export const MAIL_CHAT_POWERS = {
  narrow: true,
  /** LifeOS tools by prefix: every read. */
  lifeosReads: ['list_', 'get_', 'search_', 'read_'],
  /**
   * LifeOS tools that change something and are still allowed: writing drafts, which go only through his Send. Not
   * `delete_mail_draft`: LifeOS deletes any draft, his own half-written replies too; the card's Discard is his.
   */
  lifeosWrites: ['draft_mail', 'update_mail_draft'],
  /**
   * Work tools by name. Not `work_search` (it finds other threads' words), nor the Files verbs (listing a place asks
   * his Mac, the Windows VM or Google Drive).
   */
  work: ['mail_offer', 'mail_waiting', 'person_page', 'doc_read', 'doc_find'],
  /**
   * A harness's own tools a mail chat never has: no shell, no file writes, no web, no subagent or workflow of its own, no design sync. Being
   * narrowed, it also keeps only the app tools work/narrowing.ts lists (no thread, agent, add-on or desktop change).
   */
  harness: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Workflow', 'DesignSync']
} as const

/** A sector here gets no Ask, no ⌘L and a refused adopt (Purdue's AI policy may ask for it). */
export const MAIL_CHAT_WITHHELD: readonly SectorKey[] = []

/** A triage card's rows start ticked; he unticks the ones to keep. */
export const TRIAGE_TICKED = true

/** The words a model reads when a mail chat calls what it may not. */
export const MAIL_CHAT_REFUSAL = 'In a mail chat you propose and he acts: offer it with mail_offer.'

/** Whether a mail chat may call this LifeOS tool (its short name, `archive_mail`). */
export function lifeosAllowed(tool: string): boolean {
  if (!MAIL_CHAT_POWERS.narrow) return true
  return (MAIL_CHAT_POWERS.lifeosWrites as readonly string[]).includes(tool) || MAIL_CHAT_POWERS.lifeosReads.some((p) => tool.startsWith(p))
}

/** Whether a mail chat may call this Work tool. */
export function workAllowed(tool: string): boolean {
  return !MAIL_CHAT_POWERS.narrow || (MAIL_CHAT_POWERS.work as readonly string[]).includes(tool)
}

/**
 * The chat beside the mail at all. Off: no Ask in the reader's toolbar or the ticked head, ⌘L does nothing in Mail,
 * and the host marks no thread a mail chat (adopt is refused, so the window's first send never goes).
 */
export const MAIL_CHAT = { on: true }

/** Whether a job is kept from the chat: every job while the chat is off, else a sector in `MAIL_CHAT_WITHHELD`. */
export const mailChatWithheld = (sector: SectorKey | null | undefined): boolean => !MAIL_CHAT.on || (sector != null && MAIL_CHAT_WITHHELD.includes(sector))

const id = z.string().min(1).max(64)
const words = (n: number) => z.string().trim().min(1).max(n)

/** The acts a rows card proposes; each runs as Mail's own bulk act on his press. */
export const MAIL_ROW_ACTS = ['archive', 'read', 'needsMe', 'snooze'] as const
export type MailRowAct = (typeof MAIL_ROW_ACTS)[number]

/** `mail_offer`'s input: one card. The host checks every id before it answers. */
export const MailOfferSchema = z.union([
  z.object({ draft: z.object({ draftId: id }).strict() }).strict(),
  z.object({ rewrite: z.object({ draftId: id }).strict() }).strict(),
  z
    .object({
      rows: z
        .object({
          act: z.enum(MAIL_ROW_ACTS),
          title: words(200),
          threadIds: z.array(id).min(1).max(50),
          snoozeUntil: z.string().max(40).optional()
        })
        .strict()
    })
    .strict(),
  z.object({ task: z.object({ title: words(500), due: z.string().max(40).optional(), notes: z.string().max(4_000).optional(), threadId: id.optional() }).strict() }).strict(),
  z
    .object({
      event: z
        .object({ title: words(500), start: z.string().min(1).max(40), end: z.string().max(40).optional(), where: z.string().max(500).optional(), threadId: id.optional() })
        .strict()
    })
    .strict()
])
export type MailOffer = z.infer<typeof MailOfferSchema>

/** What `mail_offer` answers in `structuredContent`; the transcript draws it as a card. */
export interface MailOfferResult {
  mailOffer: MailOffer
}

/** Reads a tool result's `structuredContent` as a mail offer, or null. */
export function mailOfferOf(structured: unknown): MailOffer | null {
  if (!structured || typeof structured !== 'object') return null
  const parsed = MailOfferSchema.safeParse((structured as { mailOffer?: unknown }).mailOffer)
  return parsed.success ? parsed.data : null
}
