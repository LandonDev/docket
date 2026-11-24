/**
 * Which browser pages may open a WebSocket on the local server (server/index.ts, the upgrade). The server trusts
 * whoever reaches 127.0.0.1 as him, so a page of any site in a browser on this machine, or a live Office guest
 * (officeLive.ts), must not be one of them:
 * - no Origin at all: a node or bun client (the bridge, the proofs, the CLI);
 * - the app's own pages (`tempcode-app://renderer`);
 * - the dev renderer's own address, while one is set.
 * Anything else, `null` (a sandboxed frame, a file page) among them, is refused.
 */
export const APP_ORIGIN = 'tempcode-app://renderer'

export function originAllowed(origin: string | string[] | undefined, devRenderer: string | undefined = process.env['ELECTRON_RENDERER_URL']): boolean {
  if (origin === undefined) return true
  if (Array.isArray(origin)) return false
  if (origin === APP_ORIGIN) return true
  if (!devRenderer) return false
  try {
    return new URL(devRenderer).origin === origin
  } catch {
    return false
  }
}
