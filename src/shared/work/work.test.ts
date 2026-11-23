import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as work from './index'
import {
  ACT_KINDS,
  ACT_PILLAR,
  ActKindSchema,
  CANVAS_KINDS,
  CANVAS_PILLAR,
  CanvasItemSchema,
  CanvasSourceSchema,
  ContextChipSchema,
  DEFAULT_WORK_SETTINGS,
  HeldItemSchema,
  HeldRefSchema,
  LifeosOriginSchema,
  NotBuilt,
  PILLAR_IDS,
  PILLAR_MILESTONE,
  PrincipalSchema,
  TriggerSchema,
  WORK_HOME,
  WorkToolResultSchema,
  agentPrincipal,
  canvasSourcePath,
  handled,
  notBuilt,
  parseWorkSettings,
  parseWorkspaceWorkSettings,
  pillarMethodProblem,
  pillarOfMethod,
  sessionScopeOf,
  workToolId,
  workToolNameProblem,
  workspaceKindOf,
  type ActKindDefOf,
  type CanvasItem,
  type CanvasSource,
  type ContextChip,
  type Handled,
  type HeldItem,
  type HeldRef,
  type HostId,
  type LifeosOrigin,
  type PillarId,
  type Principal,
  type SectorKey,
  type Trigger,
  type TriggerSource,
  type UndoSpec,
  type Verdict,
  type WorkScope,
  type WorkToolOf,
  type WorkspaceWorkSettings
} from './index'

/** Every shared type of the Work architecture's section 7.3 exists, is exported from one place, and has the shape the pillars build to. */

describe('the names', () => {
  it('lists the 32 pillars once, in mount order, each with the milestone that builds it', () => {
    expect([...PILLAR_IDS]).toEqual([
      'outbox', 'canvas', 'lifeos', 'routines', 'rules', 'mail', 'tasks', 'agenda', 'docs', 'history', 'formats', 'sheets',
      'office', 'google', 'guests', 'pdf', 'slides', 'media', 'frameio', 'meetings', 'forms', 'dashboards', 'browser', 'projects', 'winvm', 'capture', 'files', 'prep', 'money', 'search',
      'review', 'clashes'
    ])
    expect(new Set(PILLAR_IDS).size).toBe(PILLAR_IDS.length)
    expect(Object.keys(PILLAR_MILESTONE).sort()).toEqual([...PILLAR_IDS].sort())
    for (const n of Object.values(PILLAR_MILESTONE)) expect(n).toBeGreaterThan(5)
  })
  it('maps the eleven canvas kinds to their pillars once', () => {
    expect([...CANVAS_KINDS]).toEqual(['mail', 'document', 'sheet', 'pdf', 'slides', 'media', 'browser', 'history', 'meeting', 'form', 'dashboard'])
    expect(CANVAS_PILLAR).toEqual({
      mail: 'mail', document: 'docs', sheet: 'sheets', pdf: 'pdf', slides: 'slides', media: 'media',
      browser: 'browser', history: 'history', meeting: 'meetings', form: 'forms', dashboard: 'dashboards'
    })
  })
  it('lists the twelve act kinds, each with the pillar that shows it', () => {
    expect([...ACT_KINDS]).toEqual([
      'mail.send', 'calendar.op', 'teams.post', 'office.mail.send', 'office.calendar.op', 'share.guestLink',
      'share.google', 'form.publish', 'frameio.post', 'portal.submit', 'computer.act', 'addon.call'
    ])
    expect(Object.keys(ACT_PILLAR).sort()).toEqual([...ACT_KINDS].sort())
    for (const pillar of Object.values(ACT_PILLAR)) expect(PILLAR_IDS).toContain(pillar)
    expect(ActKindSchema.safeParse('mail.send').success).toBe(true)
  })
  it('exports every runtime name from the one barrel', () => {
    for (const name of [
      'PILLAR_IDS', 'PILLAR_MILESTONE', 'CANVAS_KINDS', 'CANVAS_PILLAR', 'ACT_KINDS', 'ACT_PILLAR', 'HELD_STATES', 'VERDICTS', 'WORK_HOME',
      'WORK_SETTING_KEY', 'WORK_TOOL_SERVER', 'CanvasSourceSchema', 'CanvasItemSchema', 'ContextChipSchema', 'HeldRefSchema', 'HeldItemSchema',
      'LifeosOriginSchema', 'PrincipalSchema', 'TriggerSchema', 'WorkspaceWorkSettingsSchema', 'WorkSettingsSchema', 'WorkspaceKindSchema',
      'SessionScopeSchema', 'NotBuilt', 'notBuilt', 'request', 'pillarOfMethod'
    ])
      expect(work, name).toHaveProperty(name)
    expect(WORK_HOME).toBe('~work')
  })
})

