import type { Window } from './window'

/**
 * A Work job's column shows Mail, Tasks, Agenda and Messages; every other view sits under its More fold
 * (work/shell/WorkColumn.tsx `MoreFold`). Before a walk presses such a view by its words, the fold is opened.
 */
export async function revealView(page: Window, selector: string, view: string): Promise<void> {
  if (await page.centre(selector, view)) return
  if (await page.centre('[data-more-fold][aria-expanded="false"]')) await page.clickOn('[data-more-fold]')
  await page.until(`${view} under More`, 10_000, () => page.centre(selector, view))
}
