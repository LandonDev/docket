import { describe, expect, it } from 'vitest'
import type { AccountsSnapshot } from './accounts'
import { ClientRequestSchema, type SessionBatchResult, type ThreadNotesDoc } from './contract'
import type { SessionChanges } from './wire'
import type { BatchState } from './contract-batch'
import type { DeployStatus, HostJobStatus, HostLogPush } from './contract-host'
import type { HostDevicesHost, HostDevicesReport } from './contract-hostdevices'
import type { MacBridgeThreadState } from './contract-macbridge'
import { ProjectPlanTickAnswerSchema, type ProjectPlanState } from './contract-projectplan'
import type { ThreadResource, ThreadResourceRemoval } from './contract-resources'
import type { BuildFacts } from './deployDrift'
import { NoticeKindSchema, type AgentEvent, type SessionMeta } from './events'
import { QueueAddResultSchema } from './wireSchemas'
import * as W from './wireSchemas'
import type { FileEntry, FilePlace } from './work/files'
import type { FileBytes as FilesBytes, FileDone, FilesListing } from './contract-work-files'
import type { DigestDay, DigestList, DigestPush, DigestSettings } from './contract-work-digest'
import type { TellOpen, TellRow } from './work/tell'

// Every schema the 2026-10-21/22 features added parses a value typed by its
// interface and gives it back unchanged: the type-level pins prove the keys,
// this proves the runtime constraints (int, enum, nullable) admit real values.

const meta: SessionMeta = {
  id: 'ios-master-impl-a',
  parentId: null,
  projectId: 'p',
  workspaceId: 'ws',
  threadType: 'implementation',
  planPath: null,
  provider: 'claude',
  model: 'claude-haiku-5-5',
  reasoning: 'low',
  agentType: 'implementer',
  title: 'A child',
  cwd: '/tmp/p',
  status: 'done',
  pinned: false,
  archived: false,
  permission: 'edits',
  fast: false,
  ultrafast: false,
  context1m: false,
  busySince: null,
  pausedAt: null,
  frozenActiveElapsed: null,
  nativeId: null,
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_000_001,
  masterId: 'ios-master',
  startedBy: 'ios-master'
} as SessionMeta

const build: BuildFacts = { release: 400, version: '1.0.400', sha: 'abc123', platform: 'linux' }

const batch: BatchState = {
  masterId: 'ios-master',
  rules: {
    land: 'as-they-finish',
    steps: [
      { id: 'land', name: 'Land', kind: 'land' },
      { id: 'gate', name: 'Gate', kind: 'gate' },
      { id: 'smoke', name: 'Smoke test', kind: 'shell', run: 'bun run smoke', when: 'all-done' }
    ],
    then: 'notify',
    summary: 'Land as they finish, gate, smoke'
  },
  steps: [
    { id: 'land', name: 'Land', kind: 'land', status: 'passed', detail: '3 of 4 branches landed', at: 1, progress: { done: 3, total: 4 }, log: [] },
    { id: 'gate', name: 'Gate', kind: 'gate', status: 'running', detail: '', at: 2, startedAt: 2, progress: { done: 2, total: 3, label: 'vitest' }, log: ['✓ typecheck 12s'] },
    { id: 'smoke', name: 'Smoke test', kind: 'shell', status: 'pending', detail: '', at: null, log: [] }
  ],
  landed: ['ios-master-impl-a'],
  pending: ['ios-master-impl-b'],
  held: [],
  blocked: null,
  finishedAt: null
}

const resource: ThreadResource = {
  id: 'r1',
  sessionId: 'ios-resources',
  environmentId: 'env_a',
  kind: 'worktree',
  identifier: '/tmp/p/.claude/worktrees/x',
  label: 'x',
  branch: 'x',
  createdAt: 1_760_000_000_000,
  removeRequestedAt: null,
  removedAt: null,
  note: null
}

const report: HostDevicesReport = {
  environmentId: 'env_a',
  at: 1_760_000_000_000,
  simulators: [
    { udid: 'A-1', name: 'iPhone 17', runtime: 'iOS 26.0', state: 'booted', cpu: 12.5, holder: { sessionId: 'ios-resources', title: 'Resources', status: 'idle' } },
    { udid: 'A-2', name: 'iPhone 17 Pro', runtime: 'iOS 26.0', state: 'shutdown', holder: null }
  ],
  phones: [{ udid: 'P-1', name: "Landon's iPhone", model: 'iPhone 16 Pro', os: 'iOS 26.0', connection: 'paired', holder: null }],
  xcode: { path: '/Applications/Xcode-26.app', name: 'Xcode-26', version: '26.0', from: 'newest' },
  load: { oneMinute: 3.2, cores: 8 },
  problems: []
}

