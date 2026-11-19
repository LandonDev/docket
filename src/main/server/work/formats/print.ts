import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * A page printed to PDF by Chromium (the formats report, §2 "PDF out"): the
 * window writes the document's print page (`work-kit/formats/html`,
 * `htmlDocument` with `print`), and this host prints it in a hidden window
 * with no script and no network, tagged, with an outline from its headings.
 * A test hands in its own printer.
 */

export type Printer = (html: string, options: { paper: 'A4' | 'Letter'; dir: string }) => Promise<Uint8Array>

let printer: Printer | null = null
export const setPrinter = (p: Printer | null): void => void (printer = p)

/** Requests a page may make: its own file and inline data. Nothing a document names reaches the network. */
const LOCAL = /^(file|data|blob|about|chrome|devtools):/i

const PARTITION = 'work-formats-print'
let fenced = false

const electronPrinter: Printer = async (html, { paper, dir }) => {
  const { BrowserWindow, session } = await import('electron')
  const ses = session.fromPartition(PARTITION)
  if (!fenced) {
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !LOCAL.test(details.url) }))
    fenced = true
  }
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${randomUUID()}.html`)
  writeFileSync(file, html)
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  try {
    await win.loadFile(file)
    const pdf = await win.webContents.printToPDF({ pageSize: paper, printBackground: true, preferCSSPageSize: true, generateTaggedPDF: true, generateDocumentOutline: true })
    return new Uint8Array(pdf)
  } finally {
    win.destroy()
    rmSync(file, { force: true })
  }
}

export function printToPdf(html: string, options: { paper: 'A4' | 'Letter'; dir: string }): Promise<Uint8Array> {
  return (printer ?? electronPrinter)(html, options)
}
