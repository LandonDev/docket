import { existsSync, readdirSync } from 'node:fs'
import type { Template } from '../../src/shared/work/templates'
import { holds, openRow } from './lib/files'
import { fileAt, selectFolderTab, showPlace } from './lib/place'
import { journey, step } from './lib/record'

const STARTER = 'Meeting notes'
const VALUE = 'Practice in the park'
const SAVED = 'Park meeting form'
const SHELF = '[data-templates-view]'
const DIALOG = '[role="dialog"]'

export default journey({
  id: 'J28',
  title: 'Fill a template, save a file as a template, and edit a starter copy',
  tier: 1,
  shapes: ['A'],
  steps: [
    step('Choose Meeting notes and fill the requested Meeting field', async (context) => {
      await showPlace(context)
      const { page } = context.pair
      await page.press('button', 'Templates')
      await page.clickOn(SHELF + ' button', STARTER)
      let field: string | undefined
      await page.until('the Meeting field in the template dialog', 12_000, async () => (field = await page.eval<string>(`[...document.querySelectorAll('${DIALOG} label')].find(l => l.textContent.trim() === 'Meeting')?.htmlFor`)))
      await page.clickOn('input[id=' + JSON.stringify(field) + ']')
      await page.typeKeys(VALUE)
      await page.press('button', 'Create')
      await page.until('the filled Word file on box', 25_000, () => readdirSync(context.workspace.path).some((name) =>
        name.endsWith('.docx') && holds(fileAt(context, name), VALUE)))
    }),
    step('Pick Edit a copy from the starter’s menu', async ({ pair, workspace }) => {
      const { page } = pair
      await page.press('button', 'Templates')
      await page.until('the starter tile', 12_000, () => page.centre(SHELF + ' button', STARTER))
      const at = await page.centre(SHELF + ' button', STARTER)
      if (!at) throw new Error('Meeting notes is absent from the shelf')
      await page.click(at, 1, 'right')
      await page.press('menuitem', 'Edit a copy')
      await page.until('the starter copy in the selected file tab', 20_000, () => page.eval(
        `document.querySelector('[data-files-tab][data-tab-kind="file"][aria-selected="true"]')?.textContent.includes(${JSON.stringify(STARTER)})`
      ))
      const { templates } = await pair.rpc<{ templates: Template[] }>(pair.box, 'work.templates.list', { workspaceId: workspace.id })
      if (!templates.some((tile) => tile.name === STARTER && tile.id.startsWith('job:'))) throw new Error('The host did not keep a copy for this job')
    }),
    step('Save the made file as a template and see it on the shelf', async (context) => {
      const { page } = context.pair
      const made = readdirSync(context.workspace.path).find((name) => name.endsWith('.docx') && holds(fileAt(context, name), VALUE))
      if (!made) throw new Error('The Word file made from the template is missing')
      await showPlace(context)
      await selectFolderTab(context)
      await openRow(page, made)
      await page.clickOn('[data-files-header] button[aria-label^="More for "]')
      await page.press('menuitem', 'Save as template')
      await page.clickOn(DIALOG + ' input')
      await page.key('Control+a')
      await page.typeKeys(SAVED)
      await page.press('button', 'Save')
      await page.press('button', 'Templates')
      await page.until('the saved template tile', 15_000, () => page.centre(SHELF + ' button', SAVED))
    }),
    step('end: the saved template and the starter copy are on the host and the copy is open', async ({ pair, workspace }) => {
      const templates = await pair.rpc<{ templates: Template[] }>(pair.box, 'work.templates.list', { workspaceId: workspace.id })
      if (![SAVED, STARTER].every((name) => templates.templates.some((tile) => tile.name === name && tile.id.startsWith('job:') && tile.source.at === 'file' && existsSync(tile.source.path)))) {
        throw new Error('The host shelf does not have both templates of the workspace’s own')
      }
    })
  ]
})
