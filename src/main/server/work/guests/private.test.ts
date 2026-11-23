import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCollaborationClient, type CollaborationClient } from 'work-kit/collab'
import { createCollabSigner, generateCollabKeys, TEMPCODE_COLLAB_AUDIENCE, type CollabSigner } from 'work-kit/collab-server'
import * as Y from 'yjs'
import { servicePaths } from '../service/config'
import { startFakeConvex, type FakeConvex } from '../service/fakeConvex'
import { LIMITS } from '../service/routes/guests'
import { startWorkService, type RunningService } from '../service/serve'
import type { ServiceLink } from '../service/wire'
import { hashSecret } from './store'

/*
 * Agent suggestions stay private (docs/agents/work-docs.md, the owner's ruling of 2026-11-23):
 * on a LifeOS document a guest link shares, an agent's pending suggestion reaches no guest by any
 * route and no other window's live document, until he accepts it.
 */

const SECRET = 'g'.repeat(43)
const DOC = 'kdocp1'
const SUGGESTED = 'Zanzibar budget review'
const LINK_SECRET = 'k'.repeat(43)
const open: { dirs: string[]; services: RunningService[]; convex: FakeConvex[]; clients: CollaborationClient[] } = { dirs: [], services: [], convex: [], clients: [] }

afterEach(async () => {
  LIMITS.requests.clear()
  LIMITS.failures.clear()
  LIMITS.comments.clear()
  await Promise.all(open.clients.splice(0).map((c) => c.destroy()))
  await Promise.all(open.services.splice(0).map((s) => s.stop().catch(() => {})))
  await Promise.all(open.convex.splice(0).map((c) => c.close()))
  for (const d of open.dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const until = async (what: string, ok: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function internal(socketPath: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>
        if ((res.statusCode ?? 500) >= 400) reject(new Error(String(parsed.error ?? res.statusCode)))
        else resolve(parsed)
      })
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

const md = (...lines: string[]) => lines.join('\n\n')

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'doc-private-guest-'))
  open.dirs.push(dir)
  const convex = await startFakeConvex()
  open.convex.push(convex)
  // Shared: a guest link names it, so LifeOS marks its row (guests/links.ts).
  convex.docs.set(DOC, { _id: DOC, sector: 'life', seq: 0, title: 'Run of show', shared: true, markdown: '', plain: '' })
  const keys = await generateCollabKeys('k')
  const signer: CollabSigner = await createCollabSigner({ privateJwk: keys.privateJwk, iss: 'tempcode:env_box' })
  const hosted = join(dir, 'hosted')
  mkdirSync(join(hosted, 'guest'), { recursive: true })
  writeFileSync(join(hosted, 'guest', 'index.html'), '<!doctype html><p>guest page</p>')
  mkdirSync(join(dir, 'data'), { recursive: true })
  const socketPath = servicePaths(join(dir, 'data')).socketPath
  const service = await startWorkService(
    {
      port: 0,
      socketPath,
      secret: SECRET,
      dataDir: join(dir, 'data', 'work-service'),
      hostedDir: hosted,
      host: 'env_box',
      lifeos: { here: true, url: convex.url },
      trusted: [{ by: 'host', iss: 'tempcode:env_box', aud: TEMPCODE_COLLAB_AUDIENCE, keys: [keys.publicJwk] }],
      links: []
    },
    { jwt: async () => 'owner-jwt', log: () => {} }
  )
  open.services.push(service)
  const exp = Date.now() + 60 * 60_000
  // The document's own guest link (edit), and a project's link that lists the document (view), as main sends them.
  const guestToken = (await signer.sign({ doc: DOC, role: 'edit', principal: 'guest:L1', link: 'L1' }, 600)).token
  const guest = (token: string) => ({ secretHash: hashSecret(LINK_SECRET), name: 'Dana Lee', title: 'Run of show', owner: 'Landon Hale', token, tokenExp: exp, keyedAt: 0 })
  service.setLinks([
    { linkId: 'L1', item: { doc: DOC }, role: 'edit', expiresAt: exp, revokedAt: null, guest: guest(guestToken) },
    { linkId: 'P1', item: { project: 'proj1' }, role: 'view', expiresAt: exp, revokedAt: null, guest: guest('') }
  ] as unknown as ServiceLink[])
  service.setProject('P1', {
    projection: {
      project: { id: 'proj1', name: 'Spring event', status: 'active', description: '', docId: null },
      counts: { todo: 0, doing: 0, waiting: 0, done: 0 },
      tasks: [],
      truncated: false,
      docs: [{ id: DOC, title: 'Run of show' }],
      sheets: []
    },
    tokens: {}
  })
  await service.collab.writeMarkdown(DOC, 'owner', md('# Run of show', 'Doors open at 6:00 PM', 'Shadow the front desk'))
  const base = `http://127.0.0.1:${service.port}`
  const connect = (url: string, token: string, more: { schema?: number | null } = {}) => {
    const client = createCollaborationClient({ documentName: DOC, token, url, offline: false, ...more })
    open.clients.push(client)
    return client
  }
  const ownerToken = (await signer.sign({ doc: DOC, role: 'edit', principal: 'owner' }, 600)).token
  return { service, convex, base, guestToken, ownerToken, connect, call: (path: string, body: unknown) => internal(socketPath, path, body) }
}

