import type { Window } from './window'

export const settingsOpen = (page: Window) => page.eval<boolean>(
  `!!document.querySelector('div[aria-label="Settings"] [role="group"]')`
)

export const DIALOG = '[role="dialog"]'

export async function settings(page: Window, section: string): Promise<void> {
  const rail = '[aria-label="Settings"]'
  await page.dismissPopups()
  if (!await settingsOpen(page)) await page.press('button', 'Settings')
  await page.clickOn(rail + ' button > span.truncate, ' + rail + ' a', section)
}

export const dialogWords = (page: Window) => page.eval<string>(`document.querySelector('[role="dialog"]')?.innerText ?? ''`)

export async function enterField(page: Window, selector: string, words: string): Promise<void> {
  await page.until('the input to take focus', 12_000, async () => {
    if (await page.eval(`document.activeElement?.matches(${JSON.stringify(selector)})`)) return true
    const at = await page.centre(selector)
    if (at) await page.click(at)
    return false
  })
  await page.key('Control+a')
  await page.typeKeys(words)
  await page.until('the input to hold the typed words', 10_000, () => page.eval(
    `document.activeElement?.matches(${JSON.stringify(selector)}) && document.activeElement.value === ${JSON.stringify(words)}`
  ))
}
