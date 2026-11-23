import { digestLine, nowLine, sectorName } from '@shared/work/digest'
import type { TellRow } from '@shared/work/tell'

/**
 * Every sentence a notice of the digest's says (docs/agents/work-digest.md),
 * in the app's voice: the title is the job, the body is the news. The
 * list's and the toasts' own words are in src/shared/work/digest.ts.
 */

export interface NoticeWords {
  title: string
  subtitle?: string
  body: string
}

/** A row's job as a notice names it. */
export type JobName = (row: Pick<TellRow, 'workspaceId' | 'sector'>) => string | null

/** One row as a notice's body: its title, and its detail on a line of its own (never joined by a colon: most titles hold one already). */
export const rowLines = (row: Pick<TellRow, 'title' | 'detail'>): string => (row.detail ? `${row.title}\n${row.detail}` : row.title)

/** A thing that cannot wait. One open: the job, then the row. More: "Work", then every open one in a line, so a banner that replaced another still says everything. */
export function nowWords(open: readonly TellRow[], jobOf: JobName): NoticeWords {
  if (open.length === 1) return { title: jobOf(open[0]!) ?? 'Work', body: rowLines(open[0]!) }
  return { title: 'Work', body: nowLine(open.map((r) => r.title)) }
}

/** The day's one notice: "Work", then "Digest: 9 things in Cosmic, Purdue and Ref". */
export function digestWords(count: number, rows: readonly TellRow[], jobOf: JobName): NoticeWords {
  return { title: 'Work', body: digestLine(count, rows.map((r) => jobOf(r) ?? '').filter(Boolean)) }
}

/** A job's name from its sector alone, when the host has no workspace row for it. */
export const jobFromSector = (sector: string | null): string | null => (sector ? sectorName(sector) : null)
