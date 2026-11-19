import { handled, NOT_HANDLED, type TriggerSource } from '@shared/work'
import { registerMediaSource } from '../media/sources'
import type { WorkModule } from '../modules'
import { dropHooks, frameioTrigger, rearmHooks, startHooks } from './hooks'
import { ensureFrameioTables, frameioOf, removeSessionItems, setSetting, statusOf, stopFrameio } from './live'
import { frameioMedia, openFile } from './media'
import { frameioPostKind, onPostDecided } from './post'
import { browse, frameioTools } from './tools'

/**
 * The frameio pillar's server module (docs/agents/work-frameio.md): the
 * sign-in, browsing, a file in the media canvas through the media pillar's
 * source adapter, the held `frameio.post`, and webhooks as a routine's
 * trigger. While Work is on, the adapter is registered and the webhook
 * receiver listens.
 */
export const frameio: WorkModule = {
  id: 'frameio',
  ensure: ensureFrameioTables,
  acts: [frameioPostKind as never],
  triggers: [frameioTrigger as unknown as TriggerSource],
  start(ctx) {
    const offMedia = registerMediaSource(frameioMedia)
    const offHooks = startHooks(ctx)
    const offDecided = ctx.held.onDecided((item) => onPostDecided(ctx, item))
    return () => {
      offDecided()
      offHooks()
      offMedia()
      stopFrameio(ctx)
    }
  },
  async handle(req, ctx) {
    const live = frameioOf(ctx)
    switch (req.method) {
      case 'work.frameio.status':
        return handled(statusOf(ctx))
      case 'work.frameio.signIn':
        return handled({ url: live.auth.start(req.params.clientId, req.params.redirectUri) })
      case 'work.frameio.finish':
        await live.auth.finish(req.params.url)
        rearmHooks(ctx)
        return handled(statusOf(ctx))
      case 'work.frameio.signOut':
        await dropHooks(ctx).catch(() => undefined)
        live.auth.signOut()
        return handled(statusOf(ctx))
      case 'work.frameio.setPublicUrl': {
        const url = req.params.url
        if (url && !url.startsWith('https://')) throw new Error('Frame.io sends webhooks only to an https address')
        // Webhooks made for the old address go; every armed routine makes its own again for the new one.
        await dropHooks(ctx).catch(() => undefined)
        setSetting(ctx.db, 'publicUrl', url ? url.replace(/\/$/, '') : null)
        rearmHooks(ctx)
        const status = statusOf(ctx)
        ctx.push({ push: 'work.frameio', status }, { need: 'read' })
        return handled(status)
      }
      case 'work.frameio.browse':
        return handled({ entries: await browse(ctx, req.params) })
      case 'work.frameio.open':
        return handled(await openFile(ctx, req.params.sessionId, req.params.account, req.params.fileId))
    }
    return NOT_HANDLED
  },
  tools: () => frameioTools,
  sessionsRemoved(ids, ctx) {
    removeSessionItems(ctx.db, ids)
  },
  workspaceRemoved() {}
}