const stateText = (c: CollaborationClient) => Buffer.from(Y.encodeStateAsUpdate(c.document)).toString('latin1')
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

describe('a styled document over a guest link', () => {
  it("opens for a guest whose page knows the schema, and is refused one whose socket says none; styling a classic one puts the second off it", async () => {
    const r = await rig()
    const socket = `ws://127.0.0.1:${r.service.port}/g/ws/L1`
    // A classic document: both guests are on it.
    const knows = r.connect(socket, r.guestToken)
    const old = r.connect(socket, r.guestToken, { schema: null })
    await until('both synced', () => knows.provider.isSynced && old.provider.isSynced)
    let closed = ''
    old.provider.configuration.websocketProvider.on('close', ({ event }: { event: { reason?: string } }) => (closed ||= String(event.reason ?? 'closed')))
    // He styles it: the service raises it, and the guest that knows less is off it before anything newer is written.
    expect(await r.service.collab.raiseSchema(DOC, 1)).toBe(true)
    await r.service.collab.edit(DOC, 'owner', (doc) => void doc.getMap('page').set('style:Title', { name: 'Title', fontSize: 30 }))
    await until('the old guest closed', () => closed !== '')
    await until('the guest that knows has the style', () => knows.document.getMap('page').has('style:Title'))
    expect(old.document.getMap('page').has('style:Title')).toBe(false)
    // A guest that opens it now, knowing the schema, gets it whole; one that says none gets nothing.
    const late = r.connect(socket, r.guestToken)
    await until('a new guest synced', () => late.provider.isSynced)
    expect(late.document.getMap('page').get('schema')).toBe(1)
    const refused = r.connect(socket, r.guestToken, { schema: null })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(refused.provider.isSynced).toBe(false)
    expect(refused.document.getMap('page').size).toBe(0)
    expect(stateText(refused)).not.toContain('Doors open')
  })
})

describe('a LifeOS document a guest link shares', () => {
  it('shows a guest nothing of a pending agent suggestion on any route, and another window none in its live state, until he accepts it', async () => {
    const r = await rig()
    const said = await r.call('/internal/docs/write', { docId: DOC, markdown: md('# Run of show', 'Doors open at 6:00 PM', `${SUGGESTED} with finance`, 'Shadow the front desk'), because: 'own', principal: 'agent:env_box:t1', fence: { sectors: 'all' } })
    expect(said).toMatchObject({ mode: 'branch', shared: true })

    const guestSocket = r.connect(`ws://127.0.0.1:${r.service.port}/g/ws/L1`, r.guestToken)
    const ownerSocket = r.connect(`ws://127.0.0.1:${r.service.port}/w/doc/${DOC}`, r.ownerToken)
    await until('both synced', () => guestSocket.provider.isSynced && ownerSocket.provider.isSynced)
    for (const c of [guestSocket, ownerSocket]) {
      expect(stateText(c)).toContain('Doors open at 6:00 PM')
      expect(stateText(c)).not.toContain(SUGGESTED)
    }

    // Every route a guest reaches, each answered.
    const auth = { Authorization: `Bearer ${r.guestToken}` }
    const answers: [string, Response][] = [
      ['GET /g/L1', await fetch(`${r.base}/g/L1`)],
      ['POST /g/L1/open', await post(`${r.base}/g/L1/open`, { secret: LINK_SECRET })],
      ['GET /g/L1/threads', await fetch(`${r.base}/g/L1/threads`, { headers: auth })],
      ['POST /g/L1/comment', await post(`${r.base}/g/L1/comment`, { quote: 'Shadow the front desk', text: 'Who covers this?' }, auth)],
      ['POST /g/L1/item', await post(`${r.base}/g/L1/item`, { secret: LINK_SECRET, table: 'docs', id: DOC })],
      ['POST /g/P1/open', await post(`${r.base}/g/P1/open`, { secret: LINK_SECRET })],
      ['POST /g/P1/item', await post(`${r.base}/g/P1/item`, { secret: LINK_SECRET, table: 'docs', id: DOC })]
    ]
    const bodies = Object.fromEntries(await Promise.all(answers.map(async ([what, res]) => [what, `${res.status} ${await res.text()}`] as const)))
    expect(bodies['POST /g/L1/open']).toMatch(/^200 /)
    expect(bodies['POST /g/P1/item']).toMatch(/^200 .*Doors open at 6:00 PM/)
    for (const [what, body] of Object.entries(bodies)) expect(body, what).not.toContain(SUGGESTED)

    // Accepted, it is an ordinary edit: both sockets get it.
    const { branches } = (await r.call('/internal/history/branches', { docId: DOC, fence: { sectors: 'all' } })) as { branches: { id: string; authors: string[] }[] }
    expect(branches.map((b) => b.authors)).toEqual([['agent:env_box:t1']])
    await r.call('/internal/history/decide', { docId: DOC, branchId: branches[0]!.id, which: 'all', accept: true, fence: { sectors: 'all' } })
    await until('the guest has the accepted words', () => stateText(guestSocket).includes(SUGGESTED))
    await until('the other window has them', () => stateText(ownerSocket).includes(SUGGESTED))
  })
})
