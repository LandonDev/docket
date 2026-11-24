import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { holderFolder } from './place'
import type { Context } from './record'
import type { Window } from './window'

/**
 * Shape B2: a library on a third computer reached through the box. New, Rename and Delete are not offered there; that
 * is honest as it stands, and offering them is the owner's ruling. A B2 walk asserts exactly that: the verb is not in
 * the menu, and nothing on the holder changed.
 */

/** The holder folder's files by name, each with its bytes' SHA-256. */
export function holderState(context: Context): Record<string, string> {
  const folder = holderFolder(context)
  return Object.fromEntries(readdirSync(folder).sort().map((name) => [name, createHash('sha256').update(readFileSync(join(folder, name))).digest('hex')]))
}

/** The names whose bytes differ between two holder states, and those added or gone. */
export function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name]).sort()
}

/** Throws unless the holder folder is as `before`; writes both states beside the pictures. */
export function sameHolder(context: Context, before: Record<string, string>, label: string): void {
  const after = holderState(context)
  writeFileSync(join(context.folder, label + '-holder.json'), JSON.stringify({ before, after }, null, 2))
  const moved = changed(before, after)
  if (moved.length) throw new Error(`The holder changed: ${moved.join(', ')}`)
}

/** A menu row as he sees it: its label, whether it takes a press, and all its words. */
export type MenuItem = { label: string; enabled: boolean; words: string }

/** The open menu's items, read (and kept as `<keep>.json` beside the pictures when named), then the menu closed. */
export async function menuItems(page: Window, keep?: { context: Context; name: string }): Promise<MenuItem[]> {
  const items = await page.eval<MenuItem[]>(`[...document.querySelectorAll('[role="menuitem"]')].map((item) => ({
    label: (item.querySelector('[data-menu-label]')?.textContent ?? item.innerText.split('\\n')[0] ?? '').trim(),
    enabled: !item.matches(':disabled, [aria-disabled="true"], [data-disabled]'),
    words: item.innerText.trim() }))`)
  if (keep) writeFileSync(join(keep.context.folder, keep.name + '.json'), JSON.stringify(items, null, 2))
  await page.key('Escape')
  return items
}

/**
 * Throws if `verb` takes a press in the menu. A row that is there but disabled is not offered: the far library lists
 * Rename and Delete greyed out (the host's verb rows say `refused`), and lists no New at all.
 */
export function notOffered(items: readonly MenuItem[], verb: string, where: string): void {
  if (items.some((item) => item.enabled && item.label.replace(/…$/, '') === verb)) throw new Error(`${where} offers ${verb} in the far library`)
}