const snapshot: AccountsSnapshot = {
  updatedAt: 1_760_000_000_000,
  providers: {
    meta: { pinned: null, profiles: [{ name: 'Meta key …LJY', createdAt: 1_750_000_000_000, active: false, static: true, kind: 'key' }], reports: [{ profileName: 'Meta key …LJY', windows: [], note: 'pay as you go' }], owner: 'temp-code' },
    claude: {
      pinned: 'work@example.com',
      profiles: [{ name: 'work@example.com', email: 'work@example.com', createdAt: 1_750_000_000_000, active: true, activeOn: ['CLI'] }],
      reports: [
        {
          profileName: 'work@example.com',
          windows: [{ label: '5h', usedPercent: 40, resetsAt: 1_760_000_100_000, periodMs: 18_000_000 }],
          plan: { name: 'Max 20x', monthlyUsd: 200 },
          rateLimit: { provider: 'anthropic' }
        }
      ],
      owner: 'temp-code',
      mint: { rows: { 'work@example.com': { state: 'minting', at: 1 } }, run: { total: 1, done: 0 } },
      headroom: { 'work@example.com': { room: 0.8, ratePerMin: 12, seenAt: 1_760_000_000_000 } }
    },
    codex: { pinned: null, profiles: [], reports: [], owner: null },
    cursor: { pinned: null, profiles: [], reports: [], owner: null, note: 'vault locked' },
    muse: { pinned: null, profiles: [], reports: [], owner: null }
  },
  homes: { claude: 'env_b' },
  peers: { env_b: { name: 'The box', connected: true, lastSyncAt: 1_759_999_700_000, error: null, build } }
}

const parses = <T>(schema: { parse: (v: unknown) => unknown }, value: T): void => {
  expect(schema.parse(value)).toEqual(value)
}

describe('the master thread shapes', () => {
  it('parse', () => {
    const result: SessionBatchResult = { attempted: ['a', 'b'], succeeded: ['a'], failed: [{ sessionId: 'b', error: 'gone' }] }
    parses(W.SessionBatchResultSchema, result)
    parses(W.SessionStartedSchema, { started: false })
    parses(W.BatchChildrenSchema, { children: [meta] })
    parses(W.BatchStoppedSchema, { stopped: true })
    parses(W.BatchPushSchema, { push: 'batch', state: batch })
  })
})

describe('notes, plans, reviews and resources', () => {
  it('parse the notes doc and its push', () => {
    const doc: ThreadNotesDoc = { text: '## Goal\n', updatedAt: 1_760_000_000_000, path: '/tmp/p/.temp-code/attachments/s/notes.md' }
    parses(W.ThreadNotesDocSchema, doc)
    parses(W.ThreadNotesDocSchema, { text: '', updatedAt: null, path: null })
    parses(W.NotesPushSchema, { push: 'notes', sessionId: 's', doc })
  })
  it('parse the project plan tick', () => {
    const state: ProjectPlanState = {
      projectId: 'p',
      path: '/tmp/p/.temp-code/plans/project.md',
      exists: true,
      pinned: true,
      sessionId: 'ios-project-plan',
      complete: true,
      milestones: [{ index: 1, title: 'Tokens', done: true }],
      missing: []
    }
    parses(ProjectPlanTickAnswerSchema, { ticked: true, state })
    parses(ProjectPlanTickAnswerSchema, { ticked: false, state: null })
  })
  it('parse the resource rows, their removal and their push', () => {
    parses(W.ThreadResourceSchema, resource)
    const waiting: ThreadResource = { ...resource, id: 'r2', kind: 'simulator', identifier: 'A-1', branch: null, removeRequestedAt: 2, note: 'Mac offline, waiting' }
    parses(W.ResourcesListSchema, { resources: [resource, waiting] })
    const removal: ThreadResourceRemoval = { id: 'r1', outcome: 'waiting', note: 'Mac offline, waiting' }
    parses(W.ResourcesRemovedSchema, { results: [removal] })
    parses(W.ResourcesPushSchema, { push: 'resources', sessionId: 'ios-resources', resources: [resource] })
    expect(() => W.ThreadResourceSchema.parse({ ...resource, kind: 'container' })).toThrow()
  })
})

