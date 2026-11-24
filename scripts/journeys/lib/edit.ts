import type { Window } from './window'

export const SLIDE_TEXT = '[data-slide-typing][data-phase="typing"] [contenteditable="true"]'
export const TEXT_EDITOR = '[data-files-file] .cm-content, [data-files-file] textarea, [data-files-file] [contenteditable="true"]'

export async function editShape(page: Window, selector: string): Promise<void> {
  await page.until('the slide shape', 45_000, async () => {
    const point = await page.eval<{ x: number; y: number } | null>(`(() => {
      const shape = document.querySelector(${JSON.stringify(selector)});
      const r = shape?.getBoundingClientRect();
      return r?.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    })()`)
    if (!point) return false
    await page.click(point)
    return page.eval(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-pressed') === 'true'`)
  })
  await page.key('Enter')
  await waitForFocus(page, SLIDE_TEXT)
}

export async function waitForFocus(page: Window, selector: string): Promise<void> {
  await page.until('the editor to take focus', 10_000, () => page.eval(`document.activeElement?.matches(${JSON.stringify(selector)})`))
}

export async function replaceText(page: Window, text: string): Promise<void> {
  await page.clickOn(TEXT_EDITOR)
  await waitForFocus(page, TEXT_EDITOR)
  await page.key('Control+a')
  await page.typeKeys(text)
  await page.until('the typed words in the text editor', 5000, () => page.eval(`(() => {
    const field = document.activeElement;
    return (field?.value ?? field?.textContent)?.trim() === ${JSON.stringify(text)};
  })()`))
}

export const DOC_EDITOR = '[data-doc-scroller] [contenteditable="true"]'

export async function focusDocument(page: Window): Promise<void> {
  await page.until('the document to take focus', 35_000, async () => {
    const at = await page.centre(DOC_EDITOR)
    if (!at) return false
    await page.click(at)
    return page.eval(`!!document.activeElement?.closest(${JSON.stringify(DOC_EDITOR)})`)
  })
}

export function documentHas(page: Window, ...lines: string[]): Promise<boolean> {
  return page.eval(`(() => {
    const text = [...document.querySelectorAll(${JSON.stringify(DOC_EDITOR)})].map((editor) => editor.innerText).join('\\n');
    return ${JSON.stringify(lines)}.every((line) => text.includes(line));
  })()`)
}