describe('the types', () => {
  it('have the shapes the pillars build to', () => {
    const host: HostId = 'env_box'
    const sector: SectorKey = 'purdue'
    const pillar: PillarId = 'mail'
    const principals: Principal[] = ['owner', agentPrincipal(host, 't1'), 'guest:l1', 'lifeos:desktop', 'external:Dana Lee']
    for (const p of principals) expect(PrincipalSchema.safeParse(p).success).toBe(true)
    expect(PrincipalSchema.safeParse('someone').success).toBe(false)

    const origin: LifeosOrigin = { app: 'tempcode', threadId: 't1', host, workspaceId: 'w1', routineRunId: 'r1' }
    expect(LifeosOriginSchema.parse(origin)).toEqual(origin)

    const sources: CanvasSource[] = [
      { at: 'lifeos', table: 'docs', id: 'd1' },
      { at: 'file', host, path: '/w/a.xlsx' },
      { at: 'google', account: 'a@b.c', fileId: 'f', mime: 'application/vnd.google-apps.document' },
      { at: 'microsoft', host, app: 'excel', name: 'Budget', ref: { kind: 'path', path: '/w/b.xlsx' } },
      { at: 'microsoft', host, app: 'word', name: 'Memo', ref: { kind: 'url', url: 'https://x.sharepoint.com/m.docx' } },
      { at: 'frameio', account: 'a', fileId: 'f' },
      { at: 'browser', host, sessionId: 's' },
      { at: 'thread' }
    ]
    for (const s of sources) expect(CanvasSourceSchema.parse(s)).toEqual(s)
    // a URL source is a web address and nothing else: a file: URL would be a path the fence never read
    for (const url of ['file:///Users/me/.ssh/id_rsa', 'javascript:alert(1)', '/etc/hosts', ''])
      expect(CanvasSourceSchema.safeParse({ at: 'microsoft', host, app: 'word', name: 'M', ref: { kind: 'url', url } }).success, url).toBe(false)
    expect(sources.map(canvasSourcePath)).toEqual([null, '/w/a.xlsx', null, '/w/b.xlsx', null, null, null, null])

    const chip: ContextChip = { kind: 'task', label: 'Reply to Dana', ref: { at: 'lifeos', table: 'tasks', id: 'k1' } }
    const selection: ContextChip = { kind: 'selection', label: 'B2:C4', ref: sources[1], quote: '1,200' }
    expect(ContextChipSchema.parse(chip)).toEqual(chip)
    expect(ContextChipSchema.parse(selection)).toEqual(selection)

    const item: CanvasItem = { id: 'i1', sessionId: 't1', workspaceId: null, kind: 'sheet', title: 'Budget', source: sources[1], state: 'open', position: 0, rev: 0, createdAt: 1, updatedAt: 1 }
    expect(CanvasItemSchema.parse(item)).toEqual(item)

    const refs: HeldRef[] = [{ at: 'host', id: 'h1' }, { at: 'lifeos', table: 'outbox', id: 'o1' }]
    for (const r of refs) expect(HeldRefSchema.parse(r)).toEqual(r)
    const held: HeldItem = {
      ref: refs[1], kind: 'mail.send', workspaceId: 'w1', sessionId: 't1', sector, summary: 'Send to Dana Lee: Re: budget', verb: 'Send',
      account: 'me@purdue.edu', state: 'held', payload: { to: ['dana@x.y'] }, createdAt: 1, decidedBy: null, decidedAt: null
    }
    expect(HeldItemSchema.parse(held)).toEqual(held)

    const triggers: Trigger[] = [
      { on: 'schedule', rrule: 'FREQ=DAILY', tz: 'America/Indiana/Indianapolis' },
      { on: 'lifeos', kinds: ['mail.received'], filter: { from: 'dana@x.y' } },
      { on: 'read', addon: 'ad_1', tool: 'list', args: {}, fire: 'changed', everySec: 300 },
      { on: 'file', source: sources[1], by: 'someone-else' }
    ]
    for (const t of triggers) expect(TriggerSchema.parse(t)).toEqual(t)
    const source: TriggerSource<Extract<Trigger, { on: 'schedule' }>> = { on: 'schedule', words: (t) => t.rrule, arm: () => () => {} }
    expect(source.words(triggers[0] as Extract<Trigger, { on: 'schedule' }>)).toBe('FREQ=DAILY')

    const verdicts: Verdict[] = ['run', 'hold', 'refuse']
    expect(verdicts).toEqual([...work.VERDICTS])
    const answers: Handled[] = [{ handled: false }, handled(undefined)]
    expect(answers[1]).toEqual({ handled: true, result: null })

    const scope: WorkScope = { sessionId: 't1', workspaceId: 'w1', sector, host, away: false, routineRunId: null, shared: () => false }
    const settings: WorkspaceWorkSettings = { mayUseDesktop: [host], voice: true, model: 'claude-fable-5-1' }
    const undo: UndoSpec = { pillar, verb: 'remove', args: { id: 'k1' } }
    const tool: WorkToolOf<{ scope: WorkScope }> = { name: 'mail_search', description: 'Search mail', input: z.object({ q: z.string() }), readOnly: true, run: async (_a, c) => ({ content: [{ type: 'text', text: c.scope.sessionId }] }) }
    const act: ActKindDefOf<{ to: string }, { domain: string }, { item: HeldItem }> = {
      kind: 'mail.send', store: 'lifeos', payload: z.object({ to: z.string() }), matcher: z.object({ domain: z.string() }),
      words: (p) => ({ summary: `Send to ${p.to}`, verb: 'Send' }), matches: (m, p) => p.to.endsWith(m.domain),
      execute: async (p, c) => ({ summary: `Sent to ${p.to} (${c.item.kind})` }), wayBack: () => null
    }
    // a pillar's typed definition sits in the list a module registers
    const acts: ActKindDefOf<unknown, unknown, { item: HeldItem }>[] = [act]
    expect(acts[0].words({ to: 'dana@x.y' })).toEqual({ summary: 'Send to dana@x.y', verb: 'Send' })
    expect([scope.workspaceId, settings.voice, undo.pillar, tool.readOnly]).toEqual(['w1', true, 'mail', true])
  })
  it('reads a row from before Work as code, and missing or broken settings as the defaults', () => {
    expect(workspaceKindOf({})).toBe('code')
    expect(workspaceKindOf({ kind: 'work' })).toBe('work')
    expect(sessionScopeOf({})).toBe('code')
    expect(sessionScopeOf({ scope: 'work' })).toBe('work')
    expect(parseWorkSettings(null)).toEqual({ enabled: false })
    expect(parseWorkSettings('{broken')).toEqual(DEFAULT_WORK_SETTINGS)
    expect(parseWorkSettings('{"enabled":true}')).toEqual({ enabled: true })
    expect(parseWorkspaceWorkSettings(null)).toEqual({ mayUseDesktop: [], voice: false })
    // each default is the caller's own: a list one caller changes is not the next caller's default
    const mine = parseWorkspaceWorkSettings(null)
    mine.mayUseDesktop.push('env_mac')
    const broken = parseWorkspaceWorkSettings('{broken')
    broken.mayUseDesktop.push('env_win')
    expect(parseWorkspaceWorkSettings(null)).toEqual({ mayUseDesktop: [], voice: false })
    expect(parseWorkspaceWorkSettings('{broken')).toEqual({ mayUseDesktop: [], voice: false })
    expect(work.DEFAULT_WORKSPACE_WORK_SETTINGS).toEqual({ mayUseDesktop: [], voice: false })
    expect(() => work.DEFAULT_WORKSPACE_WORK_SETTINGS.mayUseDesktop.push('env_x')).toThrow()
    expect(parseWorkspaceWorkSettings('{"mayUseDesktop":["env_mac"],"voice":true,"model":"m"}')).toEqual({ mayUseDesktop: ['env_mac'], voice: true, model: 'm' })
  })
})

