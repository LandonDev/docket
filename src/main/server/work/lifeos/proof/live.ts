import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import type { DatabaseSync } from 'node:sqlite'
import { Links } from '../links'
import { LifeosSession } from '../session'
import { convexTransport } from '../transport'
import { check, failed, freePort, note, Proof, rpc, textOf, until, type Inst } from './harness'

/**
 * Milestone 7's done-when against real LifeOS. One isolated headless
 * instance ("box", linux), signed in with a token minted for this proof
 * (`m07 proof box`, read from a 0600 file and never printed). Its Convex
 * traffic goes through a local forwarding proxy to the real deployment, so
 * the proof can cut it and show the unreachable state; the add-on host
 * reaches LifeOS's MCP worker directly.
 *
 * Every write is in the Life sector and undone at the end. Nothing is sent:
 * the one `send_mail` is a draft-only key's, which LifeOS refuses at its
 * first line, on a draft addressed to the owner's own mailbox. Only counts
 * and sector names are printed, never a row's words.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE bun src/main/server/work/lifeos/proof/live.ts /tmp/m07-live/box.token
 */

const REAL = 'https://lifeos.landonhale.com'
const TOKEN = readFileSync(process.argv[2] ?? '/tmp/m07-live/box.token', 'utf8').trim()
const proof = new Proof()
const SECTORS = ['cosmic', 'hypixel', 'purdue', 'ref', 'unify', 'life']