describe('the launch mirror, the restart ledger', () => {
  it('parse both session.changes answers', () => {
    const reset: SessionChanges = { reset: true, seq: 12, generation: 'g1' }
    parses(W.SessionChangesSchema, reset)
    const full: SessionChanges = { reset: false, seq: 13, generation: 'g1', sessions: [meta], removed: ['gone'] }
    parses(W.SessionChangesSchema, full)
  })
  it('parse the boot-resume push', () => {
    parses(W.BootResumePushSchema, { push: 'boot-resume', count: 4, at: 1_760_000_000_000 })
    expect(() => W.BootResumePushSchema.parse({ push: 'boot-resume', count: 1.5, at: 1 })).toThrow()
  })
})

describe('devices, deploy, the bridge, accounts', () => {
  it('parse the device hosts, the report, the answers and the push', () => {
    const host: HostDevicesHost = { environmentId: 'env_a', name: 'Landon’s Mac', local: true }
    parses(W.HostDevicesHostSchema, host)
    parses(W.HostDevicesOkSchema, { ok: true })
    parses(W.HostDeviceOpenedSchema, { ok: true, opened: 'xcode' })
    parses(W.HostDevicesPushSchema, { push: 'host.devices', report })
  })
  it('parse the deploy status, the log snapshot and the log push', () => {
    const status: HostJobStatus = { job: 'deploy', phase: 'idle', target: null, startedAt: null, finishedAt: null, exit: null, stoppable: false }
    parses(W.HostJobStatusSchema, status)
    const deploy: DeployStatus = { ...status, job: 'deploy', installed: false, installHint: 'sudo install-deploy-trigger', version: '1.0.400' }
    parses(W.DeployStatusSchema, deploy)
    parses(W.HostLogSnapshotSchema, { text: '', status })
    const push: HostLogPush = { push: 'host-log', job: 'deploy', append: 'line\n', status }
    parses(W.HostLogPushSchema, push)
    expect(() => W.DeployStatusSchema.parse({ ...deploy, job: 'publish' })).toThrow()
  })
  it('parse the bridge thread state and the held push', () => {
    const state: MacBridgeThreadState = { sessionId: 's', macPeer: null, inherited: false, online: false, registered: [] }
    parses(W.MacBridgeThreadStateSchema, state)
    parses(W.MacBridgeThreadStateSchema, { ...state, macPeer: 'env_m', online: true, registered: ['env_m'], held: 3 })
    parses(W.MacBridgeHeldPushSchema, { push: 'macBridge.held', sessionId: 's', held: 3 })
  })
  it('parse the accounts snapshot (the phone subset) and its push', () => {
    // The snapshot schema is a subset of the desktop's (thread 24): it parses
    // the whole snapshot and keeps the fields the phone reads.
    const parsed = W.AccountsSnapshotSchema.parse(snapshot)
    expect(parsed.providers.claude.headroom?.['work@example.com']?.room).toBe(0.8)
    expect(parsed.providers.claude.profiles[0]?.name).toBe('work@example.com')
    expect(W.AccountsPushSchema.parse({ push: 'accounts', snapshot }).snapshot.updatedAt).toBe(snapshot.updatedAt)
    parses(W.BuildFactsSchema, build)
  })
  it('keep a Meta key\'s kind and a Meta pin for the phone', () => {
    const key = { name: 'build-key', active: false, static: true, kind: 'key' as const }
    expect(W.AccountProfileSchema.parse(key).kind).toBe('key')
    const request = ClientRequestSchema.parse({ id: '1', method: 'project.setAccounts', params: { projectId: 'p', pins: { claude: 'work', meta: 'build-key' } } })
    expect(request.method === 'project.setAccounts' && request.params.pins).toEqual({ claude: 'work', meta: 'build-key' })
  })
})

