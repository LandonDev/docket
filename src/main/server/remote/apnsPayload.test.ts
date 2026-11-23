import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { activityPayload, notificationPayload, type ApnsActivityUpdate, type ApnsNotice } from './apnsPayload'

/**
 * Parity by shared fixtures: infra/hub/test/fixtures/apns/*.json holds one
 * case per notification kind and per activity phase, `{ input, payload }`.
 * The hub's test reads the same files against its own builders, so the two
 * sides cannot drift; each `payload` is also what the master pushes with
 * `xcrun simctl push` for the simulator pass.
 */
const DIR = join(__dirname, '../../../../infra/hub/test/fixtures/apns')
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((file) => ({ file, ...(JSON.parse(readFileSync(join(DIR, file), 'utf8')) as { input: unknown; payload: unknown }) }))

describe('the APNs payloads match the shared fixtures', () => {
  it('has every case the plan names', () => {
    expect(fixtures.map((f) => f.file.replace(/\.json$/, ''))).toEqual([
      'activity-failed',
      'activity-finished',
      'activity-group',
      'activity-paused',
      'activity-stopped',
      'activity-waiting',
      'activity-working-notasks',
      'activity-working-tasks',
      'activity-working-threads',
      'failed-batch-step',
      'failed-stopped',
      'failed-summary',
      'finished-batch',
      'finished-done',
      'finished-plan-waiting',
      'host-down',
      'host-up',
      'needs-you-approval',
      'needs-you-plan',
      'needs-you-question',
      'needs-you-run-skip',
      'needs-you-waiting',
      'stuck'
    ])
  })
  for (const f of fixtures.filter((f) => !f.file.startsWith('activity-'))) {
    it(`alert ${f.file}`, () => {
      expect(notificationPayload(f.input as ApnsNotice)).toEqual(f.payload)
    })
  }
  for (const f of fixtures.filter((f) => f.file.startsWith('activity-'))) {
    it(`activity ${f.file}`, () => {
      const update = f.input as ApnsActivityUpdate
      expect(activityPayload(update, update.ts)).toEqual(f.payload)
    })
  }
})

describe('the rules the fixtures rest on', () => {
  const base: ApnsNotice = { event: 'finished', hostId: 'box', title: 'T', body: 'b', ts: 1_000 }
  it('every alert is mutable, a notice without a host carries no tc.host, one without a thread no category', () => {
    const payload = notificationPayload(base) as { aps: Record<string, unknown>; tc: Record<string, unknown> }
    expect(payload.aps['mutable-content']).toBe(1)
    expect(payload.aps).not.toHaveProperty('category')
    expect(payload.tc).not.toHaveProperty('host')
    expect((notificationPayload({ ...base, hostName: 'mac' }) as { tc: Record<string, unknown> }).tc.host).toBe('mac')
  })
  it('Run now and Skip only on an approval that carries them: any other kind keeps its category', () => {
    const category = (n: Partial<ApnsNotice>) => (notificationPayload({ ...base, threadId: 't', ...n }) as { aps: Record<string, unknown> }).aps.category
    expect(category({ kind: 'approval', choices: 'run-skip' })).toBe('tc.run-skip')
    expect(category({ kind: 'approval' })).toBe('tc.approval')
    expect(category({ kind: 'waiting', choices: 'run-skip' })).toBe('tc.thread')
    expect((notificationPayload({ ...base, threadId: 't', kind: 'approval', choices: 'run-skip' }) as { tc: Record<string, unknown> }).tc).not.toHaveProperty('choices')
  })
  it("a notice of Work's with no thread: the digest is a banner with no sound, an interrupt is time sensitive with sound, both grouped under tc.work and carrying what a tap opens", () => {
    const digest = notificationPayload({ event: 'finished', kind: 'finished', hostId: 'box', environmentId: 'env_box', seq: 0, title: 'Work', body: 'Digest: 9 things in Cosmic, Purdue and Ref', hostName: 'The box', work: { key: 'digest:2026-11-24', digest: '2026-11-24' }, ts: 1_000 })
    expect(digest).toEqual({
      aps: { alert: { title: 'Work', body: 'Digest: 9 things in Cosmic, Purdue and Ref' }, 'thread-id': 'tc.work', 'summary-arg': 'Work', 'interruption-level': 'active', 'relevance-score': 0.4, 'mutable-content': 1 },
      tc: { event: 'finished', hostId: 'box', environmentId: 'env_box', seq: 0, kind: 'finished', host: 'The box', work: { key: 'digest:2026-11-24', digest: '2026-11-24' }, ts: 1_000 }
    })
    const open = { view: 'agenda', workspaceId: 'w1', at: 'ev1' }
    const now = notificationPayload({ event: 'needs_you', kind: 'waiting', hostId: 'box', seq: 0, title: 'Purdue', body: 'Budget review starts at 2:00 PM', work: { key: 'now', tell: 'prep:ev1', by: 9_000, open }, ts: 2_000 })
    expect(now).toEqual({
      aps: { alert: { title: 'Purdue', body: 'Budget review starts at 2:00 PM' }, sound: 'default', 'thread-id': 'tc.work', 'summary-arg': 'Purdue', 'interruption-level': 'time-sensitive', 'relevance-score': 1, 'mutable-content': 1 },
      tc: { event: 'needs_you', hostId: 'box', seq: 0, kind: 'waiting', work: { key: 'now', tell: 'prep:ev1', by: 9_000, open }, ts: 2_000 }
    })
    // no thread, so no category: nothing is decided from the lock screen
    expect((now as { aps: Record<string, unknown> }).aps).not.toHaveProperty('category')
    // a thread's notice is as it was: no tc.work, grouped under its thread
    const thread = notificationPayload({ ...base, threadId: 't' }) as { aps: Record<string, unknown>; tc: Record<string, unknown> }
    expect(thread.tc).not.toHaveProperty('work')
    expect(thread.aps['thread-id']).toBe('t')
  })
  it('a held act carries its item as tc.held and keeps the Open category: no Send from the lock screen', () => {
    const held = { at: 'lifeos' as const, table: 'outbox' as const, id: 'ob_1' }
    const payload = notificationPayload({ ...base, event: 'needs_you', threadId: 't', kind: 'waiting', held }) as { aps: Record<string, unknown>; tc: Record<string, unknown> }
    expect(payload.tc.held).toEqual(held)
    expect(payload.aps.category).toBe('tc.thread')
    expect(notificationPayload(base) as { tc: object }).not.toHaveProperty('tc.held')
  })
  it('a stopped end ranks with waiting and failed; a working update does not', () => {
    const score = (phase: ApnsActivityUpdate['state']['phase'], event: 'update' | 'end' = 'end') =>
      (activityPayload({ threadId: 't', event, state: { phase, since: 1, ts: 2 }, ts: 2 }, 2_000) as { aps: Record<string, number> }).aps['relevance-score']
    expect([score('stopped'), score('failed'), score('waiting')]).toEqual([100, 100, 100])
    expect([score('working', 'update'), score('paused', 'update'), score('finished')]).toEqual([50, 50, 50])
  })
})
