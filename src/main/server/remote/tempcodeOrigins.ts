import type { BrowserEndpoints } from '@shared/browserEndpoints'
import { lookup } from 'node:dns/promises'
import { shortHostName } from '@shared/hostNames'
import { isIP } from 'node:net'
import { hostname, networkInterfaces } from 'node:os'
import { kindOf, listEnvironments, type EnvironmentsStore } from './environments'
import { REMOTE_DEFAULT_PORT, readRemoteSettings } from './handlers'

export const TEMPCODE_ORIGIN_REFUSAL = 'refused: TempCode pages are off limits to computer tools.'

export interface TempCodeOrigins extends BrowserEndpoints {
  linkedEndpoints?: readonly BrowserEndpoints[]
  linkedEndpointsUnknown?: boolean
}

function address(host: string): string {
  let bare = host
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
  if (bare.includes(':')) {
    try {
      bare = new URL(`http://[${bare.split('%')[0]}]`).hostname.slice(1, -1)
    } catch {
      return bare
    }
  }
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(bare)
  if (!mapped) return bare
  const high = parseInt(mapped[1]!, 16)
  const low = parseInt(mapped[2]!, 16)
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}

function endpoint(value: string): { host: string; port: number } | undefined {
  try {
    const url = new URL(value)
    if (
      url.protocol === 'blob:' ||
      url.protocol === 'view-source:' ||
      url.protocol === 'filesystem:'
    ) {
      return endpoint(value.slice(value.indexOf(':') + 1))
    }
    const secure = url.protocol === 'https:' || url.protocol === 'wss:'
    if (!secure && url.protocol !== 'http:' && url.protocol !== 'ws:') return
    return { host: address(url.hostname), port: url.port ? Number(url.port) : secure ? 443 : 80 }
  } catch {
    return
  }
}

/** HTTP and WebSocket share the same endpoint. Paths, credentials and fragments do not change it. */
export function isTempCodeOrigin(url: string, origins: TempCodeOrigins): boolean {
  const target = endpoint(url)
  if (!target) return false
  return matchesEndpoint(target, origins, true) || (origins.linkedEndpoints?.some((peer) => matchesEndpoint(target, peer, false)) ?? false)
}

function matchesEndpoint(target: { host: string; port: number }, origins: BrowserEndpoints, local: boolean): boolean {
  const { host, port } = target
  if (origins.tunnelHosts?.some((name) => address(name) === host)) return true
  const loopback =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    host === '::1'
  if (
    origins.listenerPorts.includes(port) &&
    ((local && (loopback || host === '0.0.0.0' || host === '::')) ||
      origins.lanAddresses.some((ip) => address(ip) === host))
  )
    return true
  return origins.remoteRoutes.some((route) => {
    const configured = endpoint(route)
    return configured?.host === host && configured.port === port
  })
}

/** Resolve both sides at a protected port. A failed or empty lookup leaves the caller unable to verify the target. */
export async function resolvesToTempCodeOrigin(
  url: string,
  origins: TempCodeOrigins
): Promise<boolean> {
  if (isTempCodeOrigin(url, origins)) return true
  const target = endpoint(url)
  if (!target) return false
  const { host, port } = target
  const sets = [origins, ...(origins.linkedEndpoints ?? [])]
  const remoteHosts: string[] = []
  let listenerPort = false
  for (const set of sets) {
    const listens = set.listenerPorts.includes(port)
    listenerPort ||= listens
    for (const route of set.remoteRoutes) {
      const configured = endpoint(route)
      if (configured && (listens || configured.port === port)) remoteHosts.push(configured.host)
    }
    // A tunnel can answer on either standard web port when its saved route names only HTTPS.
    if (listens || port === 80 || port === 443) remoteHosts.push(...(set.tunnelHosts ?? []))
  }
  if (origins.linkedEndpointsUnknown && (listenerPort || remoteHosts.length || port === REMOTE_DEFAULT_PORT)) {
    throw new Error('a linked host’s browser addresses are unknown')
  }
  if (!listenerPort && !remoteHosts.length) return false

  const resolve = async (name: string): Promise<string[]> => {
    if (isIP(name)) return [name]
    const answers = await lookup(name, { all: true })
    if (!answers.length) throw new Error('no addresses returned')
    return answers.map((answer) => address(answer.address))
  }
  const addresses = await resolve(host)
  if (
    addresses.some((ip) =>
      isTempCodeOrigin(`http://${isIP(ip) === 6 ? `[${ip}]` : ip}:${port}`, origins)
    )
  )
    return true
  const remoteAddresses = await Promise.all([...new Set(remoteHosts)].map(resolve))
  return remoteAddresses.some((ips) => ips.some((ip) => addresses.includes(ip)))
}

/** Browser requests must name a known local endpoint. Never authorize an incoming Host by resolving it. */
export function isTempCodeBrowserHost(
  host: string,
  proto: 'http' | 'https',
  origins: TempCodeOrigins
): boolean {
  if (!/^(?:[a-z\d_.-]+|\[[a-f\d:.]+\])(?::\d+)?$/i.test(host)) return false
  return isTempCodeOrigin(`${proto}://${host}`, origins)
}

export function readLocalTempCodeOrigins(
  store: Pick<EnvironmentsStore, 'getSetting'>,
  listenerPort: number | null,
  boundPort?: number
): TempCodeOrigins {
  const settings = readRemoteSettings(store)
  const name = hostname()
  const short = shortHostName(name)
  const publicRoutes = [settings.publicOrigin, settings.learnedOrigin ?? ''].filter((route) => endpoint(route))
  const tunnelHosts = publicRoutes.flatMap((route) => {
    const host = endpoint(route)?.host
    return host && host.includes('.') && !isIP(host) && kindOf(host) === 'tunnel' ? [host] : []
  })
  return {
    listenerPorts: [...new Set([settings.port, listenerPort || settings.port, boundPort || settings.port])],
    lanAddresses: [
      name,
      short,
      `${short}.local`,
      ...Object.values(networkInterfaces()).flatMap((rows) => rows?.filter((row) => !row.internal).map((row) => row.address) ?? [])
    ],
    tunnelHosts,
    remoteRoutes: publicRoutes
  }
}

export function readTempCodeOrigins(
  store: EnvironmentsStore,
  listenerPort: number | null,
  boundPort?: number
): TempCodeOrigins {
  const local = readLocalTempCodeOrigins(store, listenerPort, boundPort)
  return {
    ...local,
    remoteRoutes: [
      ...local.remoteRoutes,
      ...listEnvironments(store).flatMap((env) => env.routes.map((route) => route.url))
    ]
  }
}
