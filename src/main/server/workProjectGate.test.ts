import { describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import type { ProjectSettingsBundle } from '@shared/projectLinks'
import { workProjectRefusal, type WorkProjectFacts } from './workProjectGate'

/** `work1` is a project of the Work workspace `ws_work`; `code1` of the code workspace `ws_code`. */
const facts: WorkProjectFacts = {
  workProject: (id) => id === 'work1',
  workWorkspace: (id) => id === 'ws_work'
}
const ask = (method: string, params: unknown): string | null => workProjectRefusal({ id: '1', method, params } as ClientRequest, facts)

const bundle = (over: Partial<ProjectSettingsBundle> = {}): ProjectSettingsBundle => ({
  name: 'Spring LAN',
  archived: false,
  preamble: 'Write to the director as Landon.',
  preambleEnabled: true,
  accountPins: { claude: 'work@example.com' },
  review: null,
  plans: null,
  build: null,
  turnPass: null,
  startOn: null,
  updatedAt: 1,
  ...over
})
const review = { enabled: true } as unknown as NonNullable<ProjectSettingsBundle['review']>
const plans = { autoStart: true } as unknown as NonNullable<ProjectSettingsBundle['plans']>
const build = { command: 'bun run build', outputs: 'dist/**' }
const pass = { verify: true, build: false, commit: 'off' } as unknown as NonNullable<ProjectSettingsBundle['turnPass']>

describe('the code settings a Work project refuses', () => {
  it.each([
    ['project.setBranch', { projectId: 'work1', branch: 'feature' }, 'A branch is not for a Work project'],
    ['project.setStartOn', { projectId: 'work1', startOn: 'mac' }, 'A start host is not for a Work project'],
    ['review.set', { projectId: 'work1', settings: review }, 'Review before merge is not for a Work project'],
    ['plans.set', { projectId: 'work1', settings: plans }, 'A plan setting is not for a Work project'],
    ['build.set', { workspaceId: 'ws_work', projectId: 'work1', config: build }, 'A build command is not for a Work project'],
    ['turnpass.set', { workspaceId: 'ws_work', projectId: 'work1', pass }, 'A completed-turn pass is not for a Work project']
  ])('%s', (method, params, words) => {
    expect(ask(method, params)).toBe(words)
    // The same call on a code project passes.
    expect(ask(method, { ...params, projectId: 'code1', workspaceId: 'ws_code' })).toBeNull()
  })

  it('refuses a settings bundle that carries a review, plans, a build, a turn pass or a start host', () => {
    expect(ask('project.settings.set', { projectId: 'work1', bundle: bundle({ review }) })).toBe('Review before merge is not for a Work project')
    expect(ask('project.settings.set', { projectId: 'work1', bundle: bundle({ plans }) })).toBe('A plan setting is not for a Work project')
    expect(ask('project.settings.set', { projectId: 'work1', bundle: bundle({ build }) })).toBe('A build command is not for a Work project')
    expect(ask('project.settings.set', { projectId: 'work1', bundle: bundle({ turnPass: pass }) })).toBe('A completed-turn pass is not for a Work project')
    expect(ask('project.settings.set', { projectId: 'work1', bundle: bundle({ startOn: 'mac' }) })).toBe('A start host is not for a Work project')
    expect(ask('project.settings.set', { projectId: 'code1', bundle: bundle({ review, plans, build, turnPass: pass }) })).toBeNull()
  })

  it("passes a bundle that holds only a Work project's own: its name, rules and account pins", () => {
    expect(ask('project.settings.set', { projectId: 'work1', bundle: bundle() })).toBeNull()
    // A host from before `startOn` leaves the key out.
    const { startOn: _startOn, ...older } = bundle()
    expect(ask('project.settings.set', { projectId: 'work1', bundle: older })).toBeNull()
  })

  it("refuses a client's project.create in a Work workspace, and passes one in a code workspace", () => {
    expect(ask('project.create', { workspaceId: 'ws_work', name: 'Side', mode: 'local' })).toBe("A Work workspace's projects come from LifeOS: make the project there")
    expect(ask('project.create', { workspaceId: 'ws_code', name: 'Side', mode: 'local' })).toBeNull()
  })

  it('lets an override be cleared, and the workspace-wide defaults be set', () => {
    expect(ask('project.setStartOn', { projectId: 'work1', startOn: null })).toBeNull()
    expect(ask('review.set', { projectId: 'work1', settings: null })).toBeNull()
    expect(ask('plans.set', { projectId: 'work1', settings: null })).toBeNull()
    expect(ask('build.set', { workspaceId: 'ws_work', projectId: 'work1', config: null })).toBeNull()
    expect(ask('turnpass.set', { workspaceId: 'ws_work', projectId: 'work1', pass: null })).toBeNull()
    // No project named: the global or workspace set, which is not a Work project's.
    expect(ask('review.set', { projectId: null, settings: review })).toBeNull()
    expect(ask('plans.set', { projectId: null, settings: plans })).toBeNull()
  })

  it("leaves a Work project's own settings and every other method alone", () => {
    expect(ask('project.rename', { projectId: 'work1', name: 'Fall LAN' })).toBeNull()
    expect(ask('project.setAccounts', { projectId: 'work1', pins: {} })).toBeNull()
    expect(ask('project.setPreamble', { projectId: 'work1', preamble: 'x', enabled: true })).toBeNull()
    expect(ask('work.project.open', { workspaceId: 'ws_work', lifeosProjectId: 'lp_1' })).toBeNull()
  })
})
