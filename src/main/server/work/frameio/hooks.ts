import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Trigger, TriggerSource } from '@shared/work'
import { errorText } from '@shared/work'
import type { WorkCtx } from '../modules'
import { frameioConfig } from './auth'
import { itemsOf, frameioOf, setSetting, setting } from './live'
import { syncComments } from './media'

/**
 * Frame.io's webhooks (docs/agents/work-frameio.md, "Webhooks"): one per
 * Frame.io workspace a routine watches, made when the routine arms, sent to
 * this host's public address (the tunnel's, set in Settings) and answered by
 * a small listener on loopback. Each delivery is signed with the webhook's
 * own secret (HMAC-SHA256 over `v0:<time>:<body>`, five minutes' grace) and
 * carries only ids: the host reads the comment or file it names, keeps any
 * open item showing that file in step, and fires the routines watching it,
 * unless the person did it himself.
 */

export const HOOK_PATH = '/frameio/hook'
export const HOOK_EVENTS = ['comment.created', 'comment.updated', 'comment.deleted', 'comment.completed', 'comment.uncompleted', 'file.versioned']
const GRACE_S = 300
const MAX_BODY = 64 * 1024

/** Whether a delivery is Frame.io's, signed with `secret`, within five minutes of `now` (seconds). */
export function signedBy(secret: string, timestamp: string | undefined, body: string, signature: string | undefined, now = Date.now() / 1000): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > GRACE_S) return false
  const want = Buffer.from(`v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`)
  const got = Buffer.from(signature)
  return got.length === want.length && timingSafeEqual(got, want)
}

export interface HookEvent {
  type: string
  resource: { id: string; type: string }
  account?: { id: string }
  workspace?: { id: string }
  user?: { id: string }
}

interface Watch {
  account: string
  fileId: string
  fire(cause: string): void
}

/** The Work-on stretch's context, for the trigger source, which is handed none. */
let current: WorkCtx | null = null
let receiver: Server | null = null
const watches = new Set<Watch>()
/** a file's group: its version stack, or itself when it stands alone */
const groups = new Map<string, string>()

async function groupOf(ctx: WorkCtx, account: string, fileId: string): Promise<string> {
  const known = groups.get(fileId)
  if (known) return known
  const { api } = frameioOf(ctx)
  const file = await api.file(account, fileId)
  const group = file.parent_id && (await api.isStack(account, file.parent_id)) ? file.parent_id : fileId
  groups.set(fileId, group)
  return group
}

/** Makes sure Frame.io sends this workspace's comment and version events here. */
export async function ensureHook(ctx: WorkCtx, account: string, fileId: string): Promise<void> {
  const base = setting(ctx.db, 'publicUrl')
  if (!base) throw new Error('Frame.io needs this host’s public address for its webhooks')
  const { api } = frameioOf(ctx)
  const file = await api.file(account, fileId)
  if (!file.project_id) throw new Error('Frame.io did not say which project holds the file')
  const ws = (await api.project(account, file.project_id)).workspace_id
  const key = `hook:${account}:${ws}`
  const t = frameioConfig.tokens.read()
  const have = setting(ctx.db, key)
  if (have && t?.hooks?.[have]) return void startReceiver(ctx)
  const made = await api.createWebhook(account, ws, { name: 'TempCode', url: `${base.replace(/\/$/, '')}${HOOK_PATH}`, events: HOOK_EVENTS })
  if (!made.secret) throw new Error('Frame.io made the webhook but sent no secret to check it with')
  const now = frameioConfig.tokens.read()
  if (now) frameioConfig.tokens.write({ ...now, hooks: { ...now.hooks, [made.id]: made.secret } })
  setSetting(ctx.db, key, made.id)
  startReceiver(ctx)
}

/** Forgets every webhook this host made (a new public address, or a sign-out), deleting them in Frame.io where it can. */
export async function dropHooks(ctx: WorkCtx): Promise<void> {
  const rows = ctx.db.prepare(`SELECT key, value FROM work_frameio_settings WHERE key LIKE 'hook:%'`).all() as Array<{ key: string; value: string }>
  for (const r of rows) {
    const account = r.key.split(':')[1]
    await frameioOf(ctx)
      .api.deleteWebhook(account, r.value)
      .catch((err: unknown) => ctx.log(`frameio: webhook ${r.value} was not deleted: ${errorText(err)}`))
    setSetting(ctx.db, r.key, null)
  }
  const t = frameioConfig.tokens.read()
  if (t) frameioConfig.tokens.write({ ...t, hooks: {} })
}

