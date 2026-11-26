import type { BrowserEndpoints } from '@shared/browserEndpoints'
import { lookup } from 'node:dns/promises'
import { shortHostName } from '@shared/hostNames'
import { isIP } from 'node:net'
import { hostname, networkInterfaces } from 'node:os'
import { kindOf, listEnvironments, type EnvironmentsStore } from './environments'
import { isForbiddenHostname, isPrivateAddress } from './addressGuard'
import { readRemoteSettings } from './handlers'
import { hostAliases, originAliases } from '@shared/publicHosts'

export const TEMPCODE_ORIGIN_REFUSAL = 'refused: Docket pages are off limits to computer tools.'

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

/** A set with each public name's alias beside it (src/shared/publicHosts.ts), so either name is the host's, whichever one it saved or a peer announced. */
function aliased<T extends BrowserEndpoints>(set: T): T {
  return {
    ...set,
    remoteRoutes: [...new Set(set.remoteRoutes.flatMap(originAliases))],
    ...(set.tunnelHosts ? { tunnelHosts: [...new Set(set.tunnelHosts.flatMap(hostAliases))] } : {})
  }
}

function withAliases(origins: TempCodeOrigins): TempCodeOrigins {
  return { ...aliased(origins), ...(origins.linkedEndpoints ? { linkedEndpoints: origins.linkedEndpoints.map(aliased) } : {}) }
}

/** HTTP and WebSocket share the same endpoint. Paths, credentials and fragments do not change it. */
export function isTempCodeOrigin(url: string, origins: TempCodeOrigins): boolean {
  const target = endpoint(url)
  if (!target) return false
  const all = withAliases(origins)
  return matchesEndpoint(target, all, true) || (all.linkedEndpoints?.some((peer) => matchesEndpoint(target, peer, false)) ?? false)
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
  given: TempCodeOrigins
): Promise<boolean> {
  const origins = withAliases(given)
  if (isTempCodeOrigin(url, origins)) return true
  const target = endpoint(url)
  if (!target) {
    if (origins.linkedEndpointsUnknown) throw new Error('a linked host’s browser addresses are unknown')
    return false
  }
  const { host, port } = target
  const peers = origins.linkedEndpoints ?? []
  // A peer's last list cannot clear a port it never named. This also covers the
  // interval between a move and the arrival of the peer's new list.
  const unconfirmed = peers.filter((peer) => !peer.listenerPorts.includes(port))
  const publicOnly = origins.linkedEndpointsUnknown || unconfirmed.length > 0
  const sets = [origins, ...peers]
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
  if (!publicOnly && !listenerPort && !remoteHosts.length) return false
  const unconfirmedHosts = new Set(unconfirmed.flatMap((peer) => peer.lanAddresses.map(address)))
  if (origins.linkedEndpointsUnknown) {
    for (const route of origins.remoteRoutes) {
      const configured = endpoint(route)
      if (configured) unconfirmedHosts.add(configured.host)
    }
  }
  if (unconfirmedHosts.has(host)) return true
  if (publicOnly && !isIP(host) && isForbiddenHostname(host)) {
    throw new Error('a linked host’s browser addresses are unknown on this port')
  }

  const resolve = async (name: string): Promise<string[]> => {
    if (isIP(name)) return [name]
    const answers = await lookup(name, { all: true })
    if (!answers.length) throw new Error('no addresses returned')
    return answers.map((answer) => address(answer.address))
  }
  const addresses = await resolve(host)
  if (
    addresses.some((ip) =>
      unconfirmedHosts.has(ip) || isTempCodeOrigin(`http://${isIP(ip) === 6 ? `[${ip}]` : ip}:${port}`, origins)
    )
  )
    return true
  if (publicOnly && addresses.some((ip) => !publicBrowserAddress(ip))) {
    throw new Error('a linked host’s browser addresses are unknown on this port')
  }
  const remoteAddresses = await Promise.all([...new Set(remoteHosts)].map(resolve))
  return remoteAddresses.some((ips) => ips.some((ip) => addresses.includes(ip)))
}

function publicBrowserAddress(ip: string): boolean {
  if (isPrivateAddress(ip)) return false
  if (isIP(ip) === 4) return !/^(198\.51\.100|203\.0\.113)\./.test(ip)
  // Require global IPv6 unicast. Exclude documentation, transition and protocol ranges.
  return /^[23][\da-f]{3}:/.test(ip) && !/^(2001:(?:0*db8:|0*:)|2002:|3fff:)/.test(ip)
}

/** Browser requests must name a known local endpoint. Never authorize an incoming Host by resolving it. */
export function isTempCodeBrowserHost(
  host: string,
  proto: 'http' | 'https',
  origins: TempCodeOrigins
): boolean {
  if (!/^(?:[a-z\d_.-]+|\[[a-f\d:.]+\])(?::\d+)?$/i.test(host)) return false
  // A tunnel name alone does not give its other ports an owner page.
  return isTempCodeOrigin(`${proto}://${host}`, { ...origins, tunnelHosts: undefined })
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
