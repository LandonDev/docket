import { z } from 'zod'
import { changeWords, quoted } from '@shared/work/changeWords'
import type { ActKindDef } from '../modules'
import { ActNotSent, ActStale } from '../outbox/kinds'
import { GoogleError, GOOGLE_MIME } from './client'
import { writeEdits } from './docs'
import { googleOf } from './google'
import { writeDeckEdits } from './slides'

/**
 * The google pillar's held acts (docs/agents/work-google.md "What is held"):
 * `share.google`, letting someone into one of his Google files, and
 * `google.edit`, an agent's change to a Doc or a deck. An agent's tool only
 * makes one; Google is called in `execute`, which the Outbox runs once, after
 * his press (or, for a share, a grant he made from one). A share's way back
 * takes the person out again.
 */

const ROLES = ['reader', 'commenter', 'writer'] as const
const ROLE_WORDS: Record<(typeof ROLES)[number], string> = { reader: 'can view', commenter: 'can comment', writer: 'can edit' }

export const GoogleShareSchema = z.object({
  account: z.string().min(3).max(320),
  fileId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  name: z.string().max(500),
  email: z.string().trim().max(320).regex(/^[^\s@<>,;]+@[^\s@<>,;]+$/, 'an email address'),
  role: z.enum(ROLES),
  /** Google's own mail to them about it */
  notify: z.boolean().default(true)
})
export type GoogleShare = z.infer<typeof GoogleShareSchema>

/** What a grant may fix: the account, the people by address or domain, and the most a person may do. */
export const GoogleShareMatcherSchema = z.object({
  account: z.string().optional(),
  recipients: z.array(z.string()).optional(),
  domains: z.array(z.string()).optional(),
  upTo: z.enum(ROLES).optional()
})
export type GoogleShareMatcher = z.infer<typeof GoogleShareMatcherSchema>

export const googleShare: ActKindDef<GoogleShare, GoogleShareMatcher> = {
  kind: 'share.google',
  store: 'host',
  payload: GoogleShareSchema,
  matcher: GoogleShareMatcherSchema,
  words: (p) => ({ summary: `Share ${p.name} with ${p.email} (${ROLE_WORDS[p.role]})`, verb: 'Share' }),
  matches(m, p) {
    if (m.account && m.account.toLowerCase() !== p.account.toLowerCase()) return false
    if (m.upTo && ROLES.indexOf(p.role) > ROLES.indexOf(m.upTo)) return false
    const who = p.email.toLowerCase()
    const people = new Set((m.recipients ?? []).map((r) => r.toLowerCase()))
    const domains = new Set((m.domains ?? []).map((d) => d.toLowerCase().replace(/^@/, '')))
    return people.has(who) || domains.has(who.split('@')[1])
  },
  async execute(p, ctx) {
    const got = await googleOf(ctx).api(p.account).share(p.fileId, p.email, p.role, p.notify)
    ctx.db
      .prepare('INSERT OR REPLACE INTO work_google_shares (account, file_id, permission_id, session_id) VALUES (?, ?, ?, ?)')
      .run(p.account.toLowerCase(), p.fileId, got.id, ctx.item.sessionId)
    return { summary: `Shared ${p.name} with ${p.email} (${ROLE_WORDS[p.role]})`, ref: { account: p.account, fileId: p.fileId, permissionId: got.id } }
  },
  wayBack(r) {
    const ref = r.ref as { account?: string; fileId?: string; permissionId?: string } | undefined
    if (!ref?.account || !ref.fileId || !ref.permissionId) return null
    return { pillar: 'google', verb: 'google_unshare', args: { account: ref.account, fileId: ref.fileId, permissionId: ref.permissionId }, label: 'Stop sharing' }
  }
}

