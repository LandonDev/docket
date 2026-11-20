import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { METHOD_CAPABILITY, requiredCapability } from './capabilities'
import { ClientRequestSchema, type ServerPush } from './contract'
import { RELAY_METHODS, RELAY_NOT_CARRIED } from './contract-relay'
import { WORK_CAPS, WORK_CORE_CAPS, WORK_NOT_CARRIED, WORK_PILLAR_CONTRACTS, WORK_RELAY, WorkRequestSchemas, type WorkPush } from './contract-work'
import { PILLAR_IDS } from './work/ids'
import { isWorkMethod, pillarMethodProblem, pillarOfMethod } from './work/wire'

/** The one mount of Work's contract: the core's four methods, then whatever each pillar's contract file declares, held to Work's naming and capability rules. */

const methodOf = (schema: z.ZodType): string => (schema as unknown as { shape: { method: { value: string } } }).shape.method.value
/** A request's top-level param names. */
const paramsOf = (schema: z.ZodType): string[] => {
  let params = (schema as unknown as { shape: { params?: z.ZodType } }).shape.params as unknown as { shape?: Record<string, unknown>; _def?: { innerType?: z.ZodType } } | undefined
  while (params && !params.shape && params._def?.innerType) params = params._def.innerType as never
  return Object.keys(params?.shape ?? {})
}
const all = (ClientRequestSchema.options as unknown as z.ZodType[]).map(methodOf)

