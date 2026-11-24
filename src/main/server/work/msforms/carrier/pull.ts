import { countOf } from './read'
import { click, one, type FormsComputer, type Page } from './steps'
import { CarrierStop, type PullAsk, type PulledWorkbook } from './types'

/**
 * Reading answers from the workbook (docs/agents/work-msforms.md "Reading
 * answers"). Forms writes rows only while the workbook is open in Excel for
 * the web, so a pull presses "Open results in Excel" (and its first-use
 * Continue), keeps that window open, and from a second window on the
 * folder's own site page asks SharePoint for the file by its id: its parent
 * must still be the recorded folder, its Modified must have moved and stood
 * still, then its bytes come into the host's memory. Both windows close, and
 * what Chromium stored for the Excel and SharePoint origins is cleared. No
 * picture of either page is taken.
 */

/** How long a pull waits for the workbook to settle: still this long after it moved, or this long with no move at all. */
export const PULL_STILL_MS = 15_000
export const PULL_NO_MOVE_MS = 90_000
export const PULL_EVERY_MS = 5_000

const JSON_HEADERS = { Accept: 'application/json;odata=nometadata' }
const q = (s: string): string => s.replace(/'/g, "''")
const dirOf = (path: string): string => path.replace(/\/[^/]*$/, '')
const same = (a: string, b: string): boolean => decodeURIComponent(a).replace(/\/+$/, '').toLowerCase() === decodeURIComponent(b).replace(/\/+$/, '').toLowerCase()

export interface PullDeps {
  computer: FormsComputer & { clearData?(origins: readonly string[]): Promise<void> }
  mount: number
  openResponses(): Promise<Page>
  timing?: { still: number; noMove: number; every: number }
}

interface FileFacts {
  UniqueId: string
  Name: string
  ServerRelativeUrl: string
  TimeLastModified: string
}

export async function pullWorkbook(deps: PullDeps, formId: string, ask: PullAsk): Promise<{ workbook: PulledWorkbook; bytes: Uint8Array; modified: string } | { unchanged: true }> {
  const { computer } = deps
  const t = deps.timing ?? { still: PULL_STILL_MS, noMove: PULL_NO_MOVE_MS, every: PULL_EVERY_MS }
  const opened: string[] = []
  const origins = new Set<string>([new URL(ask.siteUrl).origin])
  try {
    // 1. Open results in Excel: Forms keeps writing rows while this window holds the workbook open.
    const results = await deps.openResponses()
    opened.push(results.window)
    const { got } = await results.until((x) => (countOf(x) === 0 ? 'none' : one(x, ['button', 'link'], /^Open results in Excel$/i) ? 'open' : null), deps.mount)
    if (got === 'none') return { unchanged: true }
    if (!got) results.stop('"Open results in Excel" was not on the Responses view')
    const before = new Set((await computer.windows()).map((w) => w.id))
    await results.act((x) => {
      const b = one(x, ['button', 'link'], /^Open results in Excel$/i)
      return b ? [click(b)] : null
    }, 'Open results in Excel')
    // The first press asks once: View your responses in Excel for the web … Continue.
    const cont = one(results.last!, ['button'], /^Continue$/i)
    if (cont) {
      await results.act((x) => {
        const c = one(x, ['button'], /^Continue$/i)
        return c ? [click(c)] : []
      }, 'Continue')
    }
    for (let waited = 0; waited <= deps.mount; waited += 1_000) {
      const excel = (await computer.windows()).find((w) => !before.has(w.id) && /\/_layouts\/15\/Doc\.aspx|excel/i.test(w.url))
      if (excel) {
        opened.push(excel.id)
        origins.add(new URL(excel.url).origin)
        break
      }
      await computer.wait(1_000)
    }

    // 2. From the folder's own site page, the file by its id (or, the first time, by its name in the folder).
    const site = await computer.open(ask.siteUrl)
    opened.push(site)
    const api = `${ask.siteUrl}/_api/web`
    const facts = async (): Promise<FileFacts | null> => {
      const select = '$select=UniqueId,Name,ServerRelativeUrl,TimeLastModified'
      const url = ask.uniqueId ? `${api}/GetFileById('${q(ask.uniqueId)}')?${select}` : ask.name ? `${api}/GetFileByServerRelativeUrl('${q(`${ask.folderServerPath}/${ask.name}`)}')?${select}` : null
      if (!url) return null
      const r = await computer.fetch(site, url, { headers: JSON_HEADERS })
      return r.status === 200 && r.json ? (r.json as FileFacts) : null
    }
    let file: FileFacts | null = null
    for (let waited = 0; waited <= t.noMove && !file; waited += t.every) {
      file = await facts()
      if (!file) await computer.wait(t.every)
    }
    if (!file) throw new CarrierStop('The workbook did not show in the form\'s folder. The answers were not read.', null, formId)
    // The place check: the workbook must lie in the folder the form was made in.
    if (!same(dirOf(file.ServerRelativeUrl), ask.folderServerPath)) throw new CarrierStop('The workbook is no longer in the form\'s folder: it was moved. The answers were not read.', null, formId)
    const folder = await computer.fetch(site, `${api}/GetFolderByServerRelativeUrl('${q(ask.folderServerPath)}')?$select=UniqueId`, { headers: JSON_HEADERS })
    const parentId = folder.status === 200 ? String((folder.json as { UniqueId?: string })?.UniqueId ?? '') : ''

    // 3. Wait for Excel for the web to save what Forms wrote: moved and then still, or no move for a while.
    let modified = file.TimeLastModified
    let moved = ask.lastModified !== null && modified !== ask.lastModified
    let stillSince = Date.now()
    for (let waited = 0; ; waited += t.every) {
      if (moved && Date.now() - stillSince >= t.still) break
      if (!moved && waited >= t.noMove) break
      await computer.wait(t.every)
      const now = await facts()
      if (!now) break
      if (now.TimeLastModified !== modified) {
        modified = now.TimeLastModified
        moved = true
        stillSince = Date.now()
      }
      if (t.every === 0 && waited > t.noMove) break
    }
    const body = await computer.fetch(site, `${api}/GetFileById('${q(file.UniqueId)}')/$value`, { bytes: true })
    if (body.status !== 200 || !body.bytes) throw new CarrierStop('SharePoint did not give the workbook. The answers were not read.', null, formId)
    return { workbook: { uniqueId: file.UniqueId, parentId, serverPath: file.ServerRelativeUrl, name: file.Name }, bytes: body.bytes, modified }
  } finally {
    for (const w of opened.reverse()) await computer.close(w).catch(() => {})
    await computer.clearData?.([...origins]).catch(() => {})
  }
}