describe('a fault in one line', () => {
  it("says the error's own word and, when it only wraps another, that one's too", () => {
    expect(work.errorText(new Error('boom'))).toBe('boom')
    expect(work.errorText('plain')).toBe('plain')
    expect(work.errorText(new Error('could not mock', { cause: new Error('libx.so missing') }))).toBe('could not mock: libx.so missing')
    expect(work.errorText(new Error('libx.so missing, again', { cause: new Error('libx.so missing') }))).toBe('libx.so missing, again')
  })
})

describe('not built', () => {
  it('a stub throws by name, with the milestone that builds it', () => {
    const stub = notBuilt('ctx.canvas.open', 9)
    expect(() => stub('s', 'pdf')).toThrow(NotBuilt)
    expect(() => stub()).toThrow('not built: ctx.canvas.open (milestone 9)')
    const err = new NotBuilt('work.mail.list', 23)
    expect([err.code, err.what, err.milestone]).toEqual(['not-built', 'work.mail.list', 23])
  })
})

describe('tool names', () => {
  it('are lower snake case and fit Claude once wrapped', () => {
    expect(workToolId('mail_search')).toBe('mcp__work__mail_search')
    expect(workToolNameProblem('mail_search')).toBeNull()
    expect(workToolNameProblem('MailSearch')).toContain('lower snake case')
    expect(workToolNameProblem('mail-search')).toContain('lower snake case')
    expect(workToolNameProblem('a'.repeat(53))).toBeNull()
    expect(workToolNameProblem('a'.repeat(54))).toContain('over 64 characters')
    expect(WorkToolResultSchema.safeParse({ content: [{ type: 'text', text: 'ok' }], isError: true }).success).toBe(true)
  })
})

