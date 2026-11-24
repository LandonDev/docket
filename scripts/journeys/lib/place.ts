import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from './record'
import { settingsOpen } from './settings'
import { openRow } from './files'

export function holderFolder({ pair, workspace, shape }: Context): string {
  if (shape === 'A' || shape === 'K' || shape === 'U') return workspace.path
  const library = shape === 'B1' ? pair.l1 : shape === 'B2' ? pair.l2 : undefined
  if (!library) throw new Error(`No library for ${shape}`)
  return join(library, workspace.name)
}

export function fileAt(context: Context, name: string): string {
  const folder = holderFolder(context)
  mkdirSync(folder, { recursive: true })
  return join(folder, name)
}

export async function showPlace(context: Context): Promise<void> {
  const { page } = context.pair
  // A previous failed walk may have left a menu or a confirmation in front of the rail.
  await page.dismissPopups()
  if (await settingsOpen(page)) await page.press('button', 'Back')
  const rail = 'nav [data-rail-path] button'
  await page.clickOn(rail, context.workspace.name)
  await page.until(context.workspace.name + ' selected', 15_000, () => page.centre(rail + '[aria-current="true"]', context.workspace.name))
  if (!await page.centre('[data-files-view]')) await page.clickOn('button, a, [role="link"]', 'Files')
  await page.until('the workspace’s Files sidebar', 15_000, () => page.centre('[data-files-sidebar] button', context.workspace.name))
  await goPlace(context)
}

export async function goPlace(context: Context): Promise<void> {
  const { page } = context.pair
  if (context.shape === 'A' || context.shape === 'K' || context.shape === 'U') {
    await page.clickOn('[data-files-sidebar] button', context.workspace.name)
    return
  }
  await page.clickOn('[data-files-sidebar] button', context.shape === 'B1' ? 'Journey Teams L1' : 'Journey Teams L2')
  await openRow(page, 'General')
  await openRow(page, context.workspace.name)
}

export async function selectFolderTab(context: Context): Promise<void> {
  await context.pair.page.clickOn('[data-files-tab][data-tab-kind="page"]', context.workspace.name)
}
