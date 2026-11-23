import type { IWorkbookData } from '@univerjs/core'
import { moveObjects, movesObjects, objectsOpOf, readObjectsResource, withObjects } from 'work-kit/sheet/engine'
import type { ChartSpec, PictureSpec, SheetObjects } from 'work-kit/sheet/xlsx'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
// (by its path: the Work service reaches this file, and its bundle resolves no alias for a value)
import { isObjectList, MEDIA_RESOURCE, RULES_SET, type RulesSetParams } from '../../../../../shared/work/sheets'

export { MEDIA_RESOURCE }

/**
 * A sheet's charts and pictures as the service's host keeps them beside its engine
 * (docs/agents/work-sheets.md "Sheets the service holds"). Univer keeps no resource of ours, so the
 * host holds the list itself: a change is the tab's whole chart or picture list (`RULES_SET` of kind
 * `charts` or `pictures`, as the canvas sends it), rows and columns that move under them carry them
 * (work-kit's `objectsOpOf`, `moveObjects`), and a snapshot the host cuts or serves carries them as
 * the kit's resource (`withObjects`). A picture made on the grid comes with its bytes once, as base64
 * on its entry (`data`); the host keeps them by the picture's part and lays the ones still drawn into
 * the snapshot as a resource of its own (`MEDIA_RESOURCE`), so they travel with the sheet's own store
 * (the .tcsheet file, LifeOS) and nothing of them is kept on the host.
 */

/** The most one picture made here may be, and all of a sheet's together: a snapshot is JSON the canvas loads whole. */
export const MEDIA_MAX = 5 * 1024 * 1024
export const MEDIA_TOTAL_MAX = 25 * 1024 * 1024
/** A part the grid gives a picture it made (`media:<id>`). */
const MADE_PART = /^media:[A-Za-z0-9_-]{1,64}$/

export interface HeldMedia {
  type: string
  /** base64 */
  data: string
}

/** What the host keeps beside one engine. */
export interface HeldObjects {
  objects: SheetObjects
  media: Map<string, HeldMedia>
}

/** The objects and picture bytes a snapshot carries; none for a snapshot that has none. */
export function heldOf(snapshot: Partial<IWorkbookData> | null | undefined): HeldObjects {
  const objects = readObjectsResource(snapshot) ?? { charts: [], pictures: [], warnings: [] }
  return { objects: { ...objects, warnings: [] }, media: mediaOf(snapshot) }
}

/** The picture bytes a snapshot carries, by part. */
export function mediaOf(snapshot: Partial<IWorkbookData> | null | undefined): Map<string, HeldMedia> {
  const out = new Map<string, HeldMedia>()
  const data = snapshot?.resources?.find((r) => r.name === MEDIA_RESOURCE)?.data
  if (!data) return out
  try {
    const all = JSON.parse(data) as Record<string, unknown>
    for (const [part, one] of Object.entries(all ?? {})) {
      const m = one as Partial<HeldMedia> | null
      if (MADE_PART.test(part) && m && typeof m.type === 'string' && typeof m.data === 'string') out.set(part, { type: m.type, data: m.data })
    }
  } catch {
    // (a resource that cannot be read draws its pictures as empty frames)
  }
  return out
}

/** A snapshot with the objects and the bytes of the pictures still drawn laid in, in place of any it carried. */
export function withHeld<T extends Partial<IWorkbookData>>(snapshot: T, held: HeldObjects): T {
  const laid = withObjects(snapshot, held.objects)
  const drawn = new Set(held.objects.pictures.map((p) => p.part))
  const media: Record<string, HeldMedia> = {}
  for (const [part, m] of held.media) if (drawn.has(part)) media[part] = m
  const others = laid.resources.filter((r) => r.name !== MEDIA_RESOURCE)
  return { ...laid, resources: Object.keys(media).length ? [...others, { name: MEDIA_RESOURCE, data: JSON.stringify(media) }] : others } as T
}

/** The image types a picture made here may be, told by its own bytes (the four the Excel export can write). */
function imageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  return null
}

/**
 * Why a tab's list cannot be kept, or null. A picture's bytes must be a picture the Excel export can
 * write and within the bounds; a part named here must be one the grid gives (`media:<id>`) or one the
 * sheet already keeps.
 */
