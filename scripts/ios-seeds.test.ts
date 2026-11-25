import { describe, expect, it } from 'vitest'
import { EntryFieldsSchema } from '../src/shared/contract-work-money'
import { RoutinesRequestSchemas } from '../src/shared/contract-work-routines'
import { TellGroupSchema, TellOpenSchema } from '../src/shared/work/tell'
import { AccountsSnapshotSchema, WireAgentEventSchema } from '../src/shared/wireSchemas'
import { HostDevicesReportSchema } from '../src/shared/contract-hostdevices'
import { FailureKindSchema, NoticeKindSchema } from '../src/shared/events'
import { NOTE_SECTIONS, notesEmpty, parseNotes, stateLine } from '../src/shared/notes'
import { parseProjectPlan } from '../src/shared/projectPlan'
import { BatchStateSchema } from '../src/shared/contract-batch'
import { MacDevices } from '../src/main/server/devices/hostDevices'
import {
  PREAMBLE_WORDS,
  accountsSnapshot,
  batchRowMidRun,
  devicesReport,
  failureRows,
  fakeMacDevicesDeps,
  noticeRows,
  noticesThreadRows,
  notesFive,
  notesTwo,
  preambleRow,
  preambleText,
  projectPlanMarkdown,
  withShellLog,
  COMPUTER_HELD_REQUEST,
  computerAwayRows,
  computerConfirmRows,
  computerHeldRows,
  runSkipAsk
} from './lib/ios-seeds'
import { inflateSync } from 'node:zlib'
import { MoneyRequestSchemas } from '../src/shared/contract-work-money'
import { FilesRequestSchemas } from '../src/shared/contract-work-files'
import { SearchRequestSchemas } from '../src/shared/contract-work-search'
import {
  FOLD_HELD_COUNT,
  FOLD_OPEN_ID,
  FOLD_TOP_INDEX,
  M2_JOBS,
  M3_PDF,
  M3_TRASHED,
  M5_PAID_ROWS,
  foldHeldRows,
  m3Files,
  m3TrashParams,
  m4RecentHits,
  m5MoneyRows,
  m5Plays,
  solidPng,
  todaySeedRows
} from './lib/ios-work-seeds'

describe('the notices thread', () => {
  it('carries one notice per NoticeKind and one error per FailureKind, every row on the wire schema', () => {
    const kinds = noticeRows().map((r) => (r.type === 'notice' ? r.kind : null))
    for (const kind of NoticeKindSchema.options) expect(kinds).toContain(kind)
    const failures = failureRows().map((r) => (r.type === 'error' ? r.failure?.kind : null))
    expect(failures).toEqual(FailureKindSchema.options)
    for (const row of noticesThreadRows()) expect(WireAgentEventSchema.parse(row)).toEqual(row)
  })
  it('names the review and gate payloads the cards read', () => {
    const rows = noticeRows('rev')
    const held = rows.find((r) => r.type === 'notice' && r.review?.outcome === 'held')
    expect(held?.type === 'notice' && held.review?.blocking[0]?.verdict).toBe('CONFIRMED')
    expect(held?.type === 'notice' && held.review?.minor).toHaveLength(2)
    expect(held?.type === 'notice' && held.review?.reviewerId).toBe('rev')
    const red = rows.find((r) => r.type === 'notice' && r.gate?.ok === false)
    expect(red?.type === 'notice' && red.gate?.log.split('\n')).toHaveLength(40)
    expect(red?.type === 'notice' && red.gate?.log.endsWith('✗ vitest 12s')).toBe(true)
    const limited = failureRows().find((r) => r.type === 'error' && r.failure?.kind === 'rate_limited')
    expect(limited?.type === 'error' && limited.limit?.window).toBe('5h')
    const whole = noticesThreadRows('build-1')
    expect(whole.at(-1)).toEqual({ type: 'status', status: 'error' })
    expect(whole.find((r) => r.type === 'plan-handoff')).toMatchObject({ sessionId: 'build-1', how: 'auto' })
    expect(whole.some((r) => r.type === 'errors-cleared')).toBe(true)
  })
  it('stamps the preamble with its word count', () => {
    expect(preambleText().split(/\s+/)).toHaveLength(PREAMBLE_WORDS)
    const row = preambleRow()
    expect(row.type === 'user-text' && row.preamble?.words).toBe(PREAMBLE_WORDS)
  })
})

