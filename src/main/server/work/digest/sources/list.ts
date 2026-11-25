import { capture } from './capture'
import type { Source } from './index'
import { lapses } from './lapses'
import { prepReady, prepStarting } from './prep'
import { scheduled } from './scheduled'
import { waiting } from './waiting'
import { winvm } from './winvm'

/**
 * Every source, in the order they are read. A pillar that tells for itself (`ctx.tell` in its own folder) has none: two
 * rows would result. A guest's edit was a source here ("A guest edited …", read from the documents list, which names no
 * guest); the guests pillar now tells it by the guest's name, for files too (guests/tells.ts), so that source is gone.
 */
export const SOURCES: readonly Source[] = [lapses, prepStarting, prepReady, waiting, scheduled, capture, winvm]
