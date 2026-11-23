import { extOf } from './files'

export const SLIDE_IMPORT_EXTS = ['ppt', 'pps', 'ppsx', 'odp', 'key'] as const
export type SlideImportExt = (typeof SLIDE_IMPORT_EXTS)[number]

export function slideImportExt(name: string): SlideImportExt | undefined {
  const ext = extOf(name)
  return SLIDE_IMPORT_EXTS.find((format) => format === ext)
}

export function isSlideShowFile(name: string): boolean {
  const ext = slideImportExt(name)
  return ext === 'pps' || ext === 'ppsx'
}

const FORMAT_WORDS: Record<SlideImportExt, string> = {
  ppt: 'a PowerPoint 97–2003 file',
  pps: 'a PowerPoint show',
  ppsx: 'a PowerPoint show',
  odp: 'an OpenDocument file',
  key: 'a Keynote file'
}

/** Why an imported deck refuses every change: it opens as a picture of itself until he makes a copy. */
export const importReadOnly = (ext: SlideImportExt): string => `This is ${FORMAT_WORDS[ext]}, read only here. Make a copy to edit.`

/**
 * A Keynote deck LibreOffice could not read. The wire carries a failure as its sentence alone, so this one constant
 * is the kind both ends know: the host throws it only for a real import failure, and the window shows it with no Retry.
 */
export const KEYNOTE_EXPORT = 'Export this from Keynote as PowerPoint'