describe('the notes', () => {
  it('fill every heading, or two, with the headings always present', () => {
    const five = parseNotes(notesFive())
    expect(five.sections.map((s) => s.heading)).toEqual([...NOTE_SECTIONS])
    expect(five.sections.every((s) => s.body.trim().length > 0)).toBe(true)
    expect(stateLine(notesFive())).toBe('Drawer built; the banner line next.')
    const two = parseNotes(notesTwo())
    expect(two.sections.map((s) => s.heading)).toEqual([...NOTE_SECTIONS])
    expect(two.sections.filter((s) => s.body.trim()).map((s) => s.heading)).toEqual(['Goal', 'State'])
    expect(notesEmpty(notesTwo())).toBe(false)
  })
})

describe('the project plan', () => {
  it('is complete with seven milestones, three done, no missing section', () => {
    const plan = parseProjectPlan(projectPlanMarkdown())
    expect(plan.status).toBe('complete')
    expect(plan.missing).toEqual([])
    expect(plan.milestones).toHaveLength(7)
    expect(plan.milestones.filter((m) => m.done).map((m) => m.index)).toEqual([1, 2, 3])
    expect(plan.milestones[3]?.title).toBe('Search across hosts')
    expect(plan.milestones.every((m) => m.scope && m.dependencies && m.doneWhen)).toBe(true)
  })
})

describe('the batch row', () => {
  it('is mid-run: land passed, gate running at 2 of 3, the shell step streaming', () => {
    const row = batchRowMidRun('m', { landed: ['a', 'b'], pending: ['c', 'd'] })
    const { armed: _armed, branches: _b, subjects: _s, holds: _h, version: _v, deployRef: _d, leftOut: _l, ...wire } = row
    expect(BatchStateSchema.parse({ ...wire, pending: ['c', 'd'] })).toBeTruthy()
    expect(row.steps.map((s) => [s.id, s.status])).toEqual([['land', 'passed'], ['gate', 'running'], ['release', 'pending'], ['smoke', 'running']])
    expect(row.steps[0]?.detail).toBe('2 of 4 branches landed')
    expect(row.steps[1]?.progress).toEqual({ done: 2, total: 3, label: 'vitest' })
    const smoke = row.steps[3]!
    expect(smoke.kind).toBe('shell')
    expect(smoke.log).toHaveLength(40)
    expect(smoke.log[0]).toBe('$ bun run smoke')
    expect(row.landed).toEqual(['a', 'b'])
    expect(row.held).toEqual([])
    expect(row.rules.steps.at(-1)).toMatchObject({ kind: 'shell', run: 'bun run smoke', when: 'all-done' })
  })
  it('appends to the running shell step, keeping the newest 200 lines', () => {
    const row = withShellLog(batchRowMidRun('m', { landed: [], pending: ['c'] }), Array.from({ length: 170 }, (_, i) => `more ${i}`))
    const smoke = row.steps.find((s) => s.kind === 'shell')!
    expect(smoke.log).toHaveLength(200)
    expect(smoke.log.at(-1)).toBe('more 169')
    expect(row.steps.find((s) => s.id === 'gate')?.log).toHaveLength(2)
  })
})

