import { capture } from './capture'
import { guests } from './guests'
import type { Source } from './index'
import { lapses } from './lapses'
import { prepReady, prepStarting } from './prep'
import { scheduled } from './scheduled'
import { waiting } from './waiting'
import { winvm } from './winvm'

/** Every source, in the order they are read. A pillar that tells for itself (`ctx.tell` in its own folder) has none: two rows would result. */
export const SOURCES: readonly Source[] = [lapses, prepStarting, prepReady, waiting, scheduled, guests, capture, winvm]
