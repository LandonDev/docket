import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from './record'
import { enterField } from './settings'
import type { Window } from './window'

export function json({ folder }: Context, name: string, value: unknown): void {
  writeFileSync(join(folder, name + '.json'), JSON.stringify(value, null, 2) + '\n')
}

export function shown(page: Window, selector: string, text: string): Promise<boolean> {
  return page.eval(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(el =>
    el.getClientRects().length && el.innerText?.includes(${JSON.stringify(text)}))`)
}

/** The selector of the dialog's field whose label reads `label`, found once it is drawn. */
export async function labelled(page: Window, label: string): Promise<string> {
  let id: string | null = null
  await page.until('the dialog field ' + label, 12_000, async () => (id = await page.eval<string | null>(
    `[...document.querySelectorAll('[role="dialog"] label')].find(el => el.textContent.trim() === ${JSON.stringify(label)})?.htmlFor ?? null`)))
  return '[id=' + JSON.stringify(id) + ']'
}

export async function field(page: Window, label: string, value: string): Promise<void> {
  await enterField(page, await labelled(page, label), value)
}