describe('method names', () => {
  it('tell a pillar method from the core and from every other method', () => {
    expect(pillarOfMethod('work.mail.list')).toBe('mail')
    expect(pillarOfMethod('work.outbox.send')).toBe('outbox')
    expect(pillarOfMethod('work.lifeos.pair.start')).toBe('lifeos')
    expect(pillarOfMethod('app.workMailSearch')).toBe('mail')
    expect(pillarOfMethod('app.workFormsPublish')).toBe('forms')
    expect(pillarOfMethod('app.workFormatsConvert')).toBe('formats')
    for (const core of ['work.get', 'work.set', 'app.workTools', 'app.workCall', 'app.workCancel']) expect(pillarOfMethod(core)).toBeNull()
    for (const other of ['workspace.create', 'work.unknown.list', 'app.addonCall', 'session.create']) expect(pillarOfMethod(other)).toBeNull()
  })
  it("hold a pillar's method to its own name, and a bridge method to the loopback and the thread's token", () => {
    expect(pillarMethodProblem('mail', 'work.mail.list', 'read', ['workspaceId'])).toBeNull()
    // a method only this machine's own window may call (a sign-in that opens a browser here) is a work.* method that is local
    expect(pillarMethodProblem('google', 'work.google.signIn', 'local', ['account'])).toBeNull()
    expect(pillarMethodProblem('mail', 'app.workMailMark', 'local', ['sessionId', 'token', 'id'])).toBeNull()
    expect(pillarMethodProblem('mail', 'work.tasks.list', 'read', [])).toContain('work.mail.<verb>')
    expect(pillarMethodProblem('mail', 'mail.list', 'read', [])).toContain('work.mail.<verb>')
    expect(pillarMethodProblem('mail', 'work.mail.list', undefined, [])).toContain('no capability row')
    expect(pillarMethodProblem('mail', 'app.workMailMark', 'operate', ['sessionId', 'token'])).toContain('a bridge method is local')
    expect(pillarMethodProblem('mail', 'app.workMailMark', 'local', ['sessionId'])).toContain('takes sessionId and token')
  })
})
