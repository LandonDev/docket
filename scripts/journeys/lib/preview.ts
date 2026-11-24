import { PDFDocument, PDFRawStream } from 'pdf-lib'
import type { Window } from './window'

export async function pdfFacts(bytes: Uint8Array) {
  if (!Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from('%PDF-'))) throw new Error('The file has no PDF header')
  const pdf = await PDFDocument.load(bytes)
  return {
    size: bytes.length,
    streams: pdf.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFRawStream).length,
    pages: pdf.getPages().map((page) => page.getSize())
  }
}

export async function previewFormat(page: Window, id: string, label: string): Promise<void> {
  const frame = '[data-preview=' + JSON.stringify(id) + ']'
  if (!await page.eval(`!!document.querySelector(${JSON.stringify(frame)})`)) {
    const tab = await page.centre('[data-preview-format] [role="tab"]', label)
    if (tab) await page.click(tab)
    else {
      await page.clickOn('[data-preview-format] button[aria-label^="Format:"]')
      await page.clickOn(`[role="menuitemcheckbox"][data-menu-row=${JSON.stringify(id)}]`)
    }
  }
  await page.until(label + ' preview to draw', 65_000, () => page.eval(`(() => {
    const frame = document.querySelector(${JSON.stringify(frame)});
    const error = frame?.querySelector('[data-preview-failed], [data-paged-page-failed], [role="alert"]');
    if (error) throw new Error(error.innerText);
    return !!frame?.querySelector('[data-paged-page="1"] canvas')?.width;
  })()`))
}
