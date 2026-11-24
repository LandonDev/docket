import { rowAt } from './files'
import type { Window } from './window'

export async function rowMenu(page: Window, name: string): Promise<void> {
  let at: Awaited<ReturnType<typeof rowAt>> = null
  await page.until(name + ' row', 20_000, async () => (at = await rowAt(page, name)))
  await page.click(at!, 1, 'right')
  await page.until('the row menu', 5000, () => page.eval('!!document.querySelector("[role=menuitem]")'))
}

export async function tabMenu(page: Window, name: string): Promise<void> {
  await page.press('button', 'More for ' + name)
  await page.until('the tab menu', 5000, () => page.eval('!!document.querySelector("[role=menuitem]")'))
}

export async function renameField(page: Window, oldName: string, stem: string): Promise<void> {
  const selector = `input[aria-label=${JSON.stringify('Rename ' + oldName)}]`
  await page.until('the selected name stem', 10_000, () => page.eval(`document.activeElement?.matches(${JSON.stringify(selector)})`))
  await page.typeKeys(stem)
  await page.key('Enter')
}
