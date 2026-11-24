import { isIP } from 'node:net'
import { hostname, networkInterfaces } from 'node:os'
import { kindOf, listEnvironments, type EnvironmentsStore } from './environments'
import { readRemoteSettings } from './handlers'

export const TEMPCODE_ORIGIN_REFUSAL = 'refused: TempCode pages are off limits to computer tools.'

export interface TempCodeOrigins {
  listenerPorts: readonly number[]
  lanAddresses: readonly string[]
  remoteRoutes: readonly string[]
  tunnelHosts?: readonly string[]
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
  const { host, port } = target
  if (origins.tunnelHosts?.some((name) => address(name) === host)) return true
  const loopback =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    host === '::1'
  if (
    origins.listenerPorts.includes(port) &&
    (loopback ||
      host === '0.0.0.0' ||
      host === '::' ||
      origins.lanAddresses.some((ip) => address(ip) === host))
  )
    return true
  return origins.remoteRoutes.some((route) => {
    const configured = endpoint(route)
    return configured?.host === host && configured.port === port
  })
}

export function readTempCodeOrigins(
  store: EnvironmentsStore,
  listenerPort: number | null,
  boundPort?: number
): TempCodeOrigins {
  const settings = readRemoteSettings(store)
  const publicRoutes = [settings.publicOrigin, settings.learnedOrigin ?? '']
  const tunnelHosts = publicRoutes.flatMap((route) => {
    const host = endpoint(route)?.host
    return host && host.includes('.') && !isIP(host) && kindOf(host) === 'tunnel' ? [host] : []
  })
  return {
    listenerPorts: [
      settings.port,
      ...(listenerPort ? [listenerPort] : []),
      ...(boundPort ? [boundPort] : [])
    ],
    lanAddresses: [
      hostname(),
      ...Object.values(networkInterfaces()).flatMap((rows) => rows?.map((row) => row.address) ?? [])
    ],
    tunnelHosts,
    remoteRoutes: [
      ...publicRoutes,
      ...listEnvironments(store).flatMap((env) => env.routes.map((route) => route.url))
    ]
  }
}
