import type { OutboxItem } from '../contract-work-outbox'

/**
 * One Outbox, every state, for the tests that hold the rail's count (the host's `waiting`), Today's rows, the
 * digest's tells and the phone's to one number (shared/work/outboxCount.ts).
 */
const base = (n: number, over: Partial<OutboxItem>): OutboxItem => ({
  ref: { at: 'host', id: `ha_${n}` },
  kind: 'teams.post',
  workspaceId: 'ws-purdue',
  sessionId: 't-work',
  sector: 'purdue',
  summary: `Post ${n}`,
  verb: 'Post',
  account: null,
  state: 'held',
  payload: { chat: 'General', text: `hi ${n}` },
  createdAt: 1_000 + n,
  decidedBy: null,
  decidedAt: null,
  n,
  why: 'pillar',
  grantId: null,
  error: null,
  result: null,
  routineRunId: null,
  updatedAt: 1_000 + n,
  ...over
})

export const COUNT_FIXTURE: OutboxItem[] = [
  base(1, {}),
  base(2, { state: 'live' }),
  base(3, { state: 'failed', error: 'Teams did not answer' }),
  base(4, { state: 'stale', error: 'The chat moved' }),
  base(5, { state: 'stale', error: 'The chat moved', dismissedAt: 2_000 }),
  base(6, { state: 'sending' }),
  base(7, { ref: { at: 'lifeos', table: 'outbox', id: 'o7' }, kind: 'mail.send', n: null, state: 'sending', scheduledFor: 9_000 }),
  base(8, { ref: { at: 'lifeos', table: 'outbox', id: 'o8' }, kind: 'mail.send', n: null }),
  base(9, { state: 'sent' }),
  base(10, { state: 'discarded' })
]
/** held, live, failed, out of date, and the LifeOS draft */
export const COUNT_FIXTURE_WAITS = 5
