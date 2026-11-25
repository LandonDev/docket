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

export async function openRow(page: Window, name: string): Promise<void> {
  const point = await page.steadyPoint(name + ' row', () => rowAt(page, name), 30_000)
  await page.click(point, 2)
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

export async function closeSelectedFile(page: Window): Promise<void> {
  const selected = '[data-files-tab][data-tab-kind="file"][aria-selected="true"]'
  let id: string | null = null
  await page.until('the selected file tab', 10_000, async () => (id = await page.eval(
    `document.querySelector(${JSON.stringify(selected)})?.getAttribute('data-files-tab') ?? null`
  )))
  const tab = `[data-menu-id=${JSON.stringify(id)}]`
  await page.clickOn(tab + ' [data-files-tab-close]')
  await page.until('the selected file tab to close', 12_000, () =>
    page.eval(`!document.querySelector(${JSON.stringify(tab)})`)
  )
}