describe('devices', () => {
  it('the hand-written report parses', () => {
    expect(HostDevicesReportSchema.parse(devicesReport('env_a'))).toEqual(devicesReport('env_a'))
  })
  it('the fake gatherer answers the same simulators, phone, Xcode and load', async () => {
    const report = await new MacDevices(fakeMacDevicesDeps('env_a')).report()
    expect(HostDevicesReportSchema.parse(report)).toEqual(report)
    expect(report.problems).toEqual([])
    expect(report.simulators.map((s) => [s.name, s.state])).toEqual([['iPhone 17', 'booted'], ['iPhone 17 Pro', 'shutdown']])
    expect(report.simulators[0]?.holder?.sessionId).toBe('ios-resources')
    expect(report.simulators[0]?.cpu).toBe(12.5)
    expect(report.simulators[1]?.holder).toBeNull()
    expect(report.phones.map((p) => [p.model, p.connection, p.transport])).toEqual([['iPhone 16 Pro', 'paired', 'Wi-Fi']])
    expect(report.xcode).toEqual({ path: '/Applications/Xcode-26.app', name: 'Xcode-26', version: '26.0', from: 'newest' })
    expect(report.load).toEqual({ oneMinute: 3.2, cores: 8 })
    expect(report).toEqual(devicesReport('env_a'))
  })
})

describe('accounts', () => {
  it('the snapshot carries two Claude profiles of different headroom and the peer, and the phone subset parses it', () => {
    const build = { release: 400, version: '1.0.400', sha: 'abc', platform: 'linux' }
    const snapshot = accountsSnapshot({ environmentId: 'env_b', name: 'The box', build })
    expect(AccountsSnapshotSchema.safeParse(snapshot).success).toBe(true)
    const claude = snapshot.providers.claude
    expect(claude.pinned).toBe('work@example.com')
    expect(claude.profiles.map((p) => p.name)).toEqual(['work@example.com', 'spare@example.com'])
    expect(claude.headroom?.['work@example.com']?.room).toBe(0.8)
    expect(claude.headroom?.['spare@example.com']?.throttledUntil).toBeGreaterThan(snapshot.updatedAt)
    expect(claude.reports[1]?.windows.find((w) => w.label === 'Weekly')?.usedPercent).toBe(95)
    expect(snapshot.providers.codex.profiles).toHaveLength(1)
    expect(snapshot.peers?.env_b).toMatchObject({ connected: true, build })
  })
})

describe('the computer threads', () => {
  it('hold a step for the Mac on Run now and Skip, on the call it waits for, every row on the wire schema', () => {
    const rows = computerHeldRows()
    for (const row of [...rows, ...computerConfirmRows(), ...computerAwayRows()]) expect(WireAgentEventSchema.parse(row)).toEqual(row)
    const call = rows.find((r) => r.type === 'tool-call')
    const ask = rows.find((r) => r.type === 'approval-request')
    expect(ask).toMatchObject({
      requestId: COMPUTER_HELD_REQUEST,
      toolName: 'computer_session',
      choices: 'run-skip',
      title: 'Use your pointer and keyboard to click button "Save" in TextEdit, window "Untitled"',
      callId: call?.type === 'tool-call' ? call.callId : null
    })
    expect(rows.at(-1)).toEqual({ type: 'status', status: 'waiting', detail: 'awaiting approval' })
    expect(runSkipAsk('r', 'c')).toMatchObject({ requestId: 'r', callId: 'c', choices: 'run-skip' })
  })
  it('a confirmation carries the host\'s computer card shape, no choices', () => {
    const ask = computerConfirmRows().find((r) => r.type === 'approval-request')
    expect(ask?.type === 'approval-request' && ask.choices).toBeUndefined()
    expect(ask).toMatchObject({ toolName: 'mcp__app__computer_batch', input: { app: 'Mail', window: 'Re: Lunch', actions: ['click button "To"', 'type "Lunch at noon?"', 'click button "Send"'] } })
    expect(ask?.type === 'approval-request' && ask.title).toMatch(/^3 actions in Mail, window "Re: Lunch": /)
  })
  it('a step allowed while away is the registry\'s away notice, no card', () => {
    const rows = computerAwayRows()
    expect(rows.some((r) => r.type === 'approval-request')).toBe(false)
    expect(rows.find((r) => r.type === 'notice')).toMatchObject({
      kind: 'away',
      message: 'Allowed while away: Use your pointer and keyboard to click button "Rename" in Finder, window "Documents"?',
      away: { kind: 'allowed' }
    })
  })
})

