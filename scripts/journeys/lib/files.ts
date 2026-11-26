import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { shown, type Window } from './window'

export function dummyLibrary(home: string, site: string): string {
  const cloud = join(home, 'Library', 'CloudStorage')
  const channel = join(cloud, 'OneDrive-SharedLibraries-Dummy U', site + ' - Documents', 'General')
  mkdirSync(channel, { recursive: true })
  mkdirSync(join(cloud, 'OneDrive-Dummy U'), { recursive: true })
  return channel
}

export function fixtures(repo: string, folder: string, stem: string): { deck: string; sheet: string; pdf: string } {
  mkdirSync(folder, { recursive: true })
  const deck = join(folder, stem + '.pptx')
  const sheet = join(folder, stem + '.xlsx')
  const pdf = join(folder, stem + '.pdf')
  copyFileSync(join(repo, 'src/main/server/work/slides/fixtures/kinds.pptx'), deck)
  copyFileSync(join(repo, 'src/main/server/work/sheets/harness/corpus/formulas.xlsx'), sheet)
  writeFileSync(pdf, dummyPdf())
  return { deck, sheet, pdf }
}

export function dummyPdf(): string {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  for (let page = 1; page <= 3; page++) {
    const stream = `BT /F1 24 Tf 72 700 Td (Practice plan - page ${page}) Tj ET\n`
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`)
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`)
  }
  let pdf = '%PDF-1.4\n'
  const offsets = ['0000000000 65535 f \n']
  for (const [i, object] of objects.entries()) {
    offsets.push(String(pdf.length).padStart(10, '0') + ' 00000 n \n')
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
  }
  return pdf + `xref\n0 ${offsets.length}\n${offsets.join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF\n`
}

/** Linux's bin door. Move only this run's files into its own trash. */
export function gioStub(root: string): string {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'gio'), [
    '#!/usr/bin/env bash',
    'set -eu',
    'root="$(dirname -- "$(dirname -- "$0")")"',
    '[[ "$1" == trash ]]',
    'shift',
    '[[ "${1:-}" != -- ]] || shift',
    '[[ "$#" == 1 ]]',
    'file="$(realpath -e -- "$1")"',
    '[[ "$file" == "$root/"* ]]',
    'slot="$(mktemp -d "$root/trash.XXXXXX")"',
    'mv -- "$file" "$slot/"',
    ''
  ].join('\n'), { mode: 0o755 })
  return bin
}

export function rowAt(page: Window, name: string): Promise<{ x: number; y: number } | null> {
  return page.eval(`(() => {
    for (const row of document.querySelectorAll('[data-files-row]')) {
      if (![...row.querySelectorAll('*')].some((el) => !el.childElementCount && el.textContent.trim() === ${JSON.stringify(shown(name))})) continue;
      const r = row.getBoundingClientRect();
      const x = r.x + Math.min(12, r.width / 2), y = r.y + r.height / 2;
      if (row.contains(document.elementFromPoint(x, y))) return { x, y };
      if (r.width && r.height) row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    return null;
  })()`)
}

/** In the page: a file's tab of that name is open, or the folder of that name is the one shown. */
export const openedAs = (name: string): string => `(() => {
  const name = ${JSON.stringify(shown(name))};
  return [...document.querySelectorAll('[data-files-tab][data-tab-kind="file"]')].some((t) => t.textContent.includes(name))
    || document.querySelector('[data-files-bar] [aria-current]')?.textContent.trim() === name;
})()`

/**
 * A row opened by its double-click, as he would; a double-click that opened nothing in 8 s (the list drawn again
 * between its two clicks) is pressed again, twice at most, and said on the log, never hidden.
 */
export async function openRow(page: Window, name: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    const point = await page.steadyPoint(name + ' row', () => rowAt(page, name), 30_000)
    await page.click(point, 2)
    const opened = await page.until(name + ' open', 8_000, () => page.eval(openedAs(name))).then(() => true, () => false)
    if (opened || tries === 2) return
    console.warn(`openRow: the double-click on ${name} opened nothing in 8 s; pressed again`)
  }
}

