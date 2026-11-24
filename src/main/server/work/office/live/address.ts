import { posix, win32 } from 'node:path'
import type { OfficeLiveApp, TeamsLibrary } from '@shared/contract-work-office'
import { extOf } from '@shared/work/files'
import { twinOf } from '../files/twins'

export const LIVE_FORMS = ['docx', 'xlsx', 'xlsm', 'pptx'] as const
const APPS: Record<(typeof LIVE_FORMS)[number], OfficeLiveApp> = { docx: 'word', xlsx: 'excel', xlsm: 'excel', pptx: 'powerpoint' }

export function appOf(name: string): OfficeLiveApp | null {
  const ext = extOf(name)
  const form = LIVE_FORMS.find((form) => form === ext)
  return form ? APPS[form] : null
}

export interface LiveAddressOptions {
  libraries?: readonly TeamsLibrary[]
  platform?: NodeJS.Platform
}
export type LiveAddress = { ok: true; url: string } | { ok: false; why: string }

const OUTSIDE = 'The file is outside its synced library.'
const NO_ADDRESS = 'Add the library’s web folder address in Settings.'
const BAD_FOLDER = 'Use a web folder address in Settings.'
const LINK = 'Use the library’s folder address instead of a sharing link.'
const VIEW = 'Use the library’s folder address instead of a view page.'

/** The path rules of the machine that holds the library, including a Windows guest on another host. */
export const pathRules = (library: Pick<TeamsLibrary, 'vm' | 'path'>, platform?: NodeJS.Platform): typeof posix =>
  library.vm || /^[a-z]:[\\/]|^\\\\/i.test(library.path) || platform === 'win32' ? win32 : posix

/** A path below the mount, in the slash-separated spelling that twinOf takes. */
export function relativeLivePath(library: TeamsLibrary, path: string, platform?: NodeJS.Platform): string | null {
  const rules = pathRules(library, platform)
  if (!rules.isAbsolute(library.path) || !rules.isAbsolute(path) || path.includes('\0')) return null
  if (path.split(rules === win32 ? /[\\/]/ : '/').includes('..')) return null
  const rel = rules.relative(library.path, path)
  if (!rel || rel === '..' || rel.startsWith(`..${rules.sep}`) || rules.isAbsolute(rel)) return null
  return rel.split(rules.sep).join('/')
}