export function listMisfit(held: HeldObjects, m: SheetMutationJson): string | null {
  const p = m.params as RulesSetParams
  if (typeof p.subUnitId !== 'string' || !Array.isArray(p.list)) return 'A chart or picture list names its sheet and holds a list.'
  if (p.kind !== 'pictures') return null
  let total = 0
  for (const m of held.media.values()) total += Math.floor((m.data.length * 3) / 4)
  for (const entry of p.list as Array<Partial<PictureSpec> & { data?: unknown }>) {
    if (typeof entry?.part !== 'string') return 'A picture names its part.'
    if (entry.data === undefined) continue
    if (typeof entry.data !== 'string' || !MADE_PART.test(entry.part)) return 'A picture made here carries its bytes under its own part.'
    const bytes = Buffer.from(entry.data, 'base64')
    if (bytes.length > MEDIA_MAX) return `A picture can be at most ${MEDIA_MAX / 1024 / 1024} MB here.`
    if (!imageType(bytes)) return 'That picture is not a PNG, JPEG, GIF or BMP.'
    total += bytes.length
  }
  return total > MEDIA_TOTAL_MAX ? `A sheet keeps at most ${MEDIA_TOTAL_MAX / 1024 / 1024} MB of pictures made here.` : null
}

/**
 * Lays one mutation on what the host keeps, `nameOf` naming a sheet by its id as the engine had it
 * before the mutation ran. A tab's list replaces that tab's objects of its kind (a made picture's
 * bytes kept by its part); rows, columns and a sheet's name moving under them carry them.
 */
export function layOn(held: HeldObjects, m: SheetMutationJson, nameOf: (sheetId: string) => string | undefined): void {
  if (isObjectList(m)) {
    const p = m.params as RulesSetParams
    const tab = nameOf(p.subUnitId ?? '')
    if (tab === undefined || !Array.isArray(p.list)) return
    if (p.kind === 'charts') {
      const list = (p.list as ChartSpec[]).map((c) => ({ ...c, sheet: tab }))
      held.objects = { ...held.objects, charts: [...held.objects.charts.filter((c) => c.sheet !== tab), ...list] }
    } else {
      const list = (p.list as Array<PictureSpec & { data?: string }>).map(({ data, ...picture }) => {
        if (typeof data === 'string') held.media.set(picture.part, { type: imageType(Buffer.from(data, 'base64')) ?? picture.contentType, data })
        return { ...picture, sheet: tab }
      })
      held.objects = { ...held.objects, pictures: [...held.objects.pictures.filter((x) => x.sheet !== tab), ...list] }
    }
    return
  }
  if (!movesObjects(m.id)) return
  const op = objectsOpOf(m, nameOf)
  if (op) held.objects = moveObjects(held.objects, op)
}

/**
 * The lists that turn `now`'s objects into `then`'s, for a restore: each tab of `now` whose charts or
 * pictures differ gets `then`'s list for it whole, a made picture `now` no longer keeps with its bytes
 * from `then`'s snapshot, so the op alone brings it back.
 */
export function objectMutations(unitId: string, now: IWorkbookData, then: IWorkbookData): SheetMutationJson[] {
  const a = heldOf(now)
  const b = heldOf(then)
  const out: SheetMutationJson[] = []
  for (const id of now.sheetOrder ?? Object.keys(now.sheets ?? {})) {
    const tab = now.sheets?.[id]?.name
    if (tab === undefined) continue
    const charts = (o: SheetObjects) => o.charts.filter((c) => c.sheet === tab)
    const pictures = (o: SheetObjects) => o.pictures.filter((x) => x.sheet === tab)
    if (JSON.stringify(charts(a.objects)) !== JSON.stringify(charts(b.objects))) out.push({ id: RULES_SET, params: { unitId, kind: 'charts', subUnitId: id, list: charts(b.objects) } })
    if (JSON.stringify(pictures(a.objects)) !== JSON.stringify(pictures(b.objects)))
      out.push({ id: RULES_SET, params: { unitId, kind: 'pictures', subUnitId: id, list: pictures(b.objects).map((x) => (!a.media.has(x.part) && b.media.has(x.part) ? { ...x, data: b.media.get(x.part)!.data } : x)) } })
  }
  return out
}
