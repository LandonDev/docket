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
