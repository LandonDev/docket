import type { OfficeTheme } from 'work-kit/format/theme'
import type { WorkCtx } from '../modules'

/**
 * A job's own look (docs/agents/work-templates.md "A job's look"): its
 * colours, fonts and logo. No job has one yet, so `lookOf` answers null and
 * a made file keeps the template's own theme. The feature that gives a job
 * a look fills this, and writes the one swap of `theme/theme1.xml` in the
 * scratch file that make.ts leaves room for: every starter uses theme
 * colours and theme fonts alone, so that swap is the whole job.
 */

export type { OfficeTheme }

export interface JobLook {
  /** twelve colours and two fonts, as Office's `theme1.xml` holds them */
  theme: OfficeTheme
  /** a picture file on this host */
  logo?: string
}

export type LookOf = (ctx: Pick<WorkCtx, 'db'>, workspaceId: string) => JobLook | null

export const lookOf: LookOf = () => null
