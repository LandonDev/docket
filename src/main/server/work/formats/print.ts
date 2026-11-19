import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

/**
 * A page printed to PDF by Chromium (the formats report, §2 "PDF out"): the
 * window writes the document's print page (`work-kit/formats/html`,
 * `htmlDocument` with `print`), and this host prints it in a hidden window
 * with no script and no network, tagged, with an outline from its headings.
 * A test hands in its own printer.
 */

export type Printer = (html: string, options: { paper: 'A4' | 'Letter'; dir: string }) => Promise<{ pdf: Uint8Array; warnings: string[] }>

let printer: Printer | null = null
export const setPrinter = (p: Printer | null): void => void (printer = p)

/**
 * Requests a page may make: its own file and inline data. Nothing it names
 * reaches the network or another file on this host (the HTML may come from a
 * remote key, and a frame on `file:///…` would print that file into the PDF).
 */
const INLINE = /^(data|about):/i
const pages = new Set<string>()
export const mayLoad = (url: string): boolean => INLINE.test(url) || pages.has(url)

const PARTITION = 'work-formats-print'
let fenced = false
/** Pictures from the web each print refused, by its window: said, not left as a silent blank. */
const refused = new Map<number, number>()
const PRINT_MS = 60_000

const electronPrinter: Printer = async (html, { paper, dir }) => {
  const { BrowserWindow, session } = await import('electron')
  const ses = session.fromPartition(PARTITION)
  if (!fenced) {
    ses.webRequest.onBeforeRequest((details, callback) => {
      const ok = mayLoad(details.url)
      if (!ok && details.resourceType === 'image' && details.webContentsId !== undefined) refused.set(details.webContentsId, (refused.get(details.webContentsId) ?? 0) + 1)
      callback({ cancel: !ok })
    })
    fenced = true
  }
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${randomUUID()}.html`)
  writeFileSync(file, html)
  const url = pathToFileURL(file).href
  pages.add(url)
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const id = win.webContents.id
  // The page it was given is the page it prints: no navigation, no new window, and a bounded wait.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('the page took too long to print')), PRINT_MS)))
  try {
    const pdf = await Promise.race([
      win.loadFile(file).then(() => win.webContents.printToPDF({ pageSize: paper, printBackground: true, preferCSSPageSize: true, generateTaggedPDF: true, generateDocumentOutline: true })),
      late
    ])
    const n = refused.get(id) ?? 0
    return { pdf: new Uint8Array(pdf), warnings: n ? [`${n} ${n === 1 ? 'picture' : 'pictures'} from the web left out of the PDF`] : [] }
  } finally {
    clearTimeout(timer)
    refused.delete(id)
    pages.delete(url)
    win.destroy()
    rmSync(file, { force: true })
  }
}

export function printToPdf(html: string, options: { paper: 'A4' | 'Letter'; dir: string }): Promise<{ pdf: Uint8Array; warnings: string[] }> {
  return (printer ?? electronPrinter)(html, options)
}