export async function closeTab(page: Window, name: string): Promise<void> {
  await page.clickOn(`[data-files-tab-close][aria-label=${JSON.stringify('Close ' + shown(name))}]`)
}

export const unzip = (file: string, part: string): string => Bun.spawnSync(['unzip', '-p', file, part]).stdout.toString()

/** Office may split a word across text runs. */
export function holds(file: string, word: string): boolean {
  if (!existsSync(file)) return false
  const ext = file.slice(file.lastIndexOf('.'))
  const parts = ext === '.tcdoc' ? ['preview.md']
    : ext === '.docx' ? ['word/document.xml']
    : ext === '.xlsx' ? ['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml']
    : ext === '.pptx' ? ['ppt/slides/slide1.xml']
    : []
  return (parts.length ? parts.map((part) => unzip(file, part)) : [readFileSync(file, 'utf8')])
    .some((text) => text.replace(/<[^>]+>/g, '').includes(word))
}

/** What a close may ask first, and the answer that lets the tab go: a copy whose changes have not reached its file, or edits only in the tab (copyClose.ts). */
export const CLOSE_ANSWERS = ['Close Anyway', 'Discard']

/** What sits over a tab's close button, in words: the element the pointer would hit, and the dialog or menu it is in. */
export const overClose = (id: string): string => `(() => {
  const close = document.querySelector('[data-files-tab=' + CSS.escape(${JSON.stringify(id)}) + ']')?.parentElement?.querySelector('[data-files-tab-close]');
  if (!close) return 'no close button';
  const r = close.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  if (!hit) return 'nothing at ' + Math.round(r.x) + ',' + Math.round(r.y);
  if (close.contains(hit)) return 'the close button itself';
  const holder = hit.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot]');
  const name = (el) => el.tagName.toLowerCase() + [...el.attributes].filter((a) => a.name !== 'class' && a.name !== 'style').map((a) => '[' + a.name + (a.value ? '="' + a.value.slice(0, 40) + '"' : '') + ']').join('');
  return name(hit) + (holder && holder !== hit ? ' in ' + name(holder) : '') + ': ' + JSON.stringify((holder ?? hit).innerText?.trim().slice(0, 80) ?? '');
})()`

/**
 * Closes the selected file's tab as he would from the keyboard: focus on the tab, Ctrl+W (the view's own close,
 * chords.ts), and the answer that lets it go if the close asks first. It waits on the tab's own id, so a title that
 * changed on import still closes; a tab that stays says what sits over its close button.
 */
export async function closeSelectedFile(page: Window): Promise<void> {
  const selected = '[data-files-tab][data-tab-kind="file"][aria-selected="true"]'
  let id: string | null = null
  await page.until('the selected file tab', 10_000, async () => (id = await page.eval(
    `document.querySelector(${JSON.stringify(selected)})?.getAttribute('data-files-tab') ?? null`
  )))
  const tab = `[data-files-tab=${JSON.stringify(id)}]`
  await page.eval(`document.querySelector(${JSON.stringify(tab)})?.focus()`)
  await page.key('Control+w')
  try {
    await page.until('the file tab to close', 12_000, async () => {
      if (await page.eval(`!document.querySelector(${JSON.stringify(tab)})`)) return true
      for (const answer of CLOSE_ANSWERS) {
        const at = await page.centre('[role="alertdialog"] button, [role="dialog"] button', answer)
        if (at) {
          await page.click(at)
          break
        }
      }
      return false
    })
  } catch (error) {
    const over = await page.eval<string>(overClose(id!)).catch(() => 'unknown')
    throw new Error(`${error instanceof Error ? error.message : String(error)} (over its close button: ${over})`)
  }
}

/**
 * Every file tab of the shown Files view closed, each by `closeSelectedFile`: what one walk or perf row left open
 * never stands in front of the next. A view not on screen holds no tabs to close.
 */
export async function closeFileTabs(page: Window, most = 8): Promise<number> {
  const any = '[data-files-tab][data-tab-kind="file"]'
  let closed = 0
  for (; closed < most; closed++) {
    const at = await page.centre(any)
    if (!at) break
    await page.click(at)
    await closeSelectedFile(page)
  }
  return closed
}
