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
  // A GUID redirect carries no file path. Dropping its query would give every file at that site the same key.
  if (/\/_layouts\/\d+\/doc\.aspx$/i.test(path)) return null
  return link.host.toLowerCase() + path
}

export function tenantOf(url: string): string | null {
  return /^([a-z0-9-]+?)(?:-my)?\.sharepoint\.com$/i.exec(parsed(url)?.hostname ?? '')?.[1] ?? null
}
