/**
 * Milestone 46's work set (scripts/ios-sim-proof.sh `work`): a host with
 * Work on, two Work workspaces with a thread each, an add-on whose
 * `send_mail` the owner holds (the fake MCP server, which only records it),
 * and held acts written into the hold as `ctx.held.create` writes them: a
 * mail, a post, and a send that failed. Everything but the held rows goes
 * over the admin key's own socket, as a phone or desktop would ask.
 * `verifyWork` reads back what the phone's presses did.
 */
import { resolve } from 'node:path'

type Answer = { ok: boolean; result?: unknown; error?: string }
export type WorkSeedReady = { baseUrl: string; controlUrl: string; adminKey: string }

async function socket(ready: WorkSeedReady): Promise<{ call: <T>(method: string, params?: unknown) => Promise<T>; close: () => void }> {
  const res = await fetch(`${ready.baseUrl}/api/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${ready.adminKey}` } })
  const { ticket } = (await res.json()) as { ticket: string }
  const ws = new WebSocket(`${ready.baseUrl.replace(/^http/, 'ws')}/ws?ticket=${ticket}`)
  const waiting = new Map<string, (a: Answer) => void>()
  let hello: (() => void) | null = null
  const helloSeen = new Promise<void>((r) => (hello = r))
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data)) as { id?: string; push?: string; ok?: boolean; result?: unknown; error?: string }
    if (frame.push === 'hello') hello?.()
    if (frame.id && waiting.has(frame.id)) {
      waiting.get(frame.id)!({ ok: !!frame.ok, result: frame.result, error: frame.error })
      waiting.delete(frame.id)
    }
  })
  await new Promise<void>((ok, bad) => {
    ws.addEventListener('open', () => ok())
    ws.addEventListener('error', () => bad(new Error('work seed: the admin socket failed')))
  })
  await helloSeen
  let next = 1
  const call = <T>(method: string, params: unknown = {}): Promise<T> =>
    new Promise((ok, bad) => {
      const id = `w${next++}`
      const timer = setTimeout(() => bad(new Error(`timeout: ${method}`)), 60_000)
      waiting.set(id, (a) => {
        clearTimeout(timer)
        if (a.ok) ok(a.result as T)
        else bad(new Error(`${method}: ${a.error}`))
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { call, close: () => ws.close() }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const WORK_MAIL_ID = 'm46-mail'
export const WORK_MAIL_SUBJECT = 'Ballroom for April 10'
/** What the work set's edit writes over the subject, read back by `verifyWork`. */
export const WORK_MAIL_EDITED = 'Ballroom for Saturday, April 10'

/** The Work thread the transcript and Results shots open (TC_TEST_THREAD). */
export const WORK_THREAD_TITLE = 'Venue for the spring LAN'

export async function seedWork(ready: WorkSeedReady, repo: string): Promise<{ purdue: string; unify: string; addonId: string }> {
  const s = await socket(ready)
  try {
    await s.call('work.set', { enabled: true })
    const purdue = await s.call<{ id: string }>('workspace.create', { kind: 'work', name: 'Purdue Esports', sector: 'purdue' })
    const unify = await s.call<{ id: string }>('workspace.create', { kind: 'work', name: 'Unify', sector: 'unify' })
    const t1 = await s.call<{ id: string }>('session.create', { scope: 'work', workspaceId: purdue.id, threadType: 'chat', provider: 'claude', model: 'claude-opus-5-5', title: 'Venue for the spring LAN' })
    const t2 = await s.call<{ id: string }>('session.create', { scope: 'work', workspaceId: unify.id, threadType: 'chat', provider: 'claude', model: 'claude-opus-5-5', title: 'Overdue invoices' })
    const fake = resolve(repo, 'scripts/lib/fakeMcpServer.ts')
    const { addon } = await s.call<{ addon: { id: string } }>('addons.set', {
      addon: { name: 'purdue-mail', workspaceId: purdue.id, description: 'Purdue mail', spec: { transport: 'stdio', command: process.execPath, args: [fake, '--stdio', '--mail'], env: [], auth: 'none' } }
    })
    for (let i = 0; i < 120; i++) {
      const listed = await s.call<{ tools: unknown[] }>('addons.tools', { id: addon.id }).catch((err: unknown) => { if (i % 20 === 19) console.error(`work seed: ${String(err)}`); return { tools: [] } })
      if (listed.tools.length > 0) break
      await sleep(500)
    }
    await s.call('work.outbox.setRules', { addonId: addon.id, rules: { send_mail: 'held', echo: 'held' } })
    const now = Date.now()
    const rows = [
      {
        id: WORK_MAIL_ID,
        workspaceId: purdue.id,
        sessionId: t1.id,
        sector: 'purdue',
        kind: 'addon.call',
        summary: 'Send to events booking',
        verb: 'Send',
        createdAt: now - 20 * 60_000,
        payload: {
          addonId: addon.id,
          addon: 'Purdue mail',
          tool: 'send_mail',
          words: 'Send mail',
          arguments: {
            to: 'events@purdue.edu',
            subject: WORK_MAIL_SUBJECT,
            text: 'Hello,\n\nI’d like to hold the ballroom on Saturday, April 10 from 9:00 AM to 6:00 PM for a student esports LAN of about 120 people. Could you confirm it is free and send the booking form?\n\nThanks,\nLandon'
          }
        }
      },
      {
        id: 'm46-post',
        workspaceId: purdue.id,
        sessionId: t1.id,
        sector: 'purdue',
        kind: 'addon.call',
        summary: 'Post in Esports staff',
        verb: 'Post',
        createdAt: now - 40 * 60_000,
        payload: { addonId: addon.id, addon: 'Purdue mail', tool: 'echo', words: 'Echo', arguments: { text: 'Spring LAN is set for April 10.' } }
      },
      {
        id: 'm46-failed',
        workspaceId: unify.id,
        sessionId: t2.id,
        sector: 'unify',
        kind: 'addon.call',
        summary: 'Send to Rivera Dental',
        verb: 'Send',
        state: 'failed',
        error: 'The add-on is no longer on this host.',
        createdAt: now - 60 * 60_000,
        payload: { addonId: 'billing-gone', addon: 'Billing desk', tool: 'send_mail', words: 'Send mail', arguments: { to: 'office@riveradental.com', subject: 'Invoice 1042 is 14 days past due', text: 'A reminder that invoice 1042 for $1,850.00 was due on November 4.' } }
      }
    ]
    // The post's held call in the thread's transcript, and two Results the thread wrote (one with a way back).
    const transcript = [{ sessionId: t1.id, heldId: 'm46-post', tool: 'mcp__app__purdue-mail__echo' }]
    const results = [
      { id: 'm46-r1', sessionId: t1.id, workspaceId: purdue.id, kind: 'cells', summary: 'Added Dietary needs', account: 'Spring LAN registration', undo: { pillar: 'forms', verb: 'remove_field', args: { id: 'f1' } } },
      { id: 'm46-r2', sessionId: t1.id, workspaceId: purdue.id, kind: 'doc', summary: 'Changed the date to April 10', account: 'LAN poster' }
    ]
    const written = await fetch(`${ready.controlUrl}/work-held`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows, transcript, results }) })
    if (!written.ok) throw new Error(`work seed: /work-held answered ${written.status}: ${await written.text()}`)
    return { purdue: purdue.id, unify: unify.id, addonId: addon.id }
  } finally {
    s.close()
  }
}

/** What the host holds after the phone's presses: the mail sent as edited, and what still waits. */
export async function verifyWork(ready: WorkSeedReady): Promise<string[]> {
  const s = await socket(ready)
  try {
    const lines: string[] = []
    const mail = await s.call<{ state: string; payload: { arguments?: { subject?: string } }; decidedBy: string | null; result: { summary: string } | null }>('work.outbox.get', { ref: { at: 'host', id: WORK_MAIL_ID } })
    const subject = mail.payload.arguments?.subject
    lines.push(`${mail.state === 'sent' ? 'PASS' : 'FAIL'} the held mail was sent from the phone (state ${mail.state}, decided by ${mail.decidedBy ?? 'nobody'}${mail.result ? `, "${mail.result.summary}"` : ''})`)
    lines.push(`${subject === WORK_MAIL_EDITED ? 'PASS' : 'FAIL'} what went is the phone's edit (subject "${subject}")`)
    const post = await s.call<{ state: string; grantId: string | null }>('work.outbox.get', { ref: { at: 'host', id: 'm46-post' } })
    const grants = await s.call<{ grants: { label: string }[] }>('work.outbox.grants', {})
    lines.push(`${grants.grants.length > 0 ? 'PASS' : 'FAIL'} a grant was made from the post's Send menu (${grants.grants.map((g) => `"${g.label}"`).join(', ') || 'none'})`)
    lines.push(`${post.state === 'sent' ? 'PASS' : 'FAIL'} the post went after its grant (state ${post.state})`)
    const waiting = await s.call<{ waiting: number }>('work.outbox.list', {})
    lines.push(`INFO ${waiting.waiting} still wait`)
    const away = await s.call<{ state: { enabled: boolean } }>('away.get', {})
    lines.push(`${away.state.enabled ? 'FAIL' : 'PASS'} Away is off after the phone's cycle`)
    return lines
  } finally {
    s.close()
  }
}