describe('the notice kinds', () => {
  it('are the literals the server appends', () => {
    expect(NoticeKindSchema.options).toEqual(['review', 'gate', 'batch', 'account-gone', 'plan-build', 'away'])
    const kinds: AgentEvent[] = [
      { type: 'notice', kind: 'review', message: 'Reviewed' },
      { type: 'notice', kind: 'gate', message: 'Gate passed' },
      { type: 'notice', kind: 'batch', message: 'Merged by the batch' },
      { type: 'notice', kind: 'account-gone', message: 'Account gone', account: 'ws@example.com' },
      { type: 'notice', kind: 'plan-build', message: 'The build did not start: refused' },
      { type: 'notice', kind: 'away', message: 'Decided without you', away: { kind: 'decision', text: 'Kept the old width' } },
      { type: 'notice', kind: 'away', message: 'Allowed while away: Run bun test?', away: { kind: 'allowed', text: 'Run bun test?' } }
    ]
    for (const row of kinds) expect(W.WireAgentEventSchema.parse(row)).toEqual(row)
    expect(() => W.WireAgentEventSchema.parse({ type: 'notice', kind: 'weather', message: 'Rain' })).toThrow()
  })
  it("the computer history's push parses a changed call and a removal, and no remote connection receives it", () => {
    const call = { n: 1, turn: 1, at: 10, state: 'running', app: 'TextEdit', window: 'Untitled', steps: [{ kind: 'click', verb: 'Clicking', object: 'Save', inApp: 'Save in TextEdit' }], text: false, rev: 1 }
    expect(W.ComputerHistoryPushSchema.parse({ push: 'computer-history', key: 't1', call })).toEqual({ push: 'computer-history', key: 't1', call })
    expect(W.ComputerHistoryPushSchema.parse({ push: 'computer-history', key: 'mac:env_1:t2', gone: true })).toEqual({ push: 'computer-history', key: 'mac:env_1:t2', gone: true })
    expect(() => W.ComputerHistoryPushSchema.parse({ push: 'computer-history', key: 't1', gone: false })).toThrow()
    expect(() => W.ComputerHistoryPushSchema.parse({ push: 'computer-history', call })).toThrow()
    // pictures of the person's windows and the reads off them: the Mac desktop's own socket only
    const remote: string[] = W.RemotePushSchema.options.map((o) => o.shape.push.value)
    for (const local of ['computer-history', 'computer-frame', 'computer-click', 'computer-preview']) expect(remote).not.toContain(local)
  })
  it('every remote push has its own schema in the union, once', () => {
    const names = W.RemotePushSchema.options.map((o) => o.shape.push.value)
    expect(names).toEqual(expect.arrayContaining(['notes', 'batch', 'resources', 'boot-resume', 'accounts', 'host.devices', 'host-log', 'macBridge.held']))
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('session.changes on the wire (thread 14)', () => {
  it('parses the reset answer and the delta answer with one flat schema', () => {
    const reset = W.SessionChangesSchema.parse({ reset: true, seq: 12, generation: 'g1' })
    expect(reset).toEqual({ reset: true, seq: 12, generation: 'g1' })
    const delta = W.SessionChangesSchema.parse({ reset: false, seq: 13, generation: 'g1', sessions: [], removed: ['s9'] })
    expect(delta.sessions).toEqual([])
    expect(delta.removed).toEqual(['s9'])
    expect(() => W.SessionChangesSchema.parse({ reset: false, seq: 1.5, generation: 'g1' })).toThrow()
  })
  it('the boot-resume push is a remote push with its count and the boot time', () => {
    const frame = { push: 'boot-resume', count: 3, at: 1_700_000_000_000 }
    expect(W.RemotePushSchema.parse(frame)).toEqual(frame)
    expect(() => W.RemotePushSchema.parse({ push: 'boot-resume', count: 3 })).toThrow()
  })
})

describe('queue.add answers typed', () => {
  it('a queued item or a steer, nothing else', () => {
    expect(QueueAddResultSchema.parse({ kind: 'queued', item: { id: 'm1', text: 'later', ts: 1 } })).toEqual({ kind: 'queued', item: { id: 'm1', text: 'later', ts: 1 } })
    expect(QueueAddResultSchema.parse({ kind: 'steered', id: 'm2' })).toEqual({ kind: 'steered', id: 'm2' })
    expect(QueueAddResultSchema.safeParse(null).success).toBe(false)
    expect(QueueAddResultSchema.safeParse({ id: 'm1', text: 'later', ts: 1 }).success).toBe(false)
  })
})

describe('a steer and its stamp', () => {
  it('parse: the user row with its steerId, each state, a queued item keeping the id', () => {
    const user: AgentEvent = { type: 'user-text', text: 'use the other table', steerId: 's-1' }
    expect(W.WireAgentEventSchema.parse(user)).toEqual(user)
    const rows: AgentEvent[] = [
      { type: 'steer', steerId: 's-1', state: 'sent' },
      { type: 'steer', steerId: 's-1', state: 'received', how: 'in-turn' },
      { type: 'steer', steerId: 's-1', state: 'received', how: 'next-turn' },
      { type: 'steer', steerId: 's-1', state: 'queued' },
      { type: 'steer', steerId: 's-1', state: 'failed', reason: 'the harness did not start' }
    ]
    for (const row of rows) expect(W.WireAgentEventSchema.parse(row)).toEqual(row)
    expect(() => W.WireAgentEventSchema.parse({ type: 'steer', steerId: 's-1', state: 'read' })).toThrow()
    const item = { id: 'q1', text: 'use the other table', ts: 1, steerId: 's-1' }
    expect(W.QueuedMessageSchema.parse(item)).toEqual(item)
  })
})

describe("an approval's choices", () => {
  it('parse: Run now and Skip, Allow and Deny, or none; nothing else', () => {
    const base = { type: 'approval-request', requestId: 'a-1', toolName: 'computer_session', input: { app: 'TextEdit' } } as const
    const asked: AgentEvent[] = [base, { ...base, choices: 'run-skip' }, { ...base, choices: 'allow-deny' }]
    for (const row of asked) expect(W.WireAgentEventSchema.parse(row)).toEqual(row)
    expect(() => W.WireAgentEventSchema.parse({ ...base, choices: 'yes-no' })).toThrow()
  })
})

describe('the Files place on the phone (F9)', () => {
  const place: FilePlace = {
    id: 'folder',
    kind: 'folder',
    name: 'Dummy Esports',
    host: 'box',
    env: 'env_box',
    shared: false,
    can: ['make', 'upload', 'rename', 'move', 'copy', 'edit', 'trash', 'restore', 'purge'],
    state: { state: 'ok' },
    root: { at: 'place', id: 'folder' }
  }
  const folder: FileEntry = { key: 'file:box:/w/Budgets', ref: null, folder: { at: 'file', host: 'box', path: '/w/Budgets' }, name: 'Budgets', kind: 'folder', changed: 1_700_000_000_000 }
  const file: FileEntry = {
    key: 'lib:esportsstaff:Budgets/2026.xlsx',
    ref: { at: 'file', host: 'mac', path: '/Users/x/Esports Staff/Budgets/2026.xlsx' },
    folder: null,
    name: '2026.xlsx',
    kind: 'sheet',
    size: 48_213,
    changed: 1_700_000_000_000,
    shared: true,
    state: { is: 'present', who: 'Esports Staff' },
    where: { place: 'teams~1', name: 'Esports Staff', trail: ['Budgets'] },
    starred: true
  }

  it('parse a place list, a listing and a change as the host answers them', () => {
    const asleep: FilePlace = { ...place, id: 'mac~abc', kind: 'teams', name: 'General', host: 'MacBook', env: 'env_mac', shared: true, can: [], state: { state: 'asleep', at: 5 }, root: { at: 'file', host: 'mac', path: '/Users/x/General' }, key: 'esportsstaffgeneral', group: 'Esports Staff', web: null }
    expect(W.FilesPlacesPhoneSchema.parse({ host: 'box', places: [place, asleep], rev: 3, sources: [] })).toEqual({ host: 'box', places: [place, asleep], rev: 3 })
    const listing: FilesListing = { entries: [folder, file], next: 'c1', place: 'Dummy Esports', trail: [{ name: 'Dummy Esports', at: { at: 'place', id: 'folder' } }] }
    expect(W.FilesListingSchema.parse(listing)).toEqual(listing)
    expect(W.FilesListingSchema.parse({ entries: [], stale: true })).toEqual({ entries: [], stale: true })
    const done: FileDone = { entries: [file], refused: [{ name: 'Old.pdf', text: 'Delete it in Teams.' }], trashed: ['t1'], op: 'op_12345678' }
    expect(W.FileDoneSchema.parse(done)).toEqual(done)
  })

  it('read a preview either way, a read frame, an open and the push', () => {
    expect(W.FilePreviewPhoneSchema.parse({ png: 'iVBOR', pages: 3, width: 800, height: 1100 })).toEqual({ png: 'iVBOR', pages: 3, width: 800, height: 1100 })
    expect(W.FilePreviewPhoneSchema.parse({ none: 'No preview for this file.' })).toEqual({ none: 'No preview for this file.' })
    const frame: FilesBytes = { data: 'aGk=', size: 2, version: 'v1', changed: 10, end: true, locked: 'A remote key cannot change this file.' }
    expect(W.FileReadSchema.parse(frame)).toEqual(frame)
    expect(W.FilesOpenedPhoneSchema.parse({ rev: 4, tabs: [], held: { sessionId: 's1', itemId: 'i1' } })).toEqual({ rev: 4, held: { sessionId: 's1', itemId: 'i1' } })
    expect(W.WorkFilesPushSchema.parse({ push: 'work.files', workspaceId: 'w1', at: 'file:box:/w' })).toEqual({ push: 'work.files', workspaceId: 'w1', at: 'file:box:/w' })
    expect(W.RemotePushSchema.options.map((o) => o.shape.push.value)).toContain('work.files')
  })
})

describe('the digest on the phone', () => {
  const row: TellRow = {
    id: 't1',
    host: 'box',
    kind: 'outbox.held',
    group: 'held',
    workspaceId: 'w_purdue',
    sector: 'purdue',
    title: 'Budget review',
    detail: 'Dana Reyes',
    open: { held: { at: 'host', id: 'h1' }, thread: 's1' },
    by: 1_795_464_000_000,
    key: 'held:h1',
    at: 1_795_460_000_000,
    how: 'now',
    day: null,
    toldAt: 1_795_460_000_000
  }
  it('a told row, a day, the settings and the push parse as the host sends them', () => {
    expect(W.TellRowPhoneSchema.parse(row)).toEqual(row)
    const day: DigestDay = { day: '2026-11-23', madeAt: 1, seenAt: null, count: 3 }
    const settings: DigestSettings = { at: '08:00', zone: 'America/New_York', levels: { held: 'now' }, nextAt: 2 }
    const list: DigestList = { days: [day], rows: [row], waiting: 0, groups: ['held', 'results'] }
    expect(W.DigestListPhoneSchema.parse(list)).toEqual(list)
    expect(W.DigestSettingsWireSchema.parse(settings)).toEqual(settings)
    const push: DigestPush = { push: 'work.digest', day, row, settings }
    expect(W.RemotePushSchema.parse(push)).toEqual(push)
    expect(W.RemotePushSchema.parse({ push: 'work.digest', gone: 't1' })).toEqual({ push: 'work.digest', gone: 't1' })
  })
  it("every tell target reads as the phone's one flat object", () => {
    const opens: TellOpen[] = [{ thread: 's1' }, { view: 'agenda', workspaceId: 'w1', at: 'ev1' }, { place: 'review' }, { held: { at: 'lifeos', table: 'outbox', id: 'ob_1' } }, { settings: 'connections' }]
    for (const open of opens) expect(W.TellOpenPhoneSchema.parse(open)).toEqual(open)
  })
})

describe('M1 Work on the phone', () => {
  it('reads the Microsoft Forms list fields from a push and accepts a removed form', () => {
    const view = { formId: 'f1', tenant: 't1', title: 'RSVP', state: 'collecting', count: 2, link: null }
    const change = { push: 'work.msforms', workspaceId: 'w1', formId: view.formId }
    expect(W.RemotePushSchema.parse({ ...change, view: { ...view, questions: [], unseen: 1 } })).toEqual({ ...change, view: { ...view, unseen: 1 } })
    expect(W.RemotePushSchema.parse({ ...change, view: null })).toEqual({ ...change, view: null })
  })

  it("reads clash rows with each side's ways out and guests (the clash sheet's, M2c), leaves the map's roughness, and keeps all leave times", () => {
    const a = { eventId: 'a', sector: 'purdue', title: 'Budget review', startsAt: 1_000, endsAt: 3_000 }
    const b = { eventId: 'b', sector: 'cosmic', title: 'Standup', startsAt: 2_000, endsAt: 4_000 }
    const clash = { id: 'a-b', kind: 'overlap', a: { ...a, can: ['move'], guests: true }, b: { ...b, can: [] } }
    const leaves = [{ eventId: 'a', leaveAt: 500, from: 'start', measured: true }]
    const full = { ...clash, a: { ...clash.a, rough: 'town' }, b: { ...clash.b, rough: 'start' } }
    expect(W.ClashesListPhoneSchema.parse({ clashes: [full], leaves })).toEqual({ clashes: [clash], leaves })
  })

  it("reads a meeting's page as the phone draws it, leaving out what it does not", () => {
    const page = {
      workspaceId: 'w', sector: 'purdue', event: { id: 'e', title: 'Budget sync', startsAt: 1, endsAt: 2, allDay: false },
      people: [{ name: 'Maya Chen', address: 'maya@x.example', mail: { id: 'm', subject: 'Budget', at: 1, unread: true } }], morePeople: 0,
      invited: ['maya@x.example'], tasks: [], files: [{ title: 'Plan', chip: { kind: 'item', label: 'Plan' } }], last: null,
      doc: { people: [{ name: 'Ana' }], brief: { matters: [{ text: 'Over budget', ref: { table: 'docs', id: 'd' } }], agreed: [], files: [], at: 1, by: 's' }, notes: null,
        after: { summary: [], decisions: [], questions: [], tasks: [{ id: 't', title: 'Send notes', state: 'proposed', tried: true }], at: 2, by: ['s'] } },
      rev: 3, state: 'after', briefSessionId: 's', followSessionId: null, briefUntil: null, followUntil: null, briefStartedAt: 1, followStartedAt: null,
      drafts: [], notesFile: null, aheadOn: false, aheadOffered: true, problems: ['last']
    }
    const read = W.PrepPageAnswerSchema.parse({ page }).page
    expect(read.files).toEqual([{ title: 'Plan' }])
    expect('invited' in read || 'aheadOn' in read || 'people' in read.doc).toBe(false)
    expect(read.doc.after?.tasks).toEqual([{ id: 't', title: 'Send notes', state: 'proposed' }])
    expect(read.doc.brief).toEqual({ matters: [{ text: 'Over budget', ref: { table: 'docs', id: 'd' } }], agreed: [], files: [], at: 1 })
    expect(W.PrepNotesAnswerSchema.parse({ page, conflict: true }).conflict).toBe(true)
    expect(W.ClashAnsweredSchema.parse({ queued: false })).toEqual({ queued: false })
    expect(W.MsFormsByPersonSchema.parse({ email: 'a@x.example', forms: [{ formId: 'f', title: 'Survey', tenant: 't', at: null }] }).forms).toHaveLength(1)
  })
})

describe('M5a: the week and the money on the phone', () => {
  it("reads a desktop Money answer whole as the phone's view, and a write's two answers", () => {
    const read = {
      made: true,
      any: true,
      root: { at: 'file', host: 'mac', path: '/w/Money' },
      period: { from: '2026-11-01', to: '2026-12-01' },
      rows: [{ row: 3, ref: 'r1', date: '2026-11-20', who: 'Shell', what: 'Gas', category: 'Travel', in: 0, out: 4817, status: 'Paid', paidOn: null, receipt: '' }],
      sums: { in: 0, out: 4817, net: -4817, owedToHim: 7500, heOwes: 0 },
      byCategory: [{ category: 'Travel', amount: -4817, share: 1 }],
      byMonth: [],
      owed: [{ row: 5, ref: null, sig: 'abc', who: 'West HS', what: 'Game', amount: 7500, since: '2026-11-02', way: 'toHim', reimburse: false, both: false }],
      miles: { miles: 0, value: 0, rate: null },
      categories: ['Travel'],
      sellers: ['Shell'],
      toConfirm: [{ id: 'a', state: 'ready', source: 'phone', name: 'IMG.jpg', picture: true, fields: { amount: 1043, date: '2026-11-21', who: null, category: null }, at: 1 }],
      calendar: [],
      rate: { year: 2026, rate: 0.7, own: false },
      problems: [{ kind: 'columns', missing: ['Out'], renamed: [], waits: true }, { kind: 'undated', rows: [9], book: 'mileage' }]
    }
    const phone = W.MoneyReadPhoneSchema.parse(read)
    expect(phone.owed[0].sig).toBe('abc')
    expect(phone.problems.map((p) => p.kind)).toEqual(['columns', 'undated'])
    expect(W.MoneyActedPhoneSchema.parse({ ok: true, ref: null, row: 4, suggested: true }).suggested).toBe(true)
    expect(W.MoneyActedPhoneSchema.parse({ changed: true }).changed).toBe(true)
    expect(W.ReviewSettledSchema.parse({ undo: null, sessionId: 's1' })).toEqual({ undo: null, sessionId: 's1' })
    expect(W.ReviewKeptListSchema.parse({ weeks: [{ from: 1, to: 2, tz: 'America/Chicago', madeAt: 3, by: 'routine' }], tz: 'America/Chicago' }).weeks).toHaveLength(1)
  })
})

describe("M5b: a job's small places on the phone", () => {
  it('reads a play, a run, a template and what a make answers, leaving the rest', () => {
    const play = { id: 'p1', workspaceId: 'w1', name: 'Recap', instructions: 'Write it', takes: ['text', 'date'], proposed: false, madeIn: null, starter: null, createdBy: 'owner', createdAt: 1, updatedAt: 2, host: 'box' }
    expect(W.PlaysListPhoneSchema.parse({ plays: [play] }).plays[0]).toEqual({ id: 'p1', workspaceId: 'w1', name: 'Recap', instructions: 'Write it', takes: ['text', 'date'], proposed: false, host: 'box' })
    const run = { id: 'r1', routineId: 'x', sessionId: null, firedAt: 3, cause: 'Run now', folded: 0, state: 'quiet', summary: 'Nothing to do', open: { place: 'review' } }
    expect(W.RoutineRunsPhoneSchema.parse({ runs: [run] })).toEqual({ runs: [run] })
    expect(W.RoutineRunPhoneSchema.nullable().parse(null)).toBeNull()
    const template = { id: 'job:Invoice.docx', name: 'Invoice', kind: 'document', form: 'docx', where: 'job', fields: ['Client'], source: { at: 'file', host: 'box', path: '/w/Templates/Invoice.docx' } }
    expect(W.TemplatesListPhoneSchema.parse({ templates: [template], hidden: 1 }).templates[0]).not.toHaveProperty('source')
    expect(W.TemplateMadePhoneSchema.parse({ source: template.source, kind: 'document', title: 'Invoice', unfilled: ['PO'] })).toEqual({ kind: 'document', title: 'Invoice', unfilled: ['PO'] })
  })

  it("reads our forms' rows and a close, a Microsoft form's answers, and its unseen count", () => {
    const ours = { kind: 'ours', id: 'i1', title: 'RSVP', state: 'open', count: null, lastAnswerAt: null, updatedAt: 5, sessionId: 's1' }
    expect(W.FormListPhoneRowSchema.parse(ours)).toEqual({ id: 'i1', title: 'RSVP', state: 'open', updatedAt: 5 })
    expect(W.FormStatePhoneSchema.parse({ itemId: 'i1', state: 'closed', rev: 2, body: {} })).toEqual({ itemId: 'i1', state: 'closed' })
    const answers = { rev: 1, columns: [{ id: 'q', label: 'Name' }], rows: [['Ava']], count: 1, cut: false, at: 9, stale: false, none: false }
    expect(W.MsFormResponsesPhoneSchema.parse(answers)).toEqual(answers)
    expect(W.MsFormPhoneRowSchema.parse({ formId: 'f', tenant: 't', title: 'x', state: 'closed', count: 2, link: null, unseen: 2, stopped: null, questions: [] })).toEqual({ formId: 'f', tenant: 't', title: 'x', state: 'closed', count: 2, link: null, unseen: 2, stopped: null })
  })

  it("reads a dashboard block's sheet, and none for a figure an agent set from a service", () => {
    const figures = { id: 'b', kind: 'figures', figures: [
      { id: 'f1', label: 'Owed', format: 'money', value: '$40', from: { sheet: { at: 'lifeos', table: 'sheets', id: 'sh1' }, sheetTitle: 'Ledger', range: 'E2:E9', counts: 'Amount', agg: 'sum' } },
      { id: 'f2', label: 'Seats', format: 'number', value: '12', from: { service: 'Start.gg', counts: 'entrants' } }
    ] }
    const read = W.DashBlockPhoneSchema.parse(figures)
    expect(read.kind === 'figures' && read.figures.map((f) => f.from)).toEqual([{ counts: 'Amount', sheet: { at: 'lifeos', table: 'sheets', id: 'sh1' }, sheetTitle: 'Ledger' }, { counts: 'entrants' }])
  })

  it("reads each host's Connections and lapses, and the VM's state and its push (every key hears it: the state is read)", () => {
    const report = { host: 'box', at: 1, rows: [{ id: 'lifeos.session', pillar: 'lifeos', group: 'LifeOS', title: 'LifeOS', state: 'needs-you', line: 'Signed out', fix: { kind: 'page', label: 'Sign In', page: 'lifeos-sign-in' }, lifeos: 'signedOut' }] }
    expect(W.HealthReportPhoneSchema.parse(report).rows[0]).toEqual({ id: 'lifeos.session', group: 'LifeOS', title: 'LifeOS', state: 'needs-you', line: 'Signed out', fix: { kind: 'page', label: 'Sign In', page: 'lifeos-sign-in' } })
    expect(W.LapsePhoneSchema.parse({ id: 'eval', pillar: 'winvm', title: 'Windows evaluation', until: 9 })).toEqual({ id: 'eval', title: 'Windows evaluation', until: 9 })
    const state = { state: 'asleep', step: null, error: null, cannot: null, sleepAfter: '30m', since: 4, wakeMs: 12000, heldAsleep: true, display: { device: 'vga', width: 1280, height: 800, scale: 100, fit: false, detail: 'faster', canResize: false } }
    const { sleepAfter: _s, display: _d, ...phone } = state
    expect(W.WinvmStatePhoneSchema.parse(state)).toEqual(phone)
    expect(W.RemotePushSchema.parse({ push: 'work.winvm', state })).toEqual({ push: 'work.winvm', state: phone })
    expect(W.RemotePushSchema.parse({ push: 'work.routines.plays', workspaceId: 'w1' })).toEqual({ push: 'work.routines.plays', workspaceId: 'w1' })
  })
})
