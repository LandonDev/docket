import { patchPageSetup, patchPrintNames, readSheetPageSetups, type SheetPageSetupEntry } from 'work-kit/sheet/xlsx'
import { checkPageSetup, normalizeSetup, sameSetup, type SheetPageSetup } from 'work-kit/sheet/pages'
import { readRels } from './patch'
import { readText, readZip, writeZip, type Zip } from './zip'

/**
 * A sheet's page set-up saved into an opened Excel file (the editors plan, SHT6): paper,
 * orientation, margins, scale or fit, gridlines and headings, the header and footer, manual
 * breaks, and the print area and repeated titles (the reserved names in the workbook). work-kit
 * patches the two XML parts (`patchPageSetup`, `patchPrintNames`: what the model does not hold is
 * kept, new elements go in schema order); here they are laid into the package, and every other
 * entry keeps its bytes.
 */

export interface PagesEdit {
  /** the tab's name */
  sheet: string
  setup: SheetPageSetup
}

export class PagesRefused extends Error {}

/** Every worksheet's page set-up as the file holds it. */
export function readPages(bytes: Uint8Array): SheetPageSetupEntry[] {
  return readSheetPageSetups(bytes)
}

export function patchPages(bytes: Uint8Array, edits: readonly PagesEdit[]): { bytes: Uint8Array; report: { partsChanged: string[] } } {
  const report = { partsChanged: [] as string[] }
  if (!edits.length) return { bytes, report }
  const zip = readZip(bytes)
  const entries = readSheetPageSetups(bytes)
  const parts = new Map<string, { before: string; after: string }>()
  const text = (name: string): { before: string; after: string } => {
    let part = parts.get(name)
    if (!part) {
      if (!zip.byName.has(name)) throw new PagesRefused('The workbook is missing one of its parts.')
      const xml = readText(zip, name)
      part = { before: xml, after: xml }
      parts.set(name, part)
    }
    return part
  }
  let wbPart: string | undefined
  const seen = new Set<string>()
  for (const edit of edits) {
    if (seen.has(edit.sheet)) throw new PagesRefused(`More than one page set-up for worksheet “${edit.sheet}”.`)
    seen.add(edit.sheet)
    const at = entries.find((e) => e.sheet === edit.sheet)
    if (!at) throw new PagesRefused(`No worksheet named “${edit.sheet}”.`)
    try {
      checkPageSetup(edit.setup)
      if (sameSetup(at.setup, edit.setup)) continue
      const setup = normalizeSetup(edit.setup)
      const sheet = text(at.part)
      sheet.after = patchPageSetup(sheet.after, setup)
      const { printAreas, repeatRows, repeatColumns } = setup
      if (!sameSetup(at.setup, { ...at.setup, printAreas, repeatRows, repeatColumns })) {
        const book = text(wbPart ??= workbookPart(zip))
        book.after = patchPrintNames(book.after, at.sheetIndex, at.sheet, setup)
      }
    } catch (err) {
      if (err instanceof PagesRefused) throw err
      // work-kit says what Excel's schema refuses as a RangeError, in words.
      if (err instanceof RangeError) throw new PagesRefused(err.message)
      throw err
    }
  }
  const encoder = new TextEncoder()
  const replace = new Map<string, Uint8Array>()
  for (const [name, part] of parts) {
    if (part.before === part.after) continue
    report.partsChanged.push(name)
    replace.set(name, encoder.encode(part.after))
  }
  return { bytes: replace.size ? writeZip(zip, replace, new Set(), new Map()) : bytes, report }
}

/** The workbook part, by the package's own relationships. */
function workbookPart(zip: Zip): string {
  return readRels(zip, '').rels.find((rel) => !rel.external && rel.type.endsWith('/officeDocument'))
    ?.target ?? 'xl/workbook.xml'
}
