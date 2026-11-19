import type { OfficeApp, OfficeAppState, OfficeCell } from '@shared/contract-work-office'
import { OfficeError, type OfficeCarrier, type OfficeFile, type RangeGrid, type SlideText, type WorkbookInfo } from '../carrier'
import type { AddinApp, AddinHub } from './hub'
import { openOfficeWeb } from './web'

/**
 * The add-in as a carrier (docs/agents/work-office.md "The add-in"): a file
 * open in Excel, Word or PowerPoint with our add-in goes through it, on the
 * Mac, on Windows or on the web; anything else goes to this host's desktop
 * carrier as before (the Mac's osascript), or is refused where there is none.
 * Mail and calendar are never the add-in's.
 *
 * The switch opens a file by URL in Excel for the web, in a window of our own
 * (web.ts), where no desktop Office app is installed.
 */
export function withAddin(desktop: OfficeCarrier | null, hub: () => AddinHub | null, web: (url: string) => Promise<void> = openOfficeWeb): OfficeCarrier {
  const via = (app: AddinApp, key: string) => {
    const h = hub()
    const s = h?.sessionFor(app, key)
    return h && s ? { call: (op: string, args: unknown) => h.call(s.conn, op, args) } : null
  }
  const orDesktop = (what: string): OfficeCarrier => {
    if (desktop) return desktop
    throw new OfficeError(`${what} is not open with the TempCode add-in, and this host has no Office of its own.`, 'not-running')
  }
  const noDesktop = (app: OfficeApp): OfficeCarrier => {
    if (desktop) return desktop
    throw new OfficeError(`The TempCode add-in does not carry ${app === 'outlook' ? 'Outlook' : app}, and this host has no Office of its own.`, 'not-installed')
  }
  const desktopFiles = async <T>(read: (c: OfficeCarrier) => Promise<T[]>): Promise<T[]> => (desktop ? read(desktop).catch(() => []) : [])
  const merge = <T extends OfficeFile>(mine: T[], theirs: T[]): T[] => [...mine, ...theirs.filter((t) => !mine.some((m) => m.key === t.key))]

  return {
    kind: desktop?.kind ?? 'addin',
    async apps() {
      const base: OfficeAppState[] = desktop ? await desktop.apps() : []
      const h = hub()
      const live = (app: OfficeApp): boolean => !!h && app !== 'outlook' && h.files(app as AddinApp).length > 0
      const names: OfficeApp[] = desktop ? base.map((a) => a.app) : ['excel', 'word', 'powerpoint']
      return names.map((app) => {
        const d = base.find((a) => a.app === app)
        return live(app) ? { ...(d ?? { app, allowed: 'yes' as const }), app, installed: true, running: true } : (d ?? { app, installed: false, running: false, allowed: 'unknown' as const })
      })
    },

    async workbooks() {
      const h = hub()
      const mine: WorkbookInfo[] = []
      for (const s of h?.files('excel') ?? []) {
        // Ask for the sheets now: their used ranges grow as he types.
        const fresh = (await h!.call(s.conn, 'excel.workbook', {}).catch(() => null)) as { sheets?: WorkbookInfo['sheets'] } | null
        mine.push({ key: s.file!.key, name: s.file!.name, sheets: fresh?.sheets ?? s.sheets })
      }
      return merge(mine, await desktopFiles((c) => c.workbooks()))
    },
    async readRange(book, sheet, address) {
      const a = via('excel', book)
      return a ? ((await a.call('excel.read', { sheet, address })) as RangeGrid) : orDesktop('That workbook').readRange(book, sheet, address)
    },
    async writeRange(book, sheet, address, grid: OfficeCell[][]) {
      const a = via('excel', book)
      if (a) await a.call('excel.write', { sheet, address, grid })
      else await orDesktop('That workbook').writeRange(book, sheet, address, grid)
    },

    async documents() {
      const mine = (hub()?.files('word') ?? []).map((s) => s.file!)
      return merge(mine, await desktopFiles((c) => c.documents()))
    },
    async readDocument(doc) {
      const a = via('word', doc)
      return a ? ((await a.call('word.read', {})) as string[]) : orDesktop('That document').readDocument(doc)
    },
    async editDocument(doc, edit, tracked) {
      const a = via('word', doc)
      return a ? ((await a.call('word.edit', { edit, tracked })) as number) : orDesktop('That document').editDocument(doc, edit, tracked)
    },

    async presentations() {
      const mine = (hub()?.files('powerpoint') ?? []).map((s) => s.file!)
      return merge(mine, await desktopFiles((c) => c.presentations()))
    },
    async readSlides(pres) {
      const a = via('powerpoint', pres)
      return a ? ((await a.call('slides.read', {})) as SlideText[]) : orDesktop('That presentation').readSlides(pres)
    },
    async replaceSlideText(pres, find, replace) {
      const a = via('powerpoint', pres)
      return a ? ((await a.call('slides.replace', { find, replace })) as number) : orDesktop('That presentation').replaceSlideText(pres, find, replace)
    },

    accounts: () => (desktop ? desktop.accounts() : Promise.resolve([])),
    listMail: (q) => noDesktop('outlook').listMail(q),
    readMail: (id) => noDesktop('outlook').readMail(id),
    draftMail: (m) => noDesktop('outlook').draftMail(m),
    sendMail: (m) => noDesktop('outlook').sendMail(m),
    events: (from, to) => noDesktop('outlook').events(from, to),
    createEvent: (e) => noDesktop('outlook').createEvent(e),
    answerEvent: (id, answer, comment) => noDesktop('outlook').answerEvent(id, answer, comment),
    eventByUid: (uid) => noDesktop('outlook').eventByUid(uid),

    async open(app, ref) {
      const installed = desktop ? (await desktop.apps().catch(() => [])).find((a) => a.app === app)?.installed : false
      if (desktop && installed) return desktop.open(app, ref)
      // No desktop app: a file in OneDrive or SharePoint opens in Office on the web, in our own window.
      if (ref.kind === 'url' && app !== 'outlook') return web(ref.url)
      throw new OfficeError(`${app === 'excel' ? 'Excel' : app === 'word' ? 'Word' : app === 'powerpoint' ? 'PowerPoint' : 'Outlook'} is not on this host, and a file on disk does not open on the web.`, 'not-installed')
    }
  }
}
