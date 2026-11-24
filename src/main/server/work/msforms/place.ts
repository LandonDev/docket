import type { TeamsLibrary } from '@shared/contract-work-office'
import type { MsFormFolder } from '@shared/contract-work-msforms'

/**
 * Where a form lives in SharePoint, from the library Files names: its site,
 * its folder's page and server-relative path, its tenant. Read only from the
 * library's web namespace (`TeamsLibrary.web`), never from a model's words.
 */

const SITE = /^https:\/\/([a-z0-9-]+?)(-my)?\.sharepoint\.com(\/(?:sites|teams|personal)\/[^/]+)\/(.*)$/i

export interface SitePlace {
  tenant: string
  siteUrl: string
  /** the library's root, server-relative: `/sites/RecWell/Shared Documents` */
  libraryPath: string
}

/** The site, tenant and library root of a library's web namespace, or null when it is not SharePoint's. */
export function siteOf(web: string | null | undefined): SitePlace | null {
  if (!web) return null
  let url: URL
  try {
    url = new URL(web)
  } catch {
    return null
  }
  const m = SITE.exec(`${url.origin}${decodeURIComponent(url.pathname)}`)
  if (!m) return null
  const [, tenant, my, site, rest] = m
  const origin = `https://${tenant.toLowerCase()}${my ?? ''}.sharepoint.com`
  const library = rest.replace(/\/+$/, '').split('/')[0]
  if (!library) return null
  return { tenant: tenant.toLowerCase(), siteUrl: `${origin}${site}`, libraryPath: `${site}/${library}` }
}

const clean = (path: string): string =>
  path
    .split(/[\\/]+/)
    .filter((p) => p && p !== '.' && p !== '..')
    .join('/')

/** A folder of a library as the form's row keeps it, or null when the library is not on SharePoint. */
export function folderOf(library: TeamsLibrary, path: string): (MsFormFolder & { tenant: string; libraryPath: string }) | null {
  const site = siteOf(library.web)
  if (!site) return null
  const inside = clean(path)
  return {
    libraryId: library.id,
    path: inside,
    siteUrl: site.siteUrl,
    tenant: site.tenant,
    libraryPath: site.libraryPath,
    label: [library.team, library.library, ...inside.split('/').filter(Boolean)].filter(Boolean).join(' › ')
  }
}

/** The folder's server-relative path: what a workbook's parent must be. */
export function folderServerPath(folder: MsFormFolder, libraryWeb: string | null): string | null {
  const site = siteOf(libraryWeb)
  if (!site || !folder.siteUrl.toLowerCase().startsWith(site.siteUrl.toLowerCase())) return null
  return [site.libraryPath, clean(folder.path)].filter(Boolean).join('/')
}

/** The folder's page in the library, where Create or upload offers Forms survey. */
export function folderPageOf(folder: MsFormFolder, libraryWeb: string | null): string | null {
  const server = folderServerPath(folder, libraryWeb)
  const site = siteOf(libraryWeb)
  if (!server || !site) return null
  const origin = new URL(site.siteUrl).origin
  return `${origin}${encodeURI(`${site.libraryPath}/Forms/AllItems.aspx`)}?id=${encodeURIComponent(server)}`
}
