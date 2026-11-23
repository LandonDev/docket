/** The sheet kind's words and rules that the host and the canvas both say. No zod: the canvas imports values from here. */
/**
 * Why a change cannot be saved into an opened workbook, in the words he reads as it is stopped: the
 * canvas says them at the press and the host says the same if one reaches it. `google`: the workbook
 * lives in Google Sheets, so that is where the change is made.
 */
export function sheetStopWords(kind: 'moved' | 'rich' | 'fill' | 'other', google = false): string {
  const there = google ? 'Google Sheets' : 'Excel'
  const file = google ? 'a Google sheet' : 'an Excel file'
  if (kind === 'moved') return `Moving cells is not saved in ${file} yet. Cut and paste them instead`
  if (kind === 'rich') return `Text with more than one style in a cell is not saved in ${file} yet`
  if (kind === 'fill') return `That fill could not be saved in ${file}`
  return `That change is not saved in ${file} yet. Make it in ${there}`
}
