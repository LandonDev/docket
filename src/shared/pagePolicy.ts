/**
 * The renderer's page policy and LifeOS (docs/agents/work-mail.md, "Pictures").
 *
 * The policy is a meta tag in src/renderer/index.html, so whatever serves that
 * page writes into it: the packaged app's scheme handler (src/main/appScheme.ts),
 * the dev server (electron.vite.config.ts) and the remote UI
 * (src/main/server/remote/ui.ts). All three call `withLifeosConnect`, which
 * lets the page FETCH from the one LifeOS this host resolved and changes
 * nothing else: a mail's stored body, its files and its pictures are read as
 * bytes from LifeOS's file store. `img-src` is never widened: a picture
 * reaches a mail frame as a blob the reader made, so no transcript, page or
 * mail can load a picture from anywhere on the web.
 *
 * No zod and no Node here: the first paint may import it.
 */

/** The real LifeOS: the box's self-hosted Convex. */
export const LIFEOS_URL = 'https://lifeos.landonhale.com'
export const LIFEOS_MCP_URL = 'https://lifeos-mcp.landonhale.com/mcp'

/** Which LifeOS this process talks to. Another one only for an isolated instance: the installed app always talks to the owner's own. */
export function lifeosAddress(env: Record<string, string | undefined> = process.env): { url: string; mcpUrl: string } {
  const isolated = !!env.TEMP_CODE_USER_DATA
  return {
    url: (isolated && env.TEMP_CODE_LIFEOS_URL) || LIFEOS_URL,
    mcpUrl: (isolated && env.TEMP_CODE_LIFEOS_MCP_URL) || LIFEOS_MCP_URL
  }
}

const META = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/i

/** The Content-Security-Policy an index.html carries in its meta tag, or null. */
export function pagePolicyOf(html: string): string | null {
  return META.exec(html)?.[2]?.replace(/\s+/g, ' ').trim() ?? null
}

/** One directive's sources, by name: `sourcesOf(policy, 'img-src')`. Empty when the policy has no such directive. */
export function sourcesOf(policy: string, directive: string): string[] {
  const found = policy
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([name]) => name === directive)
  return found ? found.slice(1) : []
}

/**
 * The page with LifeOS's origin added to `connect-src`, and to nothing else.
 * Only an http(s) origin is ever written (never a path, a wildcard or a
 * scheme alone); an address that is not one leaves the page as it was. Safe
 * to run twice.
 */
export function withLifeosConnect(html: string, lifeosUrl: string): string {
  let origin: string
  try {
    const url = new URL(lifeosUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return html
    origin = url.origin
  } catch {
    return html
  }
  return html.replace(META, (_m, open: string, policy: string, close: string) => {
    if (sourcesOf(policy, 'connect-src').includes(origin)) return `${open}${policy}${close}`
    const rewritten = /(^|;)\s*connect-src\s/.test(policy)
      ? policy.replace(/((?:^|;)\s*connect-src)([^;]*)/, (_c, name: string, rest: string) => `${name}${rest} ${origin}`)
      : `${policy}; connect-src 'self' ${origin}`
    return `${open}${rewritten}${close}`
  })
}
