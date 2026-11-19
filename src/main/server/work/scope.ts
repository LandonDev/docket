import { NotBuilt, notBuilt } from '@shared/work'
import type { ScopePart } from './ctx'

/**
 * A thread's Work scope and the two admissions the router asks for
 * (work/ctx.ts lists the parts). A stub: milestone 6 builds `workScopeOf`,
 * the rule that scope follows the parent, Work workspaces and Work Chats.
 *
 * Until then nothing here lets a Work thing be made: a create that asks for
 * Work is refused by name, and a create that does not ask passes as before.
 */
export const scopePart: ScopePart = () => ({
  scopeOf: notBuilt('ctx.scopeOf', 6),
  createWorkspace: notBuilt("workspace.create {kind: 'work'}", 6),
  admitSession(params) {
    if (params.scope === 'work') throw new NotBuilt("session.create {scope: 'work'}", 6)
    if (params.about) throw new NotBuilt('session.create {about}', 7)
  }
})