const FileId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/)
const Replace = z.object({ find: z.string().min(1).max(5_000), replace: z.string().max(20_000) })
/** A Doc's replace, with the paragraph that held the words when it was suggested. */
const DocReplace = Replace.extend({ within: z.string().max(200_000).optional(), tab: z.string().max(200).optional() })
/** A deck's replace-all, with how many boxes held the words then. */
const DeckReplace = Replace.extend({ boxes: z.number().int().min(1).optional(), on: z.array(z.number().int().min(1)).max(500).optional(), count: z.number().int().min(1).optional(), spots: z.string().max(100).optional() })

/**
 * An agent's change to a Google file, kept on his host until he approves it (the owner's ruling of 2026-11-23):
 * nothing of it is in the file, as a suggestion, a comment or a copy, before his press, which makes it as a
 * plain edit. Google files are always others' to open (Files' `sharedOf`), so every agent change waits, whatever
 * it says of itself. With the revision it was judged on, so the press can say the file moved.
 */
export const GoogleEditSchema = z.discriminatedUnion('app', [
  z.object({ app: z.literal('doc'), account: z.string().min(3).max(320), fileId: FileId, name: z.string().max(500), edits: z.array(DocReplace).min(1).max(50), revisionId: z.string().max(500) }),
  z.object({
    app: z.literal('slides'),
    account: z.string().min(3).max(320),
    fileId: FileId,
    name: z.string().max(500),
    edits: z.array(z.union([DeckReplace, z.object({ shape: z.string().max(200), text: z.string().max(20_000), slide: z.number().int().min(1), was: z.string().max(20_000) })])).min(1).max(100),
    revisionId: z.string().max(500)
  })
])
export type GoogleEdit = z.infer<typeof GoogleEditSchema>

/** How far a replace-all reaches, first, when it is more than one place: "3 places, ". */
const reach = (e: GoogleEdit['edits'][number]): string => {
  // places, as PowerPoint counts them: every time the words stand, two in one box counted twice
  const n = 'count' in e && e.count ? e.count : 'boxes' in e && e.boxes ? e.boxes : 1
  return n > 1 ? `${n} places, ` : ''
}
const editWords = (e: GoogleEdit['edits'][number]): string =>
  'find' in e ? reach(e) + (e.replace ? changeWords(e.find, e.replace) : `take out ${quoted(e.find)}`) : e.text ? `slide ${e.slide}'s ${changeWords(e.was, e.text)}` : `take out slide ${e.slide}'s ${quoted(e.was)}`

/** No matcher: no grant covers an agent's change to a file others can open, and no Away releases it. */
export const googleEdit: ActKindDef<GoogleEdit> = {
  kind: 'google.edit',
  store: 'host',
  payload: GoogleEditSchema,
  words(p) {
    const n = p.edits.length
    const verb = n === 1 ? 'Make the change' : `Make ${n} changes`
    return { summary: `${verb} in ${p.name}: ${editWords(p.edits[0]!)}${n > 1 ? ` and ${n - 1} more` : ''}`, verb }
  },
  async execute(p, ctx) {
    const g = googleOf(ctx)
    let got: { stale: string } | { moved: boolean }
    try {
      got =
        p.app === 'doc'
          ? await writeEdits(g, { at: 'google', account: p.account, fileId: p.fileId, mime: GOOGLE_MIME.doc }, p.edits, p.revisionId)
          : await writeDeckEdits(g, p.account, p.fileId, p.edits, p.revisionId)
    } catch (err) {
      // A refusal, a file gone, or someone's write between the read and this one: Google wrote nothing.
      if (err instanceof GoogleError && ['refused', 'not-found', 'bad-request', 'conflict', 'needs-consent', 'no-account', 'signed-out', 'too-wide'].includes(err.code)) throw new ActNotSent(err.message)
      throw err
    }
    // the reason is written in his words where it is found; one sentence after the colon, and a stop at its end
    if ('stale' in got) throw new ActStale(`${p.name} changed since: ${got.stale}. Nothing was changed.`)
    const n = p.edits.length
    return { summary: `Made ${n === 1 ? 'the change' : `${n} changes`} in ${p.name}`, ref: { at: 'google', fileId: p.fileId } }
  },
  wayBack: () => null
}
