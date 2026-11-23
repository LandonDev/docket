import type { ClashMiles } from '@shared/contract-work-clashes'
import type { ClashStop } from '@shared/work/clashes'
import type { WorkCtx } from '../modules'
import { milesFor } from './read'

/**
 * The miles between two stops, for a pillar on this host (Money): the same
 * read as `work.clashes.miles`. `measured` false is the straight-line
 * floor: ask again later rather than log it as a mile driven. Null when a
 * stop has no point on the map.
 */
export const milesBetween = (ctx: WorkCtx, workspaceId: string, from: ClashStop, to: ClashStop): Promise<ClashMiles | null> => milesFor(ctx, workspaceId, from, to)
