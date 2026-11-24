/**
 * What a window tells main about its menu (`menu:state`), apart from the
 * menu tree itself (./menuTree.ts, which re-exports this): the window's
 * first paint needs the state and its comparison, never the tree, and a
 * value import of the tree would carry every row of it into the launch.
 */

/** What a window tells main: the toggles that are open, the items that would
 *  do nothing and the checkbox rows' ticks. */
export interface MenuState {
  open: string[]
  disabled: string[]
  checked: Record<string, boolean>
  /** The rows whose keys a Work editor holding the caret owns now (`EDITOR_KEY_IDS`): each loses its key. */
  editing?: string[]
  /** The rows this window does not draw at all (a `workOnly` row while no host has Work on): no row, and no key. */
  hidden?: string[]
  /** A live Office file has the focus (src/main/officeLive.ts): Word owns the keys of `LIVE_KEY_IDS`, and Find, Print…, Export… and Save do nothing here. */
  live?: boolean
}

/** The rows a Work editor can take the key of: Sidebar's ⌘B (bold), Search's ⌘K (link), Go to File's ⌘P (Print) and Find's ⌘F (the editor's find). */
export const EDITOR_KEY_IDS = ['toggle_sidebar', 'open_search', 'go_to_file', 'find'] as const

/** The rows whose keys Word for the web owns while it has the focus: ⌘F, ⌘P, ⌘S, ⇧⌘E, ⌘K and ⌘B; of these, Find, Print, Export and Save are turned off. */
export const LIVE_KEY_IDS = ['find', 'go_to_file', 'print', 'save_all', 'export', 'open_search', 'toggle_sidebar'] as const
export const LIVE_OFF_IDS = ['find', 'print', 'save_all', 'export'] as const

/** The rows that are Work's alone (the tree's `workOnly` rows; menuTree.test.ts holds the two equal): a window hides them while no host has Work on. */
export const WORK_ONLY_IDS = ['save_word', 'search_work', 'open_today'] as const

export const EMPTY_MENU_STATE: MenuState = { open: [], disabled: [], checked: {} }

export function sameMenuState(a: MenuState, b: MenuState): boolean {
  const same = (x: string[], y: string[]): boolean =>
    x.length === y.length && [...x].sort().join('\n') === [...y].sort().join('\n')
  const ticked = (c: Record<string, boolean>): string[] => Object.keys(c).filter((id) => c[id])
  return same(a.open, b.open) && same(a.disabled, b.disabled) && same(ticked(a.checked), ticked(b.checked)) && same(a.editing ?? [], b.editing ?? []) && same(a.hidden ?? [], b.hidden ?? []) && !!a.live === !!b.live
}