/** What one delivery means: open items in step, and the routines watching its file fired. */
export async function onHook(ctx: WorkCtx, e: HookEvent): Promise<void> {
  const account = e.account?.id
  if (!account) return
  const { api } = frameioOf(ctx)
  let fileId: string | null = null
  let cause = ''
  if (e.type.startsWith('comment.')) {
    if (e.type === 'comment.deleted') {
      // A deleted comment cannot be read; every open item of the account looks again.
      for (const row of itemsOf(ctx.db).filter((r) => r.account === account)) await syncComments(ctx, row.itemId).catch(() => 0)
      return
    }
    const c = await api.comment(account, e.resource.id)
    fileId = c.file_id
    const who = c.owner?.name ?? 'Someone'
    cause = e.type === 'comment.created' ? `${who} commented in Frame.io: “${c.text.slice(0, 120)}”` : e.type === 'comment.completed' ? `${who}’s comment was resolved in Frame.io` : `${who}’s comment changed in Frame.io`
  } else if (e.type === 'file.versioned') {
    fileId = e.resource.id
    cause = 'A new version was added in Frame.io'
  }
  if (!fileId) return
  const group = await groupOf(ctx, account, fileId)
  for (const row of itemsOf(ctx.db).filter((r) => r.account === account && (r.fileIds.includes(fileId!) || r.stackId === group))) {
    await syncComments(ctx, row.itemId).catch((err: unknown) => ctx.log(`frameio: webhook sync: ${errorText(err)}`))
  }
  // "Someone else": the person's own comments and versions fire nothing.
  const me = frameioConfig.tokens.read()?.user?.id
  if (e.user?.id && e.user.id === me) return
  for (const w of watches) {
    if (w.account !== account) continue
    if ((await groupOf(ctx, account, w.fileId).catch(() => w.fileId)) === group) w.fire(cause)
  }
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    req.on('data', (b: Buffer) => {
      size += b.length
      if (size > MAX_BODY) {
        reject(new Error('too large'))
        req.destroy()
      } else parts.push(b)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })

/** The port the receiver listens on: `TEMP_CODE_FRAMEIO_HOOK_PORT`, else 7696, else any free one for an isolated instance. */
export const hookPort = (): number => Number(process.env.TEMP_CODE_FRAMEIO_HOOK_PORT) || (process.env.TEMP_CODE_USER_DATA ? 0 : 7696)

export function startReceiver(ctx: WorkCtx): Server {
  if (receiver) return receiver
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || new URL(req.url ?? '/', 'http://x').pathname !== HOOK_PATH) return void res.writeHead(404).end()
    readBody(req).then(
      (body) => {
        const secrets = Object.values(frameioConfig.tokens.read()?.hooks ?? {})
        const ts = req.headers['x-frameio-request-timestamp']
        const sig = req.headers['x-frameio-signature']
        if (!secrets.some((s) => signedBy(s, String(ts ?? ''), body, typeof sig === 'string' ? sig : undefined))) return void res.writeHead(401).end()
        // Frame.io waits five seconds and retries; answer now and do the work after.
        res.writeHead(200).end()
        let e: HookEvent
        try {
          e = JSON.parse(body) as HookEvent
        } catch {
          return
        }
        void onHook(ctx, e).catch((err: unknown) => ctx.log(`frameio: webhook ${e.type}: ${errorText(err)}`))
      },
      () => res.writeHead(413).end()
    )
  })
  server.on('error', (err) => ctx.log(`frameio: the webhook receiver failed: ${err.message}`))
  server.listen(hookPort(), '127.0.0.1')
  server.unref()
  receiver = server
  return server
}

export function startHooks(ctx: WorkCtx): () => void {
  current = ctx
  if (Object.keys(frameioConfig.tokens.read()?.hooks ?? {}).length) startReceiver(ctx)
  return () => {
    if (current === ctx) current = null
    receiver?.close()
    receiver = null
    groups.clear()
  }
}

type FileTrigger = Extract<Trigger, { on: 'file' }>

/**
 * A routine on a Frame.io file fires when someone else comments on any
 * version of it or adds a version. Armed with no public address, or signed
 * out, it says why it waits.
 */
export const frameioTrigger: TriggerSource<FileTrigger> = {
  on: 'file',
  words: (t) => (t.source.at === 'frameio' ? 'When someone else comments on it or adds a version in Frame.io' : 'When it changes'),
  arm(t, fire) {
    if (t.source.at !== 'frameio') throw new Error('nothing watches files there yet')
    const ctx = current
    if (!ctx) throw new Error('Work is off')
    if (!frameioConfig.tokens.read()) throw new Error('Frame.io is not signed in on this host')
    if (!setting(ctx.db, 'publicUrl')) throw new Error('Frame.io needs this host’s public address for its webhooks')
    const w: Watch = { account: t.source.account, fileId: t.source.fileId, fire }
    watches.add(w)
    void ensureHook(ctx, w.account, w.fileId).catch((err: unknown) => ctx.log(`frameio: the webhook for ${w.fileId}: ${errorText(err)}`))
    return () => void watches.delete(w)
  }
}
