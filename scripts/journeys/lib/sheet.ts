import type { Window } from './window'

export function a1Point(page: Window): Promise<{ x: number; y: number } | null> {
  // Univer draws the grid on a canvas, with row and column headers before A1.
  return page.eval(`(() => {
    const canvas = [...document.querySelectorAll('[data-sheet-item] canvas')].find((el) => el.getBoundingClientRect().width > 100);
    const r = canvas?.getBoundingClientRect();
    return r ? { x: r.x + 78, y: r.y + 30 } : null;
  })()`)
}

export function shownA1(page: Window): Promise<unknown> {
  // The grid has no cell DOM. Read its existing handle, the same one its format row reads.
  return page.eval(`(() => {
    const grid = document.querySelector('[data-sheet-item]');
    if (!grid) return null;
    for (const el of [grid, ...grid.querySelectorAll('*')]) {
      const key = Object.keys(el).find((name) => name.startsWith('__reactFiber$'));
      for (let fiber = el[key]; fiber; fiber = fiber.return) {
        const api = fiber.memoizedProps?.sheet?.api;
        if (api) return api.getActiveWorkbook()?.getActiveSheet()?.getRange(0, 0)?.getValue();
      }
    }
    return null;
  })()`)
}

export function cellValue(sheet: string, strings: string, ref: string): string | undefined {
  const cell = [...sheet.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
    .find(([, attributes]) => attributes?.match(/\br="([^"]+)"/)?.[1] === ref)
  if (!cell) return undefined
  const kind = cell[1]?.match(/\bt="([^"]+)"/)?.[1]
  const inner = cell[2] ?? ''
  const value = inner.match(/<v>([^<]*)<\/v>/)?.[1]
  const runs = (text: string): string => [...text.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((r) => r[1]).join('')
  if (kind === 'inlineStr') return runs(inner)
  if (kind === 's' && value !== undefined) {
    const entry = [...strings.matchAll(/<si>([\s\S]*?)<\/si>/g)][Number(value)]?.[1]
    return entry === undefined ? undefined : runs(entry)
  }
  return value
}

/** A cell of a sheet's XML as Excel reads it: its type (`t`, none for a number), its value as shown, its formula. */
export function cellOf(sheet: string, strings: string, ref: string): { t: string | null; value: string | undefined; formula: string | undefined } | undefined {
  const cell = [...sheet.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
    .find(([, attributes]) => attributes?.match(/\br="([^"]+)"/)?.[1] === ref)
  if (!cell) return undefined
  return { t: cell[1]?.match(/\bt="([^"]+)"/)?.[1] ?? null, value: cellValue(sheet, strings, ref), formula: (cell[2] ?? '').match(/<f(?:\s[^>]*)?>([^<]*)<\/f>/)?.[1] }
}

export function falseSaveLine(line: string | null, committed: boolean, landed: boolean): boolean {
  if (!committed || !line) return false
  // The holder's disk settles whether "Saved" is true. OneDrive sync can still be pending.
  return !landed && /^(?:Saved\b|On\b|Uploading\b|Waiting to upload\b)/.test(line)
}
