/**
 * The box's public names. Both reach one tunnel and the same routes (scripts/box/ingress.yml):
 * `tempcode.landonhale.com`, the name every link made so far carries and which stays live for
 * good, and `docket.landonhale.com`, the app's new name. Every rule that accepts, allows,
 * fences or routes one of them takes the other the same way. The guest pages' own origin,
 * `share.landonhale.com`, is no alias: it stays apart (docs/agents/work-guests.md "The guest origin").
 */
export const PUBLIC_HOSTS = ['tempcode.landonhale.com', 'docket.landonhale.com'] as const

/** The names that answer as `host`: both public names for either of them, else the host alone. */
export function hostAliases(host: string): string[] {
  const bare = host.toLowerCase().replace(/\.$/, '')
  return (PUBLIC_HOSTS as readonly string[]).includes(bare) ? [...PUBLIC_HOSTS] : [host]
}

/** `https://tempcode.landonhale.com` → itself and `https://docket.landonhale.com`, scheme, port and path kept; any other URL stays alone. */
export function originAliases(origin: string): string[] {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return [origin]
  }
  const names = hostAliases(url.hostname)
  if (names.length === 1) return [origin]
  const own = new RegExp(url.hostname.replace(/\./g, '\\.'), 'i')
  return [origin, ...names.filter((name) => name !== url.hostname).map((name) => origin.replace(own, name))]
}
