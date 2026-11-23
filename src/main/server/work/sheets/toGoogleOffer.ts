import type { CanvasSource } from '@shared/work'
import { madeFromShared } from '../docs/target'
import type { WorkCtx } from '../modules'
import { isTeamsSnapshot } from '../slides/formatsIn'
import type { Held } from './held'

/**
 * Which workbooks Save to Google Sheets is offered for (toGoogle.ts): a file apart from that one so the view
 * (held.ts `viewOf`) can ask it without a circle of imports. It takes no value from held.ts.
 */

type Ctx = Pick<WorkCtx, 'db' | 'host' | 'dataDir'>

/** A file others can open, or a snapshot the Teams view made of one: the google pillar's own two tests (`uploadOfficeFile`). */
export const othersOpen = (ctx: Ctx, source: CanvasSource): boolean => madeFromShared(ctx, source) || isTeamsSnapshot(ctx.dataDir, source)

/**
 * Whether the sheet's More offers Save to Google Sheets (`SheetView.canUpload`): a workbook this host holds
 * that is his own. Not one Excel or Google holds, not one others can open, not a snapshot the Teams view made.
 * The google pillar checks the same again at the press.
 */
export const offersGoogle = (ctx: Ctx, held: Held, source: CanvasSource): boolean => (held.at === 'package' || held.at === 'service') && !othersOpen(ctx, source)
