import type { OutboxItem } from '../src/shared/contract-work-outbox'
import { ownMailbox, PREFIX, Run, sleep, textOf } from './e2e-work-lib'

/**
 * Job 1 (milestone 49): morning triage → held drafts → the owner's batch.
 *
 * A Work thread of his own mailbox's sector reads the morning's mail, files a
 * task and drafts three replies to his own address. All three wait in the
 * Outbox; the thread's key cannot send any. The owner ticks the three in the
 * Outbox window (the batch), then sends one and discards two from the wire,
 * as the window's Send and Discard do. With E2E_SEND=1 the one is really sent
 * (one mail to himself, the most a run may send); without it, it is discarded
 * too. Everything named `E2E-49` is taken away at the end.
 */
const run = new Run('triage')
const SEND = process.env.E2E_SEND === '1'
let sentId: string | null = null
try {
  await run.start()
  await run.signIn('triage')
  const box = await ownMailbox(run)
  const sector = box.defaultSector
  const ws = await run.workspace(sector, `${PREFIX} triage`)
  const thread = await run.thread(ws, `${PREFIX} morning triage`, { firstMessage: 'Triage my morning mail.' })

  // The agent reads the morning.
  const guide = await run.addon(thread, 'get_guide')
  run.check(`the thread's key reads ${sector} only, draft-only`, new RegExp(`"sectors":\\s*\\[\\s*"${sector}"\\s*\\]`).test(textOf(guide)) && /"draftOnly":\s*true/.test(textOf(guide)), textOf(guide).slice(0, 300))
  const list = await run.addon(thread, 'list_mail', { box: 'inbox', limit: 10 })
  run.check("the thread reads its sector's inbox", !list.isError, textOf(list).slice(0, 200))

  // A task from the triage.
  const task = JSON.parse(textOf(await run.addon(thread, 'add_task', { sector, title: `${PREFIX} Follow up on the morning mail`, reason: 'E2E-49 triage proof: removed at the end', key: `e2e49-${Date.now()}` }))) as { id: string }
  run.check('the thread filed a task', !!task.id)
  run.later('drop the task', () => run.addon(thread, 'drop_tasks', { ids: [task.id], reason: 'E2E-49 triage proof: cleanup' }))

  // Three replies, drafted to himself.
  const drafts: string[] = []
  for (const n of [1, 2, 3]) {
    const d = await run.addon(thread, 'draft_mail', {
      account_id: box._id,
      to: [{ address: box.address }],
      subject: `${PREFIX} triage reply ${n}`,
      body: `A test reply from TempCode's end-to-end proof (${n} of 3), to myself. Please ignore it.`,
      reason: 'E2E-49 triage proof: a draft to himself, discarded or sent to himself'
    })
    if (!run.check(`the thread drafted reply ${n}`, !d.isError, textOf(d).slice(0, 200))) continue
    const parsed = JSON.parse(textOf(d)) as { id?: string; draftId?: string }
    drafts.push((parsed.id ?? parsed.draftId)!)
  }
  run.later('discard the unsent drafts', async () => {
    for (const id of drafts.filter((d) => d !== sentId)) await run.mutation('compose:discard', { id }).catch(() => null)
  })
  const origin = await run.query<{ row: { origin?: { threadId?: string } } }>('compose:get', { id: drafts[0] })
  run.check("the host stamped the thread's origin on the draft", origin.row.origin?.threadId === thread)
  const held = (): Promise<OutboxItem[]> => run.call<{ items: OutboxItem[] }>('work.outbox.list', {}).then((l) => l.items.filter((i) => i.kind === 'mail.send' && drafts.includes(String((i.ref as { id?: string }).id))))
  run.check('all three wait in the Outbox', await run.until('three held', 60_000, async () => (await held()).length === 3))
  const refused = await run.addon(thread, 'send_mail', { draft_id: drafts[0], reason: 'E2E-49: must be refused' })
  run.check("the thread's key cannot send one", refused.isError === true, textOf(refused).slice(0, 160))

  // The window: the Outbox with the three, ticked as a batch.
  await run.page(`(() => { const el = [...document.querySelectorAll('button, a, [role=button], [role=link]')].find((e) => /^Outbox\\d*$/.test(e.textContent.trim())); el?.click(); return !!el })()`)
  run.check('the Outbox lists the three', await run.until('rows', 30_000, async () => (await run.has(`${PREFIX} triage reply 1`)) && (await run.has(`${PREFIX} triage reply 3`))))
  run.check("the window offers the three as one batch (the group's Send 3)", await run.page<boolean>(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Send 3')`))
  await run.shot('01-outbox-batch', { hide: box.address })

  // The owner's press: one sent (to himself) or discarded, the other two discarded.
  const items = await held()
  const first = items.find((i) => (i.ref as { id?: string }).id === drafts[0])!
  if (SEND) {
    const went = await run.call<OutboxItem>('work.outbox.send', { ref: first.ref, rev: first.updatedAt })
    sentId = drafts[0]!
    run.check('his Send took the first', ['sending', 'sent'].includes(went.state), went.state)
    const row = await run.until('sent', 180_000, async () => (await run.query<{ row: { status: string } }>('compose:get', { id: drafts[0] })).row.status === 'sent')
    const after = await run.query<{ row: { status: string; cause?: string; message: { to: { address: string }[] } } }>('compose:get', { id: drafts[0] })
    run.check('LifeOS sent it, as his press, to his own address only', row && after.row.cause === 'press' && after.row.message.to.every((a) => a.address === box.address), JSON.stringify({ status: after.row.status, cause: after.row.cause }))
  } else run.note('E2E_SEND is not set: nothing is sent; all three are discarded')
  for (const item of items.filter((i) => (i.ref as { id?: string }).id !== sentId)) await run.call('work.outbox.discard', { ref: item.ref })
  const decided = await run.call<{ items: OutboxItem[] }>('work.outbox.list', { show: 'all' })
  const mine = decided.items.filter((i) => drafts.includes(String((i.ref as { id?: string }).id)))
  run.check('each is decided by the owner', mine.length === 3 && mine.every((i) => i.decidedBy === 'owner' && (i.state === 'discarded' || (SEND && i.state === 'sent'))), JSON.stringify(mine.map((i) => [i.state, i.decidedBy])))
  for (const id of drafts.filter((d) => d !== sentId)) {
    const r = await run.query<{ row: { status: string } } | null>('compose:get', { id }).catch(() => null)
    run.check(`LifeOS holds ${id.slice(-6)} as not sent`, !r || r.row.status !== 'sent', r?.row.status ?? 'gone')
  }
  await sleep(1500)
  await run.shot('02-outbox-decided', { hide: box.address })
} catch (err) {
  await run.finish(err)
}
await run.finish()
