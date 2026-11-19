import type { CapsOf, RelayOf } from './work/wire'

/**
 * The mail pillar's wire (docs/agents/work-mail.md). Its methods are
 * `work.mail.<verb>` and its pushes `work.mail`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const MailRequestSchemas = [] as const
export type MailPush = never
export const MAIL_CAPS = {} satisfies CapsOf<typeof MailRequestSchemas>
export const MAIL_RELAY = {} satisfies RelayOf<typeof MailRequestSchemas>
