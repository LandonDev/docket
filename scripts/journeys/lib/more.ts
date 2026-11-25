import type { Window } from './window'

/**
 * A Work job's column shows Mail, Tasks, Agenda and Messages; every other view sits under its More fold
 * (work/shell/WorkColumn.tsx `MoreFold`). Before a walk presses such a view by its words, the fold is opened.
 * The column may not be drawn yet when the walk gets here (a rail press just made, a /ui page still reading its
 * host): the fold is looked for, and opened, for as long as the view is waited for, never once before it.
 */
export async function revealView(page: Window, selector: string, view: string): Promise<void> {
  let pressed = 0
  await page.until(`${view} under More`, 15_000, async () => {
    if (await page.centre(selector, view)) return true
    // A press is given a second to open the fold before another, so a slow draw is never toggled shut again.
    const fold = Date.now() - pressed > 1_000 ? await page.centre('[data-more-fold][aria-expanded="false"]') : null
    if (fold) {
      pressed = Date.now()
      await page.click(fold)
    }
    return false
  })
}
