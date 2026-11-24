import { join } from 'node:path'
import { FILE_MAKE_KINDS, type FileMakeKind } from '@shared/contract-work-files'
import type { CanvasKind } from '@shared/work'
import type { FileForm } from '@shared/work/fileForms'
import type { FilePlace } from '@shared/work/files'
import { appRoot } from '../../appRoot'

/**
 * What New makes, and in which form (docs/agents/work-files.md "New, rename, move and copy"). The form follows
 * the place: the workspace's folder keeps our own documents and sheets, a Teams or OneDrive library keeps
 * Office's, so the team can open them. A kind is offered only where it opens ready to edit.
 */

type FileKind = Exclude<FileMakeKind, 'folder'>

/** The form a kind takes in a place, by where it is made. */
const FORMS: Record<'folder' | 'library', Record<FileKind, FileForm>> = {
  folder: { document: 'tcdoc', sheet: 'tcsheet', deck: 'pptx', text: 'md' },
  library: { document: 'docx', sheet: 'xlsx', deck: 'pptx', text: 'txt' }
}

/** The canvas kind whose maker writes a kind (hooks.ts `registerFileMaker`). Text has no maker: it starts empty. */
export const MAKER_KIND: Record<FileKind, CanvasKind | null> = { document: 'document', sheet: 'sheet', deck: 'slides', text: null }

const isLibrary = (place: Pick<FilePlace, 'kind'>): boolean => place.kind === 'teams' || place.kind === 'onedrive'

/** The form a new file of `kind` takes in `place`; null for a folder, or a place that makes no files. */
export function formIn(place: Pick<FilePlace, 'kind'>, kind: FileMakeKind): FileForm | null {
  if (kind === 'folder') return null
  if (place.kind === 'folder') return FORMS.folder[kind]
  return isLibrary(place) ? FORMS.library[kind] : null
}

/**
 * What New offers in a place: only what opens ready to edit there. The workspace's folder takes every kind. A
 * library takes a folder and a text file always; a sheet where a maker writes `.xlsx` or this host has Excel
 * (Excel stands behind the grid); a document always, Files' own blank `.docx`; a deck once a maker writes `.pptx` in place.
 * In the Windows VM, where its helper makes things (`make` in the place's `can`), the same less this host's Excel,
 * which stands behind no file there. `has` answers whether a maker is registered for a canvas kind and form.
 */
export function offersIn(place: Pick<FilePlace, 'kind' | 'vm'> & { can?: FilePlace['can'] }, has: (kind: CanvasKind, form: FileForm) => boolean, excel = false): FileMakeKind[] {
  if (place.kind === 'folder') return [...FILE_MAKE_KINDS]
  if (!isLibrary(place) || (place.vm && !place.can?.includes('make'))) return []
  // A document is Files' own blank Word file (resources/work-files/blank/blank.docx), which opens as the Word-backed
  // document and saves by itself (word.ts): no maker is needed for it.
  const ok: Record<FileMakeKind, boolean> = { document: true, sheet: (excel && !place.vm) || has('sheet', 'xlsx'), deck: has('slides', 'pptx'), text: true, folder: true }
  return FILE_MAKE_KINDS.filter((kind) => ok[kind])
}

const KIND_WORDS: Record<FileMakeKind, string> = { document: 'A document', sheet: 'A sheet', deck: 'A deck', text: 'A text file', folder: 'A folder' }
const APP_OF: Partial<Record<FileMakeKind, string>> = { document: 'Word', sheet: 'Excel', deck: 'PowerPoint' }

/** The one sentence for a kind New does not offer in a place. */
export function notOffered(place: Pick<FilePlace, 'name' | 'vm'> & { can?: FilePlace['can'] }, kind: FileMakeKind): string {
  if (place.vm && !place.can?.includes('make')) return 'Files in the Windows VM cannot be changed from here yet. Open it there.'
  const app = APP_OF[kind]
  return `${KIND_WORDS[kind]} cannot be made in ${place.name} yet.${app ? ` Make it in ${app}, or in your workspace's folder.` : ''}`
}

/**
 * The extensions a template for a kind may have in a place, and so the made file's: in the workspace's folder
 * what that kind opens as itself; in a library only the library's own form, so no file of ours lands where the
 * team cannot open it.
 */
const TEMPLATE_EXTS: Record<FileKind, readonly FileForm[]> = { document: ['tcdoc', 'docx'], sheet: ['tcsheet', 'xlsx'], deck: ['pptx'], text: ['md', 'txt'] }
export const templateExts = (place: Pick<FilePlace, 'kind'>, kind: FileKind): readonly FileForm[] => (place.kind === 'folder' ? TEMPLATE_EXTS[kind] : isLibrary(place) ? [FORMS.library[kind]] : [])
export const templateRefused = (place: Pick<FilePlace, 'kind'>, kind: FileKind, name: string): string =>
  `${name} cannot start ${KIND_WORDS[kind].toLowerCase()} here. Pick a ${templateExts(place, kind)
    .map((e) => `.${e}`)
    .join(' or ')} file.`

/** Where Files' own blank files are: shipped with the app under resources/ (asar is off, so the folder is a real one). */
let blankDir = (): string => join(appRoot(), 'resources', 'work-files', 'blank')
/** Tests only: where the blank files are read from. */
export const setBlankDir = (dir: (() => string) | null): void => void (blankDir = dir ?? (() => join(appRoot(), 'resources', 'work-files', 'blank')))

/** Files' own blank of a form: empty bytes for text, else the shipped file to copy. */
export function blankOf(form: FileForm): Uint8Array | { from: string } {
  if (form === 'md' || form === 'txt') return new Uint8Array(0)
  return { from: join(blankDir(), `blank.${form}`) }
}
