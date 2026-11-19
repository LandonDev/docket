import type { CapsOf, RelayOf } from './work/wire'

/**
 * The pdf pillar's wire (docs/agents/work-pdf.md). Its methods are
 * `work.pdf.<verb>` and its pushes `work.pdf`; src/shared/work/wire.ts has
 * the helpers and the rules.
 * A stub until its milestone fills it: `PILLAR_MILESTONE` names which.
 */
export const PdfRequestSchemas = [] as const
export type PdfPush = never
export const PDF_CAPS = {} satisfies CapsOf<typeof PdfRequestSchemas>
export const PDF_RELAY = {} satisfies RelayOf<typeof PdfRequestSchemas>
