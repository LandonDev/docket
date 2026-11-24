import type { Screen, ScreenElement } from '@shared/computer/outward'
import { WORKBOOK_LINE } from './guard'
import { countOf } from './read'
import { click, first, one, type FormsComputer, type Page } from './steps'
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

/** How long the Responses view may take to show its count (P1: about 20 s). */
export const RESPONSES_VIEW_MS = 60_000
const OPEN_IN_EXCEL = /^Open results in Excel$/i

/** The button that names the workbook already made: the one right after the view's "Analyze and explore…" line. */
export function workbookButton(screen: Screen): ScreenElement | null {
  const all = [...screen.elements.values()]
  const line = all.find((e) => WORKBOOK_LINE.test(e.name ?? ''))
  if (!line) return null
  const next = all.filter((e) => e.parent === line.parent && e.index > line.index).sort((a, b) => a.index - b.index)[0]
  return next && next.role === 'button' && / > /.test(next.name ?? '') ? next : null
}

/** Forms' tip over the Responses view ("Everything you need to manage responses…"): its Got it, when it shows. */
export async function dismissTip(page: Page): Promise<void> {
  const tip = one(page.last ?? (await page.read()), ['button'], /^Got it$/i)
  if (tip) await page.act((x) => {
    const g = one(x, ['button'], /^Got it$/i)
    return g ? [click(g)] : []
  }, 'the tip')
}

const JSON_HEADERS = { Accept: 'application/json;odata=nometadata' }
const q = (s: string): string => s.replace(/'/g, "''")
const dirOf = (path: string): string => path.replace(/\/[^/]*$/, '')
/** The library a folder's server path lies in: `/sites/<site>/<library>`. */
export const libraryRootOf = (path: string): string => /^(\/(?:sites|teams|personal)\/[^/]+\/[^/]+)/i.exec(decodeURIComponent(path))?.[1] ?? path
/** The document id in Excel for the web's address (`sourcedoc={GUID}`), lower case; null when it names none. */
export function docIdOf(url: string): string | null {
  let text = url
  try {
    text = decodeURIComponent(url)
  } catch {
    // an address that does not decode is read as it is
  }
  return /[?&]sourcedoc=\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?/i.exec(text)?.[1]?.toLowerCase() ?? null
}
const MOVED_WORDS = "The workbook is not where Forms keeps this form's answers: it was moved or is another file. The answers were not read."

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
    // The Responses view loads for 20 s and more (P1), and draws "Open results in Excel" twice: the first is pressed.
    // Once the workbook is made it names the workbook instead, a button after its line: that one is pressed.
    const opener = (x: Screen) => first(x, ['button', 'link'], OPEN_IN_EXCEL) ?? workbookButton(x)
    const { got } = await results.until((x) => (countOf(x) === 0 ? 'none' : opener(x) ? 'open' : null), Math.max(deps.mount, RESPONSES_VIEW_MS))
    if (got === 'none') return { unchanged: true }
    if (!got) results.stop('"Open results in Excel" was not on the Responses view')
    await dismissTip(results)
    const before = new Set((await computer.windows()).map((w) => w.id))
    await results.act((x) => {
      const b = opener(x)
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
    // The workbook is the one Excel for the web opened for this form: its document id binds it (review 3), never a name.
    let docId: string | null = null
    for (let waited = 0; waited <= Math.max(deps.mount, RESPONSES_VIEW_MS) && !docId; waited += 1_000) {
      const excel = (await computer.windows()).find((w) => !before.has(w.id) && /\/_layouts\/15\/Doc\.aspx/i.test(w.url))
      if (excel) {
        opened.push(excel.id)
        origins.add(new URL(excel.url).origin)
        docId = docIdOf(excel.url)
        if (!docId) results.stop('the workbook\'s window named no document')
        break
      }
      await computer.wait(1_000)
    }
    if (!docId) results.stop('Excel for the web did not open the workbook')
    if (ask.uniqueId && ask.uniqueId.toLowerCase() !== docId) throw new CarrierStop('The workbook Forms opened is not the one this form keeps. The answers were not read.', null, formId)

    // 2. From the folder's own site page, the file by that id.
    const site = await computer.open(ask.siteUrl)
    opened.push(site)
    const api = `${ask.siteUrl}/_api/web`
    const sitePath = new URL(ask.siteUrl).pathname.replace(/\/+$/, '')
    const facts = async (): Promise<FileFacts | null> => {
      const r = await computer.fetch(site, `${api}/GetFileById('${q(docId!)}')?$select=UniqueId,Name,ServerRelativeUrl,TimeLastModified`, { headers: JSON_HEADERS })
      return r.status === 200 && r.json ? (r.json as FileFacts) : null
    }
    /**
     * The place check, before the first byte and again after the wait: the file is this id, on the form's site, in the
     * folder the form was made in or (a form made in a Team library: P1, 2026-11-24) that library's root.
     */
    const placed = (f: FileFacts | null): f is FileFacts =>
      !!f &&
      f.UniqueId.toLowerCase() === docId &&
      same(f.ServerRelativeUrl.slice(0, sitePath.length), sitePath) &&
      (same(dirOf(f.ServerRelativeUrl), ask.folderServerPath) || same(dirOf(f.ServerRelativeUrl), libraryRootOf(ask.folderServerPath)))
    let file: FileFacts | null = null
    for (let waited = 0; waited <= t.noMove && !file; waited += t.every) {
      file = await facts()
      if (!file) await computer.wait(t.every)
    }
    if (!file) throw new CarrierStop('The workbook did not show where Forms keeps it. The answers were not read.', null, formId)
    if (!placed(file)) throw new CarrierStop(MOVED_WORDS, null, formId)
    const folder = await computer.fetch(site, `${api}/GetFolderByServerRelativeUrl('${q(dirOf(file.ServerRelativeUrl))}')?$select=UniqueId`, { headers: JSON_HEADERS })
    const parentId = folder.status === 200 ? String((folder.json as { UniqueId?: string })?.UniqueId ?? '') : ''
    if (!parentId) throw new CarrierStop('SharePoint did not say which folder holds the workbook. The answers were not read.', null, formId)

    // 3. Wait for Excel for the web to save what Forms wrote: moved and then still, or no move for a while.
    let modified = file.TimeLastModified
    let moved = ask.lastModified !== null && modified !== ask.lastModified
    let stillSince = Date.now()
    for (let waited = 0; ; waited += t.every) {
      if (moved && Date.now() - stillSince >= t.still) break
      if (!moved && waited >= t.noMove) break
      await computer.wait(t.every)
      const now = await facts()
      // a move or another file while the sync was waited for stops the read
      if (!placed(now)) throw new CarrierStop(MOVED_WORDS, null, formId)
      if (now.TimeLastModified !== modified) {
        modified = now.TimeLastModified
        moved = true
        stillSince = Date.now()
      }
      if (t.every === 0 && waited > t.noMove) break
    }
    if (!placed(await facts())) throw new CarrierStop(MOVED_WORDS, null, formId)
    const body = await computer.fetch(site, `${api}/GetFileById('${q(docId)}')/$value`, { bytes: true })
    if (body.status !== 200 || !body.bytes) throw new CarrierStop('SharePoint did not give the workbook. The answers were not read.', null, formId)
    return { workbook: { uniqueId: file.UniqueId, parentId, serverPath: file.ServerRelativeUrl, name: file.Name }, bytes: body.bytes, modified }
  } finally {
    for (const w of opened.reverse()) await computer.close(w).catch(() => {})
    await computer.clearData?.([...origins]).catch(() => {})
  }
}
