import { stubInternal } from './route'

/**
 * The internal sheet routes the LifeOS worker calls (`read_sheet_range`,
 * `write_sheet_range`, `suggest_sheet_cells`; M17.md). Stubs until milestone
 * 27 fills this file: each answers 501 with "not built", which the worker
 * tells the bot as "the Work service is not answering and nothing changed".
 */
export const internalSheetRoutes = [stubInternal('/internal/sheet/read', 'reading a sheet', 27), stubInternal('/internal/sheet/write', 'writing a sheet', 27)]
