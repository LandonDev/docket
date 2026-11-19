/**
 * What main's full editor and the Work service's `/w/full` route share
 * (docs/agents/work-sheets.md, "The full editor"). Pure: the service imports
 * it, so it reaches no database, vault or Electron.
 *
 * An open is named by a token of 32 random bytes in the URL's path; the
 * route asks main what it opens over a Unix socket beside the service's
 * own, and main answers only for an open still live.
 */

/** A per-open token: 32 random bytes, hex (the docservice escapes `_` in the links it writes, which would miss the route). */
export const FULL_TOKEN = /^[0-9a-f]{64}$/

/** `/w/full/<token><rest>`: the token and what follows it. */
export const FULL_ROUTE = /^\/w\/full\/([0-9a-f]{64})(\/.*)?$/

/** Main's lookup socket, beside the service's internal one (both 0600 to this user). */
export const lookupSocketOf = (serviceSocket: string): string => `${serviceSocket}.full`

/** What main answers for a live open. */
export interface FullLookup {
  /** the docservice's Unix socket */
  socket: string
  /** the file's name, for the page's title */
  title: string
  /** the editor's config, signed for the docservice (`config.token`) */
  config: Record<string, unknown>
}

/**
 * The docservice paths an editor page uses, and no other: its static code,
 * fonts and dictionaries, the co-editing socket, a file's download, and the
 * uploads and saves an editor makes. Its admin, info, command, conversion
 * and builder endpoints are not reached through the route.
 */
export const EDITOR_PATHS = /^\/(?:web-apps|sdkjs|sdkjs-plugins|fonts|dictionaries|doc|cache\/files|downloadas|upload|savefile|plugins\.json|themes\.json)(?:\/|$|\?)/

/** The page the owner's browser opens: ONLYOFFICE's own api.js, given the signed config. */
export function editorPage(o: { token: string; nonce: string; title: string; config: Record<string, unknown> }): string {
  const base = `/w/full/${o.token}`
  // Nothing in the config may close the script element it sits in.
  const config = JSON.stringify(o.config).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(o.title)}</title>
<style>html,body{margin:0;height:100%}#editor{height:100vh}</style>
<script nonce="${o.nonce}" src="${base}/web-apps/apps/api/documents/api.js"></script>
</head><body><div id="editor"></div>
<script nonce="${o.nonce}">new DocsAPI.DocEditor('editor', ${config})</script>
</body></html>`
}

/** The page's policy: its own scripts by nonce (api.js styles what it draws inline), ONLYOFFICE's frames from this origin, never framed itself. */
export const editorPageCsp = (nonce: string): string =>
  `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
