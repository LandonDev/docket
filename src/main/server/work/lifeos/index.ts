import type { LifeosJwtAnswer, LifeosStatus } from '@shared/contract-work-lifeos'
import { handled, NOT_HANDLED, workspaceKindOf } from '@shared/work'
import type { WorkModule } from '../modules'
import { lifeosHostOf } from './ctx'
import { ensureKeysTable } from './keys'
import { ensureLinksTable } from './links'
import { LifeosUnavailable } from './session'
import { lifeosMentions } from './mentions'

/**
 * The lifeos pillar's server module (docs/agents/work-lifeos.md): its two
 * tables, the `work.lifeos.*` methods a screen calls, and the `work.lifeos`
 * push. The connection itself is the context's part (ctx.ts).
 */
export const lifeos: WorkModule = {
  id: 'lifeos',
  mentions: lifeosMentions,
  ensure(db) {
    ensureKeysTable(db)
    ensureLinksTable(db)
  },
  async handle(req, ctx, by) {
    if (!req.method.startsWith('work.lifeos.')) return NOT_HANDLED
    const host = lifeosHostOf(ctx)
    if (!host) throw new Error('work: lifeos did not start on this host')
    const withCode = by.caps.includes('admin')
    const status = (): LifeosStatus => host.status(withCode)
    switch (req.method) {
      case 'work.lifeos.status':
        return handled(status())
      case 'work.lifeos.pairStart':
        return handled(await host.session.pairStart(req.params?.name))
      case 'work.lifeos.pairCancel':
        host.session.pairCancel()
        return handled(status())
      case 'work.lifeos.setToken':
        await host.session.setToken(req.params.token.trim())
        return handled(status())
      case 'work.lifeos.signOut':
        await host.session.signOut()
        return handled(status())
      case 'work.lifeos.jwt': {
        const sector = req.params?.sector
        try {
          const { jwt, expiresAt } = await host.session.jwt(sector ? [sector] : undefined)
          return handled({ ok: true, jwt, expiresAt, url: host.url } satisfies LifeosJwtAnswer)
        } catch (err) {
          if (err instanceof LifeosUnavailable) return handled({ ok: false, state: err.state } satisfies LifeosJwtAnswer)
          throw err
        }
      }
      case 'work.lifeos.link': {
        const { workspaceId, sector } = req.params
        const workspace = host.workspaces().find((w) => w.id === workspaceId)
        if (!workspace) throw new Error(`unknown workspace: ${workspaceId}`)
        // A Work workspace's sector is its fence, set when it is made (workspace.create {kind: 'work'}).
        if (workspaceKindOf(workspace) === 'work') throw new Error("refused: a Work workspace's sector is set when it is made")
        // Its add-ons, and so its key, live on that host: the link is made there.
        const home = host.homeOf(workspaceId)
        if (home) throw new Error(`refused: this workspace's add-ons live on ${home}; link it there`)
        if (sector && host.session.connected() && !(await host.validSector(sector))) throw new Error(`LifeOS has no sector ${sector}`)
        if ((workspace.sector ?? null) !== sector) host.setSector(workspaceId, sector)
        await host.reconcile()
        return handled(status())
      }
    }
    return NOT_HANDLED
  },
  start(ctx) {
    const host = lifeosHostOf(ctx)
    if (!host) return () => {}
    let last = ''
    const off = host.onStatus(() => {
      // Never the pairing code: a read key sees every push. A screen with admin reads the code from status.
      const status = host.status(false)
      const json = JSON.stringify(status)
      if (json === last) return
      last = json
      ctx.push({ push: 'work.lifeos', status })
    })
    return off
  },
  sessionsRemoved(ids, ctx) {
    lifeosHostOf(ctx)?.links.dropSessions(ids)
  },
  workspaceRemoved(_id, ctx) {
    void lifeosHostOf(ctx)?.reconcile()
  }
}
