import { z } from 'zod'
import type { ActKindDef } from '../modules'
import { googleOf } from './google'

/**
 * The google pillar's held act (docs/agents/work-google.md "What is held"):
 * `share.google`, letting someone into one of his Google files. An agent's
 * tool only makes it; Drive is called in `execute`, which the Outbox runs
 * once, after his press or a grant he made from one. Its way back takes the
 * person out again.
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