describe("Work's contract", () => {
  it('mounts every pillar once, in order', () => {
    expect(Object.keys(WORK_PILLAR_CONTRACTS)).toEqual([...PILLAR_IDS])
  })
  it("adds the core's ten methods and each pillar's own, and nothing else, to the contract", () => {
    const pillarMethods = PILLAR_IDS.flatMap((id) => WORK_PILLAR_CONTRACTS[id].requests.map(methodOf))
    const core = ['app.workCall', 'app.workCancel', 'app.workTools', 'work.get', 'work.health', 'work.lapses', 'work.project.open', 'work.set', 'work.workspace.get', 'work.workspace.set']
    expect(WorkRequestSchemas.map(methodOf).sort()).toEqual([...core, ...pillarMethods].sort())
    // every Work method the contract speaks came through this mount, and no method is declared twice
    expect(all.filter(isWorkMethod).sort()).toEqual([...core, ...pillarMethods].sort())
    expect(new Set(all).size).toBe(all.length)
  })
  it('the switch, a workspace\'s settings and Connections are read by any key, set only by an admin, a project opened by operate; the bridge methods never leave the loopback', () => {
    expect(WORK_CORE_CAPS).toEqual({
      'work.get': 'read',
      'work.set': 'admin',
      'work.workspace.get': 'read',
      'work.workspace.set': 'admin',
      'work.project.open': 'operate',
      'work.health': 'read',
      'work.lapses': 'read',
      'app.workTools': 'local',
      'app.workCall': 'local',
      'app.workCancel': 'local'
    })
    expect(requiredCapability({ method: 'work.get' })).toBe('read')
    expect(requiredCapability({ method: 'work.set' })).toBe('admin')
    for (const method of ['app.workTools', 'app.workCall', 'app.workCancel'] as const) {
      expect(requiredCapability({ method })).toBe('local')
      // each names the thread and carries its token
      expect(paramsOf(WorkRequestSchemas.find((s) => methodOf(s) === method)!)).toEqual(expect.arrayContaining(['sessionId', 'token']))
    }
  })
  it("holds every pillar's methods to its own name and gives each one capability row", () => {
    const problems: string[] = []
    for (const id of PILLAR_IDS) {
      const { requests, caps } = WORK_PILLAR_CONTRACTS[id]
      const methods = requests.map(methodOf)
      for (const request of requests) {
        const method = methodOf(request)
        const problem = pillarMethodProblem(id, method, caps[method], paramsOf(request))
        if (problem) problems.push(problem)
        if (METHOD_CAPABILITY[method as keyof typeof METHOD_CAPABILITY] !== caps[method]) problems.push(`${method}: its row is not the one the contract mounts`)
      }
      for (const method of Object.keys(caps)) if (!methods.includes(method)) problems.push(`${method}: a capability row with no method`)
    }
    expect(problems).toEqual([])
    expect(Object.keys(WORK_CAPS).sort()).toEqual(WorkRequestSchemas.map(methodOf).sort())
  })
  it("carries a Work method a key can hold to another host unless its pillar's relay row says otherwise, and never a local one", () => {
    const rows: Record<string, 'screen' | 'never'> = Object.assign({}, ...PILLAR_IDS.map((id) => WORK_PILLAR_CONTRACTS[id].relay))
    const remote = Object.entries(WORK_CAPS as Record<string, string>).filter(([, cap]) => cap !== 'local').map(([m]) => m)
    const problems: string[] = []
    for (const id of PILLAR_IDS) {
      const { caps, relay } = WORK_PILLAR_CONTRACTS[id]
      for (const method of Object.keys(relay)) if (caps[method] === undefined || caps[method] === 'local') problems.push(`${method}: a relay row names one of the pillar's own methods that a key can hold`)
    }
    expect(problems).toEqual([])
    for (const method of remote) {
      const need = RELAY_METHODS[method as keyof typeof RELAY_METHODS]
      if (rows[method] === 'never') {
        expect(need, method).toBeUndefined()
        expect(RELAY_NOT_CARRIED, method).toContain(method)
      } else expect(need, method).toBe(rows[method] === 'screen' ? 'screen' : 'link')
    }
    expect(Object.keys(RELAY_METHODS).filter(isWorkMethod).sort()).toEqual(remote.filter((m) => rows[m] !== 'never').sort())
    expect([...WORK_NOT_CARRIED].sort()).toEqual(remote.filter((m) => rows[m] === 'never').sort())
    // the switch is written to each host through the box
    expect(WORK_RELAY).toMatchObject({ 'work.get': 'link', 'work.set': 'link' })
    for (const method of ['app.workTools', 'app.workCall', 'app.workCancel']) expect(RELAY_METHODS[method as keyof typeof RELAY_METHODS]).toBeUndefined()
  })
  it('parses the core requests and refuses a malformed one', () => {
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'work.get' }).success).toBe(true)
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'work.set', params: { enabled: true } }).success).toBe(true)
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'work.set', params: {} }).success).toBe(false)
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'work.workspace.set', params: { workspaceId: 'w', patch: { mayUseDesktop: ['mac'], model: null } } }).success).toBe(true)
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'work.workspace.set', params: { workspaceId: 'w' } }).success).toBe(false)
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'work.project.open', params: { workspaceId: 'w', lifeosProjectId: '', name: 'x' } }).success).toBe(false)
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'app.workCall', params: { sessionId: 's', token: 't', call: 3, tool: 'x', args: {} } }).success).toBe(true)
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'app.workTools', params: { sessionId: 's' } }).success).toBe(false)
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'app.workCancel', params: { sessionId: 's', token: 't', call: 'c1' } }).success).toBe(true)
    // a pillar method no contract file declares is not a request at all
    expect(pillarOfMethod('work.mail.list')).toBe('mail')
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'work.mail.list', params: {} }).success).toBe(all.includes('work.mail.list'))
  })
  it('a create may ask for Work and say what it is about; a workspace may be made as Work', () => {
    const create = { id: '1', method: 'session.create', params: { provider: 'claude', model: 'm', scope: 'work', about: { kind: 'task', label: 'T', ref: { at: 'lifeos', table: 'tasks', id: 'k' } } } }
    expect(ClientRequestSchema.safeParse(create).success).toBe(true)
    expect(ClientRequestSchema.safeParse({ ...create, params: { ...create.params, scope: 'play' } }).success).toBe(false)
    // the run that started a thread is the host's to say, never a client's
    const parsed = ClientRequestSchema.parse({ ...create, params: { ...create.params, routineRunId: 'r1' } })
    expect(parsed.method === 'session.create' && 'routineRunId' in parsed.params).toBe(false)
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'workspace.create', params: { kind: 'work', name: 'Purdue', sector: 'purdue' } }).success).toBe(true)
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'workspace.create', params: { path: '/w' } }).success).toBe(true)
  })
  it("carries the switch's push in the server's union", () => {
    const push: WorkPush = { push: 'work', settings: { enabled: true } }
    const frame: ServerPush = push
    expect(frame.push).toBe('work')
  })
})
