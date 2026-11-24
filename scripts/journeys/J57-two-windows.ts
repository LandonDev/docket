import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { replaceText } from './lib/edit'
import { openRow } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { settings, settingsOpen } from './lib/settings'
import type { Window } from './lib/window'

const NAME = 'Shared window notes.txt'
const BEFORE = 'Read it from either window'
const AFTER = 'Practice moved to Thursday'
const RAIL = 'nav [data-rail-path] button'
const nav = 'button, a, [role="link"]'

async function absent(page: Window, labels: string[], row?: string): Promise<string[]> {
  return page.eval(`(() => {
    const labels = ${JSON.stringify(labels)};
    const row = ${JSON.stringify(row ?? null)};
    const settings = document.querySelector('[data-slot="page"]');
    const rows = [...(settings?.querySelectorAll('[data-slot="page-row"]') ?? [])];
    const scope = row ? rows.find(e => e.innerText.includes(row)) ?? rows.find(e => e.innerText.split('\\n')[0] === 'LifeOS') : settings ?? document;
    if (!scope) throw new Error('The row is missing: ' + row);
    return [...scope.querySelectorAll('button, [role="switch"], [role="menuitem"], [role="combobox"]')]
      .filter(e => e.getClientRects().length && !e.closest('[inert], [aria-hidden="true"]'))
      .map(e => (e.getAttribute('aria-label') ?? e.textContent).trim())
      .filter(label => labels.some(word => label === word || label.startsWith(word + ' on ')));
  })()`)
}

async function given(context: Context): Promise<Window> {
  const page = await context.pair.deviceWindow()
  context.evidencePage = page
  return page
}

export default journey({
  id: 'J57',
  title: 'See one workspace in an owner window and a given computer window',
  tier: 1,
  shapes: ['A', 'K'],
  steps: [
    step('Open the same workspace file with both keys', async (context) => {
      const { pair, workspace } = context
      writeFileSync(fileAt(context, NAME), BEFORE)
      await showPlace(context)
      await openRow(pair.page, NAME)
      const other = await given(context)
      await other.dismissPopups()
      if (await settingsOpen(other)) await other.press('button', 'Back')
      await other.clickOn(RAIL, workspace.name)
      await other.clickOn(nav, 'Files')
      // Both windows see the same host tab, but each chooses which one it shows.
      await other.press('tab', NAME)
      await other.until('the given computer to read the original words', 20_000, () => other.eval(
        `document.querySelector('[data-files-file] .cm-content')?.textContent === ${JSON.stringify(BEFORE)}`
      ))
    }),
    step('Edit in the owner window and compare the second window with the host file', async (context) => {
      const { page } = context.pair
      await replaceText(page, AFTER)
      await page.until('the owner’s edit on box', 22_000, () => readFileSync(fileAt(context, NAME), 'utf8') === AFTER)
      const other = await given(context)
      await other.until('the same new words in the other open tab', 20_000, () => other.eval(
        `document.querySelector('[data-files-file] .cm-content')?.textContent === ${JSON.stringify(AFTER)}`
      ))
      await other.shot(join(context.folder, 'given-file.png'))
    }),
    step('Inspect the given computer’s Work, Connections, workspace, Outbox, Routines and Plays controls', async (context) => {
      const page = await given(context)
      const failures: string[] = []
      async function check(name: string, open: () => Promise<void>, ready: string, labels: string[], row?: string) {
        try {
          await open()
          await page.until(name + ' to load', 12_000, () => page.eval(`(() => {
            if (document.body.innerText.includes(${JSON.stringify(ready)})) return true;
            const title = ${JSON.stringify(name + ' did not load')};
            if (document.body.innerText.includes(title)) throw new Error(document.body.innerText.split(title)[1]?.split('Retry')[0]?.trim() || title);
            return false;
          })()`))
          const shown = await absent(page, labels, row)
          if (shown.length) failures.push(name + ': ' + shown.join(', '))
          await page.shot(join(context.folder, name.toLowerCase().replaceAll(' ', '-') + '.png'))
        } catch (error) {
          failures.push(name + ': ' + String(error))
          await page.shot(join(context.folder, name.toLowerCase() + '-failed.png'))
        } finally {
          await page.key('Escape')
        }
      }
      await check('Work', () => settings(page, 'Work'), 'Work for box is changed from a computer that manages it',
        ['Set up', 'Screen size', 'Go back…', 'Delete'])
      await check('Connections', () => settings(page, 'Connections'), 'Not signed in on this host', ['Sign out', 'Sign in…', 'Or a device token'], 'LifeOS on box')
      await check('Workspace', () => settings(page, context.workspace.name), 'Computer use is changed from a computer that manages box',
        ['Voice', 'Waiting on', 'Computer use', 'Copy Teams files', 'Thread defaults'])
      if (await settingsOpen(page)) await page.press('button', 'Back')
      await check('Routines', () => page.clickOn(nav, 'Routines'), 'No routines yet', ['New routine', 'Edit', 'Not now', 'Create…'])
      await check('Plays', () => page.clickOn(nav, 'Plays'), 'No plays yet', ['New play', 'Edit', 'Proposed', 'Starters', 'Save as a play…'])
      const outbox = () => page.clickOn('nav [data-rail-row] button > span.truncate', 'Outbox')
      await check('Outbox', outbox, 'Outbox', ['Stop holding', 'Dismiss', 'Remove grant', 'Send and stop holding'])
      writeFileSync(join(context.folder, 'unavailable-controls.json'), JSON.stringify(failures, null, 2))
      if (failures.length) throw new Error(failures.join(' | '))
    }),
    step('end: the two windows’ edits landed in the real workspace file', (context) => {
      if (readFileSync(fileAt(context, NAME), 'utf8') !== AFTER) throw new Error('The shared workspace file lost the edit')
    })
  ]
})