describe('the Work fold cycle seeds', () => {
  const ids = { purdue: 'ws-purdue', unify: 'ws-unify', venue: 's-venue', invoices: 's-invoices', addonId: 'addon-1' }
  const now = 1_800_000_000_000

  it('holds enough posts that the Outbox scrolls, each with its own id, in two bands', () => {
    const rows = foldHeldRows(ids, now)
    expect(rows).toHaveLength(FOLD_HELD_COUNT)
    expect(new Set(rows.map((r) => r.id)).size).toBe(FOLD_HELD_COUNT)
    expect(new Set(rows.map((r) => r.workspaceId))).toEqual(new Set(['ws-purdue', 'ws-unify']))
    expect(rows.map((r) => r.id)).toContain(FOLD_OPEN_ID)
    expect(FOLD_TOP_INDEX).toBeLessThan(FOLD_HELD_COUNT)
  })

  it('writes held add-on calls through the rule-held tool, older than every other work seed', () => {
    for (const r of foldHeldRows(ids, now)) {
      expect(r).toMatchObject({ kind: 'addon.call', verb: 'Post', payload: { addonId: 'addon-1', tool: 'echo' } })
      expect(r.state).toBeUndefined()
      // Milestone 47's oldest row is 100 minutes old: the other sets still open their own item first.
      expect(now - (r.createdAt as number)).toBeGreaterThan(100 * 60_000)
    }
  })
})


describe('the Today seeds', () => {
  const now = new Date(2026, 10, 24, 12).getTime()
  const rows = todaySeedRows({ purdue: 'purdue-job', venue: 'venue-thread' }, now)

  it('gives Today fresh digest rows with places to open', () => {
    expect(rows.tells.map((row) => [TellGroupSchema.parse(row.group), row.at, TellOpenSchema.parse(row.open)])).toEqual([
      ['results', now, { thread: 'venue-thread' }],
      ['ending', now, { settings: 'connections' }]
    ])
    expect(rows.tells[0].workspaceId).toBe('purdue-job')
    expect(new Set(rows.tells.map((row) => row.key)).size).toBe(rows.tells.length)
  })

  it('puts an unpaid incoming deposit in the Purdue ledger', () => {
    expect(rows.entry.workspaceId).toBe('purdue-job')
    expect(EntryFieldsSchema.parse(rows.entry.fields)).toMatchObject({
      date: '2026-11-24', who: 'Spring LAN banner desk', way: 'in', amount: 2400, status: 'Unpaid'
    })
  })

  it('runs the weekly review job in the Purdue workspace', () => {
    const save = RoutinesRequestSchemas.find((schema) => schema.shape.method.value === 'work.routines.save')!
    expect(save.parse({ id: 'seed', method: 'work.routines.save', params: rows.routine }).params).toMatchObject({
      workspaceId: 'purdue-job', job: 'review.make', trigger: { on: 'schedule', tz: 'America/New_York' }
    })
  })
})

/** A request's params as the host's own schema reads them; throws where the host would refuse the seed. */
function wire(schemas: readonly { shape: { method: { value: string } }; parse: (v: unknown) => unknown }[], method: string, params: unknown): Record<string, unknown> {
  const schema = schemas.find((x) => x.shape.method.value === method)!
  return (schema.parse({ id: 'seed', method, params }) as { params: Record<string, unknown> }).params
}

