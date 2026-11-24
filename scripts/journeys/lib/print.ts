import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Record the PDF Electron hands to the system viewer without starting a viewer or printer. */
export function printViewer(bin: string): void {
  writeFileSync(join(bin, 'xdg-open'), [
    '#!/usr/bin/env bash',
    'set -eu',
    'root="$(dirname -- "$(dirname -- "$0")")"',
    '[[ "$#" == 1 ]]',
    '[[ "$1" == "$root/"*-tmp/TempCode-print/*/*.pdf && -f "$1" ]]',
    'printf "%s\n" "$1" >> "$root/print-viewer.log"',
    ''
  ].join('\n'), { mode: 0o755 })
}

export function letterPaper(pages: readonly { width: number; height: number }[]): boolean {
  return pages.length > 0 && pages.every(({ width, height }) =>
    Math.abs(Math.min(width, height) - 612) < 1 && Math.abs(Math.max(width, height) - 792) < 1)
}
