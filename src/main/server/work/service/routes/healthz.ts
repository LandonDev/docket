import { BASE_HEADERS, sendText, type PublicRoute } from './route'

/**
 * `GET …/w/healthz`: 200 and this run's start mark, nothing else (docs/agents/work-service.md
 * "Health"). The mark is a random value made when the service started. Main reads it back
 * through a name before it trusts that name with guest links (`work.guests.setOrigin`: the
 * answer must be this very service's), and a monitor outside sees a restart as a new mark.
 */
export const healthzRoute: PublicRoute = {
  name: 'health',
  milestone: 31,
  match: /^\/w\/healthz$/,
  http(req, res, ctx) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'read only')
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(req.method === 'HEAD' ? undefined : ctx.mark)
  }
}
