import type { Window } from './window'

export const FILES_FIELD = '[data-files-search] input'
export const WORK_FIELD = '[data-work-search] input'
export const WORK_HIT = '[data-work-search] [data-kind="file"][role="option"]'

type SearchReading = { rows: string[]; lines: string[] }

export async function typeQuery(page: Window, field: string, query: string): Promise<void> {
  await page.clickOn(field)
  await page.key('Control+a')
  await page.typeKeys(query)
}

export async function filesReading(page: Window): Promise<SearchReading> {
  return page.eval(`(() => {
    const panel = document.querySelector('[data-files-page]');
    const body = panel.querySelector('[data-files-body]');
    const lines = [...panel.querySelectorAll('[data-files-note]')].map((note) => note.innerText.trim());
    const rows = [...body.querySelectorAll('[data-files-row]')].map((row) => row.innerText.trim().replace(/\\s+/g, ' '));
    if (!rows.length) lines.push(...body.innerText.trim().split('\\n').filter(Boolean));
    return { rows, lines };
  })()`)
}

export async function workReading(page: Window): Promise<SearchReading> {
  return page.eval(`(() => {
    const panel = document.querySelector('[data-work-search]');
    const rows = [...panel.querySelectorAll('[role="option"]')].map((row) => row.innerText.trim().replace(/\\s+/g, ' '));
    const lines = panel.querySelector('[data-work-search-causes]')?.innerText.trim().split('\\n').filter(Boolean) ?? [];
    return { rows, lines };
  })()`)
}

export function explainsMissingContent(lines: string[]): boolean {
  return lines.some((line) => /(?:contents?|text|words inside|library|libraries|teams|onedrive).*(?:not searched|not included|names only|only search)|(?:not searched|not included|names only|only search).*(?:contents?|text|words inside|library|libraries|teams|onedrive)/i.test(line))
}

export type SearchOutcome = { surface: 'Files' | 'Work'; query: 'name' | 'content'; found: boolean; opened: boolean; openedAsTyped?: boolean; lines: string[]; error?: string }

/** A line that names a computer whose folders a search left out ("Folders on Purdue laptop were not searched."). */
export function namesUnsearched(lines: string[]): boolean {
  return lines.some((line) => /folders on .+ (?:was|were) not searched/i.test(line))
}

/**
 * J18's end check. A name opens everywhere, except that a file on a computer the window reaches only through
 * another host (B2) may instead be named as not searched. Words inside a file on another computer (B1, B2) are
 * never searched, as the owner has been told: a miss there is kept as a note, never a failure.
 */
export function searchVerdict(shape: string, results: SearchOutcome[]): { failures: string[]; notes: string[] } {
  const failures: string[] = []
  const notes: string[] = []
  for (const { surface, query, found, opened, lines, error } of results) {
    const label = `${surface} by ${query}`
    const said = lines.join(' / ') || 'no search line'
    if (error) failures.push(`${label}: ${error}`)
    else if (opened) continue
    else if (query === 'content' && shape !== 'A') notes.push(`${label}: not found; words inside a file on another computer are not searched (${said})`)
    else if (query === 'name' && shape === 'B2' && !found && namesUnsearched(lines)) notes.push(`${label}: named as not searched (${said})`)
    else failures.push(`${label}: no open file (${said})`)
  }
  return { failures, notes }
}