const decode = (part: string): string => {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

function parsed(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function inFolder(web: string, file: string): LiveAddress {
  const url = parsed(web)
  if (!url || url.protocol !== 'https:' || url.username || url.password) return { ok: false, why: BAD_FOLDER }
  const base = url.pathname.split('/').map(decode)
  if (base.some((part) => /^:[a-z]:$/i.test(part))) return { ok: false, why: LINK }
  if (base.some((part) => /^forms$|\.aspx$/i.test(part))) return { ok: false, why: VIEW }
  const segments = [...base.filter(Boolean), ...file.split('/')]
  url.pathname = '/' + segments.map(encodeURIComponent).join('/')
  url.search = '?web=1'
  url.hash = ''
  return { ok: true, url: url.href }
}

/** The same place on another desktop or in its VM, with the file relative to that mount. */
export function liveTwin(library: TeamsLibrary, file: string, other: TeamsLibrary): ReturnType<typeof twinOf> {
  if (other.host === library.host && !!other.vm === !!library.vm) return null
  if (library.kind === 'mine' && (!library.tenant || library.tenant.toLowerCase() !== other.tenant?.toLowerCase())) return null
  const here = library.webSource !== 'settings' && library.web && tenantOf(library.web)
  const there = other.webSource !== 'settings' && other.web && tenantOf(other.web)
  if (here && there && here !== there) return null
  return twinOf([other], library, file)
}

function nestedAddress(library: TeamsLibrary, file: string): LiveAddress | null {
  if (!library.webMounts?.length) return null
  const key = file.normalize('NFC').toLowerCase()
  const scope = library.webMounts
    .filter((mount) => key.startsWith(`${mount.folder.normalize('NFC').toLowerCase()}/`))
    .sort((a, b) => b.folder.length - a.folder.length)[0]
  return scope ? inFolder(scope.web, file.split('/').slice(scope.folder.split('/').length).join('/')) : null
}

export function liveAddress(library: TeamsLibrary, path: string, opts: LiveAddressOptions = {}): LiveAddress {
  const file = relativeLivePath(library, path, opts.platform)
  if (file === null) return { ok: false, why: OUTSIDE }
  const nested = nestedAddress(library, file)
  if (nested?.ok) return nested
  const own = library.web ? inFolder(library.web, file) : null
  if (own?.ok && library.webSource !== 'settings') return own
  for (const other of opts.libraries ?? []) {
    const twin = liveTwin(library, file, other)
    if (!twin) continue
    const address = nestedAddress(other, twin.file) ?? (other.web && other.webSource !== 'settings' ? inFolder(other.web, twin.file) : null)
    if (address?.ok) return address
  }
  return own ?? { ok: false, why: NO_ADDRESS }
}

/** The place SharePoint's direct and /:w:/r links name, without any query or fragment. */
export function cloudKey(url: string): string | null {
  const link = parsed(url)
  if (!link?.host) return null
  const path = link.pathname.split('/').map(decode).join('/').replace(/^\/:[wxp]:\/r(?=\/)/i, '').replace(/\/+$/, '')
  // A page that names its file in the query (Doc.aspx, WopiFrame.aspx, edit.aspx?resid=) carries no file path:
  // dropping the query would give every file at that site one key.
  if (/\/_layouts\//i.test(path) || /\.aspx$/i.test(path)) return null
  return link.host.toLowerCase() + path
}

export function tenantOf(url: string): string | null {
  return /^([a-z0-9-]+?)(?:-my)?\.sharepoint\.com$/i.exec(parsed(url)?.hostname ?? '')?.[1] ?? null
}

/** Whether two keys name one cloud file: the same key, or one place by `cloudKey` (SharePoint's paths ignore case). */
export function sameCloudFile(a: string, b: string): boolean {
  if (a === b) return true
  const x = cloudKey(a)
  return x !== null && x.toLowerCase() === cloudKey(b)?.toLowerCase()
}

/** The address Office's own open takes (`ms-word:ofe|u|…`): the file's direct link, its query, fragment and `/:w:/r` dropped. A GUID redirect stays whole. */
export function openAddress(url: string): string {
  const link = parsed(url)
  if (!link || cloudKey(url) === null) return url
  return link.origin + link.pathname.replace(/^\/:[wxp]:\/r(?=\/)/i, '').replace(/\/+$/, '')
}

/**
 * Every synced copy of a file named by its address: the library whose web folder holds it, then the same place in
 * another machine's library (`liveTwin`), each with the file's path there. The deepest web folder first.
 */
export function syncedFilesOf(libraries: readonly TeamsLibrary[], url: string): { library: TeamsLibrary; path: string }[] {
  const key = cloudKey(url)?.toLowerCase()
  if (!key) return []
  const out: { library: TeamsLibrary; path: string }[] = []
  const pathIn = (library: TeamsLibrary, file: string): string | null => {
    const parts = file.split('/')
    if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\0') || (pathRules(library) === win32 && /[\\:]/.test(p)))) return null
    return pathRules(library).join(library.path, ...parts)
  }
  const homes = libraries
    .flatMap((library) => {
      const base = library.web && cloudKey(library.web)?.toLowerCase()
      return base && key.startsWith(`${base}/`) ? [{ library, base, file: cloudKey(url)!.slice(base.length + 1) }] : []
    })
    .sort((a, b) => b.base.length - a.base.length)
  for (const { library, file } of homes) {
    const add = (l: TeamsLibrary, f: string): void => {
      const path = pathIn(l, f)
      if (path && !out.some((o) => o.library.id === l.id)) out.push({ library: l, path })
    }
    add(library, file)
    for (const other of libraries) {
      const twin = liveTwin(library, file, other)
      if (twin) add(twin.library, twin.file)
    }
  }
  return out
}
