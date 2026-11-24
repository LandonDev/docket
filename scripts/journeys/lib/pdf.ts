import type { Window } from './window'

export const PDF_FIRST = '[data-pdf-page="1"]'

export async function selectPdfLine(page: Window): Promise<void> {
  let bounds: { x: number; y: number; right: number } | null = null
  await page.until('the PDF text layer', 30_000, async () => (bounds = await page.eval(`(() => {
    const span = document.querySelector('${PDF_FIRST} [data-pdf-text] span');
    if (!span?.textContent?.trim() || !span.closest('[data-pdf-page]')?.querySelector('canvas')?.width) return null;
    const range = document.createRange();
    range.selectNodeContents(span);
    const r = range.getBoundingClientRect();
    return r.width ? { x: r.x, y: r.y + r.height / 2, right: r.right } : null;
  })()`)))
  const { x, y, right } = bounds!
  await page.drag({ x: x + 1, y }, { x: right + 1, y })
  if (await page.eval(`getSelection()?.toString().trim() === 'Practice plan - page 1'`)) return

  // PDF.js's transparent text span can have hit boxes that end before its last glyph.
  // Set the browser's selection to the same real words, then give the page its pointer-up.
  await page.eval(`(() => {
    const span = document.querySelector('${PDF_FIRST} [data-pdf-text] span');
    const selection = getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(span);
    selection.addRange(range);
    span.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  })()`)
}
