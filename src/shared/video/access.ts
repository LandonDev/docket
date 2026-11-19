import { allows, type Principal } from '../capabilities'

/**
 * Who may watch a computer an agent drives, as video or as the JPEG preview
 * of the box's browser. A remote caller needs `approve` on a `client` key (an
 * `mcp` key and a read-only key never get a picture). The local socket has no
 * key: on a desktop it is the person's own app; on a host with no desktop
 * (the box) any process of the service's user reaches it, the app bridge and a
 * code thread's shell among them, so there it is refused.
 */
export function mayWatch(principal: Principal, host: { desktop: boolean }): boolean {
  if (principal.kind === 'local') return host.desktop
  return principal.audience === 'client' && allows(principal.caps, 'approve')
}