describe('the proof parts m2 to m5', () => {
  const now = new Date(2026, 10, 24, 12).getTime()

  it('m2 adds a job for each sector the fixture day names beyond the two seedWork makes', () => {
    expect(M2_JOBS.map((j) => j.sector)).toEqual(['cosmic', 'hypixel'])
    expect(new Set(M2_JOBS.map((j) => j.name)).size).toBe(2)
  })

  it('draws a PNG a reader can open: signature, size, one filtered row per line', () => {
    const png = solidPng(30, 20, [1, 2, 3])
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.toString('ascii', 12, 16)).toBe('IHDR')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([30, 20])
    const idat = png.indexOf('IDAT')
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)))
    expect(raw.length).toBe(20 * (1 + 30 * 3))
    expect([...raw.subarray(0, 4)]).toEqual([0, 1, 2, 3])
    expect(png.toString('ascii', png.length - 8, png.length - 4)).toBe('IEND')
  })

  it('m3 puts a PDF and two pictures in one folder, each named once', () => {
    const files = m3Files()
    expect(files.map((f) => f.name)).toEqual([M3_PDF, 'Arena photo.png', 'Stage photo.png'])
    expect(files[0].bytes.toString('ascii', 0, 5)).toBe('%PDF-')
    for (const f of files.slice(1)) expect(f.bytes.toString('ascii', 1, 4)).toBe('PNG')
    expect(files.map((f) => f.name)).not.toContain(M3_TRASHED)
  })

  it('m3 puts one more file in the Trash through the host\'s own trash call', () => {
    const params = wire(FilesRequestSchemas, 'work.files.trash', m3TrashParams('ws-p', 'env-1', '/w/Budgets'))
    expect(params.refs).toEqual([{ at: 'file', host: 'env-1', path: `/w/Budgets/${M3_TRASHED}` }])
  })

  it('m4 keeps two threads of two jobs in Recent, each as the host takes an opened hit', () => {
    const ids = { purdue: 'ws-p', unify: 'ws-u', venue: 's-venue', invoices: 's-inv' }
    const hits = m4RecentHits(ids, now)
    expect(new Set(hits.map((h) => h.workspaceId))).toEqual(new Set(['ws-p', 'ws-u']))
    for (const hit of hits) expect(wire(SearchRequestSchemas, 'work.search.opened', { hit }).hit).toMatchObject({ kind: 'thread', open: { to: 'thread' } })
  })

  it('m5 fills Money past its eight rows with one row owed each way, all in the month, on the ledger wire', () => {
    const { entries, receipts } = m5MoneyRows('ws-p', now)
    const parsed = entries.map((e) => wire(MoneyRequestSchemas, 'work.money.entry', e) as { fields: { date: string; status: string; way: string } })
    expect(parsed.filter((e) => e.fields.status === 'Paid')).toHaveLength(M5_PAID_ROWS)
    expect(M5_PAID_ROWS).toBeGreaterThan(8)
    expect(parsed.filter((e) => e.fields.status !== 'Paid').map((e) => e.fields.status)).toEqual(['To reimburse', 'Unpaid'])
    for (const e of parsed) expect(e.fields.date.startsWith('2026-11-')).toBe(true)
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length)
    // On the first of a month every row is still that month's.
    for (const e of m5MoneyRows('ws-p', new Date(2026, 10, 1, 9).getTime()).entries) expect(e.fields.date).toBe('2026-11-01')
    const waiting = receipts.map((r) => wire(MoneyRequestSchemas, 'work.money.receive', r))
    expect(waiting.map((r) => [r.fields, Array.isArray(r.lines)])).toEqual([[undefined, true], [undefined, false]])
  })

  it('m5 saves one play that takes a date and text and one that takes a mail', () => {
    const plays = m5Plays('ws-p').map((p) => wire(RoutinesRequestSchemas as never, 'work.routines.playSave', p))
    expect(plays.map((p) => p.takes)).toEqual([['date', 'text'], ['mail']])
  })
})
