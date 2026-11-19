import type { ClientRequest } from '@shared/contract'

/**
 * The code settings a Work project has none of (docs/agents/work.md "A Work
 * project's settings"): a branch, a start host, a review before merge, plan
 * settings, a build command, a completed-turn pass. Its sheet draws none of
 * them, and this refuses a client that sets one anyway, in words a screen
 * can show. A Work workspace's projects come from LifeOS, so a client's
 * `project.create` there is refused too; `work.project.open` makes its
 * mirror through the registry and never passes here.
 *
 * Decided by the row (`workspaces.kind`), never by the switch. Clearing an
 * override (null) passes: it leaves the project as the rule wants it.
 */
export interface WorkProjectFacts {
  /** Whether the project sits in a Work workspace; false for an unknown id. */
  workProject(projectId: string): boolean
  /** Whether the workspace is a Work workspace; false for an unknown id. */
  workWorkspace(workspaceId: string): boolean
}

const refusal = (what: string): string => `${what} is not for a Work project`

/** Why a Work project refuses this request, or null when it does not. */
export function workProjectRefusal(req: ClientRequest, facts: WorkProjectFacts): string | null {
  switch (req.method) {
    case 'project.create':
      return facts.workWorkspace(req.params.workspaceId) ? "A Work workspace's projects come from LifeOS: make the project there" : null
    case 'project.setBranch':
      return facts.workProject(req.params.projectId) ? refusal('A branch') : null
    case 'project.setStartOn':
      return req.params.startOn !== null && facts.workProject(req.params.projectId) ? refusal('A start host') : null
    case 'review.set':
      return req.params.settings !== null && !!req.params.projectId && facts.workProject(req.params.projectId) ? refusal('Review before merge') : null
    case 'plans.set':
      return req.params.settings !== null && !!req.params.projectId && facts.workProject(req.params.projectId) ? refusal('A plan setting') : null
    case 'build.set':
      return req.params.config !== null && !!req.params.projectId && facts.workProject(req.params.projectId) ? refusal('A build command') : null
    case 'turnpass.set':
      return req.params.pass !== null && !!req.params.projectId && facts.workProject(req.params.projectId) ? refusal('A completed-turn pass') : null
    case 'project.settings.set': {
      if (!facts.workProject(req.params.projectId)) return null
      // The bundle's name, archived mark, preamble and account pins are a Work project's own; the rest is code's.
      const { review, plans, build, turnPass, startOn } = req.params.bundle
      if (review !== null) return refusal('Review before merge')
      if (plans !== null) return refusal('A plan setting')
      if (build !== null) return refusal('A build command')
      if (turnPass !== null) return refusal('A completed-turn pass')
      if (startOn != null) return refusal('A start host')
      return null
    }
    default:
      return null
  }
}