/** A plain-http forwarder to the real deployment, WebSocket upgrades included; `close()` cuts every socket. */
async function forwarder(port: number): Promise<{ close(): Promise<void> }> {
  const target = new URL(REAL)
  const sockets = new Set<import('node:net').Socket>()
  const server: Server = createServer((req, res) => {
    const out = httpsRequest({ host: target.host, servername: target.host, port: 443, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    out.on('error', () => res.destroy())
    req.pipe(out)
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  server.on('upgrade', (req, socket, head) => {
    const up = tlsConnect({ host: target.host, servername: target.host, port: 443 }, () => {
      const headers = Object.entries({ ...req.headers, host: target.host }).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`)
      if (head.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    sockets.add(up as never)
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
    up.on('close', () => socket.destroy())
  })
  await new Promise<void>((ok) => server.listen(port, '127.0.0.1', ok))
  return {
    close: () =>
      new Promise<void>((ok) => {
        for (const s of sockets) s.destroy()
        server.close(() => ok())
      })
  }
}

type Tool = { content: { type: string; text?: string }[]; isError?: boolean }
const tool = (inst: Inst, sessionId: string, name: string, args: Record<string, unknown> = {}) => rpc<Tool>(inst, 'app.addonCall', { sessionId, tool: `lifeos__${name}`, arguments: args })
const json = <T>(r: Tool): T => JSON.parse(textOf(r)) as T
interface Status {
  lifeos: { state: string; ownerId?: string }
  keys: { workspaceId: string; sectors: string[]; state: string; addonId?: string; error?: string }[]
}
const status = (inst: Inst) => rpc<Status>(inst, 'work.lifeos.status', {})
/** The sectors a list of rows sits in, counted. */
const sectorsOf = (rows: { sector?: string }[]): Record<string, number> => rows.reduce<Record<string, number>>((m, r) => ((m[r.sector ?? '?'] = (m[r.sector ?? '?'] ?? 0) + 1), m), {})

const cleanup: (() => Promise<unknown>)[] = []
let proxy: { close(): Promise<void> } | null = null
try {
  const port = await freePort()
  proxy = await forwarder(port)
  const local = `http://127.0.0.1:${port}`
  const box = await proof.instance('box')
  proof.launch(box, { platform: 'linux', env: { TEMP_CODE_LIFEOS_URL: local } })
  if (!check('the instance is up', await proof.up(box))) throw new Error(box.log)
  await rpc(box, 'work.set', { enabled: true })

  // ── sign in ───────────────────────────────────────────────────────────
  const signed = await rpc<Status>(box, 'work.lifeos.setToken', { token: TOKEN })
  check('signed in with the minted token: connected as the owner', signed.lifeos.state === 'connected' && signed.lifeos.ownerId === 'landon', JSON.stringify(signed.lifeos))
  cleanup.push(() => rpc(box, 'work.lifeos.signOut', {}))

  // ── link: a Work workspace for Life ───────────────────────────────────
  const life = await rpc<{ id: string }>(box, 'workspace.create', { kind: 'work', sector: 'life', name: 'Life (m07 proof)' })
  const ready = await until('both keys ready', 90_000, async () => {
    const s = await status(box)
    return ['~work', life.id].every((id) => s.keys.find((k) => k.workspaceId === id)?.state === 'ready')
  })
  const keys = (await status(box)).keys
  check('linking the workspace minted its key, and the Work Chats got theirs', ready, JSON.stringify(keys))
  const addonOf = (id: string) => keys.find((k) => k.workspaceId === id)?.addonId ?? ''
  const addonsReady = await until('add-ons ready', 60_000, async () => {
    const l = await rpc<{ status: Record<string, { state: string }> }>(box, 'addons.list', {})
    return l.status[addonOf(life.id)]?.state === 'ready' && l.status[addonOf('~work')]?.state === 'ready'
  })
  check("both LifeOS rows are ready on the box's add-on host", addonsReady)

  // ── a Work thread of Life reads Life only, drafts in Life, cannot send ─
  const thread = await rpc<{ id: string; scope?: string }>(box, 'session.create', { provider: 'claude', workspaceId: life.id, threadType: 'chat', permission: 'auto', title: 'm07 proof: Life' })
  check('the thread is a Work thread of the Life workspace', thread.scope === 'work')
  const guide = json<{ you: string; sectors?: string[]; draftOnly?: boolean }>(await tool(box, thread.id, 'get_guide'))
  check("its key, as LifeOS reads it: held to life, draft-only, named for this host and workspace", JSON.stringify(guide.sectors) === '["life"]' && guide.draftOnly === true && guide.you.startsWith('TempCode '), JSON.stringify({ sectors: guide.sectors, draftOnly: guide.draftOnly }))
  const tasks = json<{ sector?: string }[] | { tasks: { sector?: string }[] }>(await tool(box, thread.id, 'list_tasks', { limit: 100 }))
  const taskRows = Array.isArray(tasks) ? tasks : (tasks.tasks ?? [])
  const bySector = sectorsOf(taskRows)
  note(`list_tasks through the key: ${taskRows.length} rows, by sector ${JSON.stringify(bySector)}`)
  check('every task it reads is in Life', taskRows.length > 0 && Object.keys(bySector).every((s) => s === 'life'), JSON.stringify(bySector))
  const others: Record<string, number> = {}
  for (const s of SECTORS.filter((x) => x !== 'life')) {
    const r = await tool(box, thread.id, 'list_tasks', { sector: s, limit: 5 })
    const rows = r.isError ? [] : ((x) => (Array.isArray(x) ? x : (x.tasks ?? [])))(json<{ sector?: string }[] | { tasks: { sector?: string }[] }>(r))
    others[s] = rows.length
  }
  check('asked for each other sector, it reads none', Object.values(others).every((n) => n === 0), JSON.stringify(others))

  const accounts = json<{ id: string; address: string; sector?: string }[]>(await tool(box, thread.id, 'list_mail_accounts'))
  const mine = accounts.find((a) => a.sector === 'life')
  if (!check('a Life mailbox to draft in', !!mine)) throw new Error('no Life mailbox')
  const drafted = await tool(box, thread.id, 'draft_mail', { account_id: mine!.id, to: [{ address: mine!.address }], subject: 'm07 proof draft (deleted at once)', body: 'A test draft from TempCode milestone 7. It is deleted at once.', reason: 'm07 proof: a draft from a Work thread' })
  const draftId = drafted.isError ? '' : json<{ id: string }>(drafted).id
  check('the Work thread drafted a mail', !!draftId, textOf(drafted))
  if (draftId) cleanup.unshift(() => tool(box, thread.id, 'delete_mail_draft', { id: draftId, reason: 'm07 proof: cleanup' }))
  const jwtAll = await rpc<{ ok: boolean; jwt?: string }>(box, 'work.lifeos.jwt', {})
  const owner = new ConvexHttpClient(REAL, { logger: false })
  owner.setAuth(jwtAll.jwt!)
  const drafts = (await owner.query(makeFunctionReference<'query'>('compose:list'), { view: 'drafts' })) as { _id: string; sector?: string; botId?: string }[]
  const row = drafts.find((d) => d._id === draftId)
  check("the draft is in LifeOS, in the workspace's sector", row?.sector === 'life', JSON.stringify(row ? { sector: row.sector } : null))
  const sent = await tool(box, thread.id, 'send_mail', { draft_id: draftId, reason: 'm07 proof: this must be refused' })
  check('send_mail through the key is refused', sent.isError === true && /draft/i.test(textOf(sent)), textOf(sent).slice(0, 200))
  note(`the refusal reads: ${textOf(sent).slice(0, 160)}`)

  // ── a Work Chat reads every sector and still cannot send ──────────────
  const chat = await rpc<{ id: string; scope?: string; workspaceId?: string | null }>(box, 'session.create', { provider: 'claude', scope: 'work', workspaceId: null, threadType: 'chat', permission: 'auto', title: 'm07 proof: a Work Chat' })
  const chatGuide = json<{ sectors?: string[]; draftOnly?: boolean }>(await tool(box, chat.id, 'get_guide'))
  check('a Work Chat\'s key holds every sector, draft-only', SECTORS.every((s) => chatGuide.sectors?.includes(s)) && chatGuide.draftOnly === true, JSON.stringify(chatGuide.sectors))
  const chatSent = await tool(box, chat.id, 'send_mail', { draft_id: draftId, reason: 'm07 proof: this must be refused' })
  check('send_mail from a Work Chat is refused', chatSent.isError === true && /draft/i.test(textOf(chatSent)), textOf(chatSent).slice(0, 200))

  // ── the screen's JWT, narrowed to Purdue ─────────────────────────────
  const purdue = await rpc<{ ok: boolean; jwt?: string; expiresAt?: number }>(box, 'work.lifeos.jwt', { sector: 'purdue' })
  const narrowed = new ConvexHttpClient(REAL, { logger: false })
  narrowed.setAuth(purdue.jwt!)
  const caller = (await narrowed.query(makeFunctionReference<'query'>('auth:caller'), {})) as { sectors: string[] | 'all' }
  check("work.lifeos.jwt('purdue') is narrowed to purdue", JSON.stringify(caller.sectors) === '["purdue"]', JSON.stringify(caller.sectors))
  const purdueTasks = (await narrowed.query(makeFunctionReference<'query'>('tasks:list'), {})) as { sector: string }[]
  const lifeTasks = (await narrowed.query(makeFunctionReference<'query'>('tasks:list'), { sector: 'life' })) as { sector: string }[]
  note(`tasks through the Purdue JWT: ${purdueTasks.length}, by sector ${JSON.stringify(sectorsOf(purdueTasks))}; asked for Life: ${lifeTasks.length}`)
  check('it reads only Purdue rows, and none of Life', purdueTasks.every((t) => t.sector === 'purdue') && lifeTasks.length === 0)

  // ── a thread made with a task chip, and its link ──────────────────────
  const added = await tool(box, thread.id, 'add_task', { sector: 'life', title: 'm07 proof task (dropped at once)', reason: 'm07 proof: a task to link a thread to' })
  const taskId = added.isError ? '' : (json<{ id: string }>(added).id ?? '')
  check('a Life task to link to', !!taskId, textOf(added).slice(0, 200))
  if (taskId) cleanup.unshift(() => tool(box, thread.id, 'drop_tasks', { ids: [taskId], reason: 'm07 proof: cleanup' }))
  const chipped = await rpc<{ id: string }>(box, 'session.create', {
    provider: 'claude',
    workspaceId: life.id,
    threadType: 'chat',
    permission: 'auto',
    title: 'm07 proof: about a task',
    about: { kind: 'task', label: 'm07 proof task', ref: { at: 'lifeos', table: 'tasks', id: taskId } }
  })
  check('a thread with a task chip is created', !!chipped.id)
  let linksLive = true
  try {
    await owner.query(makeFunctionReference<'query'>('workLinks:byThread'), { threadId: chipped.id })
  } catch (err) {
    linksLive = false
    note(`LifeOS has no workLinks functions yet (milestone 4): ${(err as Error).message.split('\n')[0]!.slice(0, 120)}`)
  }
  if (linksLive) {
    const linked = await until('the link lands', 30_000, async () => ((await owner.query(makeFunctionReference<'query'>('workLinks:byThread'), { threadId: chipped.id })) as unknown[]).length === 1)
    check('the thread has its workLinks row', linked)
    // completeFor is called by the milestones that accept a result (10, 14, 25); here the real session and links code calls it in process, as the host would.
    const hostId = (await rpc<{ environmentId: string }>(box, 'remote.status')).environmentId
    let held: { v: 1; token: string; url: string; at: number } | null = { v: 1, token: TOKEN, url: REAL, at: Date.now() }
    const session = new LifeosSession({ transport: convexTransport(REAL, () => {}), tokens: { read: () => held, write: (d) => void (held = d), clear: () => void (held = null) }, url: REAL, host: hostId, hostName: () => 'm07 proof', log: () => {} })
    session.start()
    check('the real session code connects in process', await until('in-process session', 30_000, () => session.connected()))
    const links = new Links({ db: {} as DatabaseSync, host: hostId, owner: () => session.owner(), log: () => {} })
    const before = await links.forThread(chipped.id, session.owner())
    check('forThread reads the link back', before.length === 1 && before[0]!.entity.id === taskId && before[0]!.state === 'open' && before[0]!.sector === 'life', JSON.stringify(before.map((l) => ({ sector: l.sector, state: l.state, host: l.host === hostId }))))
    await links.completeFor(chipped.id, 'm07 proof: the thread finished its task', session.owner())
    const done = (await owner.query(makeFunctionReference<'query'>('tasks:list'), { sector: 'life', statuses: ['done'] })) as { _id: string; status: string; completion?: { reason?: string; threadLink?: { host: string; threadId: string } } }[]
    const closed = done.find((t) => t._id === taskId)
    check('completeFor completed the task with the reason and the thread link', closed?.status === 'done' && closed.completion?.reason === 'm07 proof: the thread finished its task' && closed.completion.threadLink?.threadId === chipped.id && closed.completion.threadLink.host === hostId, JSON.stringify(closed ? { status: closed.status, completion: !!closed.completion } : null))
    check("the link reads done", (await links.forThread(chipped.id, session.owner()))[0]?.state === 'done')
    session.stop()
    cleanup.unshift(() => tool(box, thread.id, 'reopen_tasks', { ids: [taskId], reason: 'm07 proof: cleanup' }))
  } else note('NOT PROVEN here: the workLinks row and completeFor wait for milestone 4 to deploy')

  // ── unreachable ───────────────────────────────────────────────────────
  await proxy.close()
  proxy = null
  const down = await until('unreachable', 90_000, async () => (await status(box)).lifeos.state === 'unreachable')
  check('with LifeOS cut off the host reads unreachable', down, JSON.stringify((await status(box)).lifeos))
  const deadJwt = await rpc<{ ok: boolean; state?: string }>(box, 'work.lifeos.jwt', { sector: 'life' })
  check('the JWT answer is a typed unreachable', deadJwt.ok === false && deadJwt.state === 'unreachable', JSON.stringify(deadJwt))
  const offThread = await rpc<{ id: string }>(box, 'session.create', {
    provider: 'claude',
    workspaceId: life.id,
    threadType: 'chat',
    permission: 'auto',
    title: 'm07 proof: started while LifeOS is away',
    about: { kind: 'task', label: 'm07 proof task', ref: { at: 'lifeos', table: 'tasks', id: taskId } }
  })
  check('a thread with a chip still starts', !!offThread.id)
  proxy = await forwarder(port)
  check('LifeOS back: connected again', await until('connected', 120_000, async () => (await status(box)).lifeos.state === 'connected'))
  if (linksLive) check('the link asked for while LifeOS was away landed once it was back', await until('queued link', 30_000, async () => ((await owner.query(makeFunctionReference<'query'>('workLinks:byThread'), { threadId: offThread.id })) as unknown[]).length === 1))

  // ── cleanup (the sign-out last), then the keys are retired from the shell ──
  const signOut = cleanup.pop()!
  for (const step of cleanup.splice(0)) await step().catch((err) => note(`cleanup: ${(err as Error).message}`))
  cleanup.push(signOut)
  const draftsAfter = (await owner.query(makeFunctionReference<'query'>('compose:list'), { view: 'drafts' })) as { _id: string }[]
  check('the proof draft is gone', !draftsAfter.some((d) => d._id === draftId))
  // A workspace deleted: the host itself revokes its key in LifeOS on the next pass.
  const liveBots = async () => ((await owner.query(makeFunctionReference<'query'>('bots:list'), {})) as { name: string; revokedAt?: number }[]).filter((b) => b.revokedAt === undefined && b.name.startsWith('TempCode '))
  const lifeKey = guide.you
  await rpc(box, 'workspace.delete', { workspaceId: life.id })
  check("deleting the workspace revoked its key in LifeOS", await until('key revoked', 60_000, async () => !(await liveBots()).some((b) => b.name === lifeKey)))
  check("the Work Chats' key is still live (retired from the shell after)", (await liveBots()).some((b) => b.name.includes('Work Cha')))
} catch (err) {
  check('the proof ran to the end', false, (err as Error).stack ?? String(err))
} finally {
  for (const step of cleanup.splice(0)) await step().catch(() => {})
  await proxy?.close()
  await proof.close(true)
}
console.log(failed() ? `${failed()} FAILED` : 'ALL PASS')
process.exit(failed() ? 1 : 0)
