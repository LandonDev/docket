import type { PublicRoute } from './route'
import { docRoute } from './doc'
import { docsRoutes } from '../../docs/serviceRoutes'
import { formRoute } from './form'
import { fullEditorRoute } from './fullEditor'
import { guestsRoute } from './guests'
import { historyRoutes } from '../../history/serviceRoutes'
import { hostedRoute } from './hosted'
import { internalDocRoutes } from './internal'
import { itemRoute } from './item'
import { officeRoute } from './office'
import { sheetRoute } from './sheet'

/**
 * Every route of the Work service, a closed list (architecture §8.1). Each
 * file is its milestone's; a stub answers "not built: … (milestone N)". The
 * public listener matches only these; `/internal/*` is not among them and is
 * served on the Unix socket alone.
 *
 *   /w/doc/<docId>        routes/doc.ts         18
 *   /w/hosted/*           routes/hosted.ts      18
 *   /w/sheet/<sheetId>    routes/sheet.ts       27
 *   /w/open               routes/item.ts        31
 *   /g/*                  routes/guests.ts      31
 *   /w/office, /w/addin/* routes/office.ts      29
 *   /f/*                  routes/form.ts        36
 *   /w/full/*             routes/fullEditor.ts  40
 *   internal (socket)     routes/internal.ts    18, its sheet routes routes/internalSheet.ts 27,
 *                         history's in work/history/serviceRoutes.ts 19,
 *                         the docs pillar's in work/docs/serviceRoutes.ts 20
 */
export const PUBLIC_ROUTES: readonly PublicRoute[] = [docRoute, hostedRoute, sheetRoute, itemRoute, guestsRoute, officeRoute, formRoute, fullEditorRoute]

export const INTERNAL_ROUTES = [...internalDocRoutes, ...historyRoutes, ...docsRoutes]

export function routeFor(pathname: string): { route: PublicRoute; m: RegExpExecArray } | null {
  for (const route of PUBLIC_ROUTES) {
    const m = route.match.exec(pathname)
    if (m) return { route, m }
  }
  return null
}
