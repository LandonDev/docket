import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { createCollaborationClient, type CollaborationClient } from 'work-kit/collab'
import { createCollabSigner, generateCollabKeys, LIFEOS_COLLAB_AUDIENCE } from 'work-kit/collab-server'
import { check, failed, freePort, note, Proof, rpc, sleep, until, type Inst } from '../../lifeos/proof/harness'

/**
 * Milestone 18's done-when on the built tree, against real LifeOS (a token
 * minted for the proof, one throwaway doc in Life, removed at the end) and a
 * Cloudflare quick tunnel to the instance's own port (never the public one):
 *
 *  1. with Work off the service does not start; on, it does, its socket and
 *     secret where the worker looks;
 *  2. an internal route answers on the socket and is unreachable through
 *     the tunnel, with and without the secret;
 *  3. two editors (one here, one through the tunnel hostname; the second
 *     machine's editor is run by hand, see M18.md) edit one LifeOS document
 *     and converge;
 *  4. the service is killed (SIGKILL) right after an acknowledged keystroke,
 *     restarts, and the keystroke is there;
 *  5. a second instance, told the box serves LifeOS documents, refuses the
 *     document's socket and reads the stored state instead, its own service
 *     on its own port beside the first;
 *  6. Work off stops the service and takes the socket and the secret away.
 *
 * LifeOS's collab tokens are stood in for by a key the proof makes and hands
 * the instance as an isolated instance's LifeOS JWKS (TEMP_CODE_LIFEOS_JWKS):
 * the same verifier path LifeOS's apps will take.
 *
 * Run from the repo root after `electron-vite build`:
 *   env -u ELECTRON_RUN_AS_NODE bun src/main/server/work/service/proof/live.ts <box token file> <second token file> [--wait-mac]
 * Tokens: sudo -n lifeos-deploy run <lifeos checkout> auth:mint '{"ownerId":"landon","name":"m18 proof"}'
 */

const [boxTokenFile, secondTokenFile] = process.argv.slice(2)
const waitMac = process.argv.includes('--wait-mac')
const OUT = '/tmp/m18-proof'
mkdirSync(OUT, { recursive: true })
const ISS = 'https://lifeos.proof/auth'
const proof = new Proof()
const cleanup: (() => Promise<unknown> | unknown)[] = []
const runStart = Date.now()

const internal = (inst: Inst, path: string, body: unknown, secret: string | null): Promise<{ status: number; body: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const req = request({ socketPath: join(inst.data, 'work-service.sock'), path, method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
const secretOf = (inst: Inst): string => readFileSync(join(inst.data, 'work-service.secret'), 'utf8').trim()
const answers = async (port: number): Promise<boolean> => (await fetch(`http://127.0.0.1:${port}/w/hosted/`).catch(() => null))?.status === 200
const listenerPid = (port: number): number | null => {
  const out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' })
  return Number(/pid=(\d+)/.exec(out)?.[1]) || null
}
const fence = { botId: 'm18proof', sectors: ['life'], client: 'tempcode', draftOnly: true }
const synced = (c: CollaborationClient) => c.provider.isSynced && !c.provider.hasUnsyncedChanges
const probe = (c: CollaborationClient) => c.document.getText('probe').toString()

try {
  if (!boxTokenFile || !secondTokenFile) throw new Error('usage: live.ts <box token file> <second token file>')
  const keys = await generateCollabKeys('proof')
  const lifeosSigner = await createCollabSigner({ privateJwk: keys.privateJwk, iss: ISS, aud: LIFEOS_COLLAB_AUDIENCE })
  const jwks = JSON.stringify({ keys: [keys.publicJwk] })
  const boxPort = await freePort()
  const box = await proof.instance('box')
  proof.launch(box, { platform: 'linux', env: { TEMP_CODE_WORK_PORT: String(boxPort), TEMP_CODE_WORK_LIFEOS_SERVER: 'here', TEMP_CODE_LIFEOS_JWKS: jwks, TEMP_CODE_LIFEOS_ISSUER: ISS } })
  if (!check('the box instance is up', await proof.up(box))) throw new Error(proof.logOf(box).slice(-3000))

  // ── 1. off, then on ────────────────────────────────────────────────────
  await sleep(3000)
  check('with Work off the service does not start: no listener, no socket, no secret', !(await answers(boxPort)) && listenerPid(boxPort) === null && !existsSync(join(box.data, 'work-service.sock')) && !existsSync(join(box.data, 'work-service.secret')))
  await rpc(box, 'work.set', { enabled: true })
  check('with Work on the service answers on its port', await until('the service', 60_000, () => answers(boxPort)))
  const firstPid = listenerPid(boxPort)
  check('it is its own process, not main', !!firstPid && firstPid !== box.proc?.pid, `listener ${firstPid}, main ${box.proc?.pid}`)
  check('the socket is 0660 and the secret 0600, in userData', (statSync(join(box.data, 'work-service.sock')).mode & 0o777) === 0o660 && (statSync(join(box.data, 'work-service.secret')).mode & 0o777) === 0o600)

  const signed = await rpc<{ lifeos: { state: string } }>(box, 'work.lifeos.setToken', { token: readFileSync(boxTokenFile, 'utf8').trim() })
  cleanup.push(() => rpc(box, 'work.lifeos.signOut', {}))
  // Each instance with Work on mints a key for its Work Chats: revoke every key made since the run began (or since M18_SINCE, an earlier run's start).
  cleanup.push(async () => {
    const since = Number(process.env.M18_SINCE ?? runStart) - 60_000
    const jwt = (await rpc<{ jwt?: string }>(box, 'work.lifeos.jwt', {})).jwt
    const convex = (kind: string, path: string, args: unknown) =>
      fetch(`https://lifeos.landonhale.com/api/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` }, body: JSON.stringify({ path, args, format: 'json' }) }).then((r) => r.json() as Promise<{ status: string; value?: unknown }>)
    const bots = ((await convex('query', 'bots:list', {})).value ?? []) as { _id: string; name: string; createdAt: number; revokedAt?: number; client?: string }[]
    for (const bot of bots.filter((b) => b.createdAt >= since && b.revokedAt === undefined && b.client === 'tempcode' && b.name.startsWith('TempCode '))) {
      note(`revoked the proof's key "${bot.name}": ${(await convex('mutation', 'bots:revoke', { id: bot._id })).status}`)
    }
  })
  check('the box signed in to LifeOS', await until('connected', 30_000, async () => (await rpc<{ lifeos: { state: string } }>(box, 'work.lifeos.status', {})).lifeos.state === 'connected'), signed.lifeos.state)

  // ── 2. the internal routes ─────────────────────────────────────────────
  const created = await internal(box, '/internal/doc/create', { sector: 'life', title: 'M18 proof (removed at the end)', markdown: '# M18 proof\n\nA throwaway document.', botId: 'm18proof', fence }, secretOf(box))
  check('an internal route answers on the socket with the secret', created.status === 200 && typeof created.body.docId === 'string', JSON.stringify(created))
  const docId = String(created.body.docId)
  cleanup.push(async () => {
    const jwt = (await rpc<{ jwt?: string }>(box, 'work.lifeos.jwt', {})).jwt
    const res = await fetch('https://lifeos.landonhale.com/api/mutation', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` }, body: JSON.stringify({ path: 'docs:remove', args: { id: docId }, format: 'json' }) })
    note(`removed the proof doc ${docId}: ${(await res.json() as { status: string }).status}`)
  })
  check('and refuses it without the secret', (await internal(box, '/internal/doc/read', { docId, fence }, null)).status === 401)

  const cf = join(OUT, 'ingress.yml')
  writeFileSync(cf, `ingress:\n  - path: ^/(g|w|f)/\n    service: http://127.0.0.1:${boxPort}\n  - service: http_status:404\n`)
  const tunnelLog = join(OUT, 'tunnel.log')
  const tunnel = proof.own(spawn('cloudflared', ['tunnel', '--no-autoupdate', '--config', cf, '--url', `http://127.0.0.1:${boxPort}`], { stdio: ['ignore', 'pipe', 'pipe'], detached: true }))
  let tunnelUrl = ''
  const take = (c: Buffer) => (tunnelUrl ||= /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(c.toString())?.[0] ?? '')
  tunnel.stderr?.on('data', take)
  tunnel.stdout?.on('data', take)
  check('a quick tunnel to the instance\'s own port', await until('the tunnel', 60_000, () => !!tunnelUrl))
  await until('the tunnel answers', 60_000, async () => (await fetch(`${tunnelUrl}/w/hosted/`).catch(() => null))?.status === 200)
  writeFileSync(tunnelLog, tunnelUrl)
  for (const auth of [null, secretOf(box)]) {
    for (const path of ['/internal/doc/read', '/w/../internal/doc/read', '/w/%2e%2e/internal/doc/read']) {
      const res = await fetch(`${tunnelUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ docId, fence }) })
      check(`through the tunnel ${path} ${auth ? 'with' : 'without'} the secret is not served`, res.status === 404, String(res.status))
    }
  }

  // ── 3. two editors through the tunnel hostname ─────────────────────────
  const token = async (seconds = 900) => (await lifeosSigner.sign({ doc: docId, role: 'edit', principal: 'owner' }, seconds)).token
  const here = createCollaborationClient({ documentName: docId, token: () => token(), url: `ws://127.0.0.1:${boxPort}/w/doc/${docId}`, offline: false })
  const there = createCollaborationClient({ documentName: docId, token: () => token(), url: `${tunnelUrl.replace('https', 'wss')}/w/doc/${docId}`, offline: false })
  cleanup.push(() => here.destroy(), () => there.destroy())
  check('both editors open the document, one through the tunnel hostname', await until('synced', 60_000, () => synced(here) && synced(there)))
  here.document.getText('probe').insert(0, '[box] ')
  there.document.getText('probe').insert(0, '[tunnel] ')
  check('their edits converge', await until('converged', 30_000, () => probe(here) === probe(there) && probe(here).includes('[box]') && probe(here).includes('[tunnel]')), `${probe(here)} | ${probe(there)}`)
  if (waitMac) {
    // The other machine: its editor gets the address, the document and a token, and writes "[mac]".
    writeFileSync(join(OUT, 'for-mac.json'), JSON.stringify({ url: `${tunnelUrl.replace('https', 'wss')}/w/doc/${docId}`, docId, token: await token(900) }))
    note(`waiting for the other machine's editor: ${join(OUT, 'for-mac.json')}`)
    const came = await until('the other machine wrote', 14 * 60_000, () => probe(here).includes('[mac]'))
    check('an editor on another machine edited through the tunnel hostname and converged', came && (await until('back to the mac', 10_000, () => probe(there).includes('[mac]'))), probe(here))
    writeFileSync(join(OUT, 'box-saw.txt'), probe(here))
  }

  // ── 4. killed after an acknowledged keystroke ──────────────────────────
  for (const ch of '[durable]') here.document.getText('probe').insert(probe(here).length, ch)
  await until('acknowledged', 10_000, () => synced(here))
  const pid = listenerPid(boxPort)!
  process.kill(pid, 'SIGKILL')
  note(`killed the service (${pid}) with the keystrokes acknowledged and no store owed to be done`)
  check('the service is started again', await until('restarted', 60_000, async () => (await answers(boxPort)) && listenerPid(boxPort) !== pid))
  const fresh = createCollaborationClient({ documentName: docId, token: () => token(), url: `ws://127.0.0.1:${boxPort}/w/doc/${docId}`, offline: false })
  cleanup.push(() => fresh.destroy())
  check('the acknowledged keystroke survived the kill', await until('fresh sync', 30_000, () => synced(fresh) && probe(fresh).includes('[durable]')), probe(fresh))
  check('and the open editor reconnected to it', await until('reconnected', 30_000, () => synced(here)))

  // ── 5. a second instance, the box's client ─────────────────────────────
  const boxId = (await rpc<{ environmentId: string }>(box, 'remote.status')).environmentId
  const secondPort = await freePort()
  const second = await proof.instance('second')
  proof.launch(second, { platform: 'darwin', env: { TEMP_CODE_WORK_PORT: String(secondPort), TEMP_CODE_WORK_LIFEOS_SERVER: boxId, TEMP_CODE_LIFEOS_JWKS: jwks, TEMP_CODE_LIFEOS_ISSUER: ISS } })
  check('the second instance is up', await proof.up(second))
  await rpc(second, 'work.set', { enabled: true })
  check('two instances run their services side by side on their own ports', await until('second service', 60_000, () => answers(secondPort)) && (await answers(boxPort)) && listenerPid(secondPort) !== listenerPid(boxPort))
  await rpc(second, 'work.lifeos.setToken', { token: readFileSync(secondTokenFile, 'utf8').trim() })
  cleanup.push(() => rpc(second, 'work.lifeos.signOut', {}))
  check('the second instance signed in to LifeOS', await until('second connected', 30_000, async () => (await rpc<{ lifeos: { state: string } }>(second, 'work.lifeos.status', {})).lifeos.state === 'connected'))
  const refused = createCollaborationClient({ documentName: docId, token: () => token(), url: `ws://127.0.0.1:${secondPort}/w/doc/${docId}`, offline: false })
  cleanup.push(() => refused.destroy())
  await sleep(4000)
  check('asked to serve a LifeOS document while the box serves them, it refuses', !refused.provider.isSynced)
  await until('the box stored', 30_000, async () => (await internal(box, '/internal/doc/read', { docId, fence }, secretOf(box))).body.seq !== 0)
  const stored = await internal(second, '/internal/doc/read', { docId, fence }, secretOf(second))
  check('and reads the stored state instead', stored.status === 200 && stored.body.stored === true && String(stored.body.markdown).includes('M18 proof'), JSON.stringify(stored).slice(0, 300))
  const write = await internal(second, '/internal/doc/write', { docId, markdown: 'x', because: 'asked', botId: 'm18proof', fence }, secretOf(second))
  check('and refuses to write it, naming the box', write.status === 409 && String(write.body.error).includes(boxId), JSON.stringify(write))

  // ── 6. off ─────────────────────────────────────────────────────────────
  const lastPid = listenerPid(boxPort)
  await rpc(box, 'work.set', { enabled: false })
  check('Work off stops the service: no listener, no socket, no secret', await until('stopped', 20_000, () => listenerPid(boxPort) === null && !existsSync(join(box.data, 'work-service.sock')) && !existsSync(join(box.data, 'work-service.secret'))))
  check('and its process is gone', await until('pid gone', 10_000, () => !!lastPid && !existsSync(`/proc/${lastPid}`)))
  await rpc(box, 'work.set', { enabled: true })
  await until('on again for the cleanup', 60_000, () => answers(boxPort))
} catch (err) {
  check('the proof ran to its end', false, (err as Error).stack ?? String(err))
} finally {
  for (const step of cleanup.reverse()) await Promise.resolve(step()).catch((e: Error) => note(`cleanup: ${e.message}`))
  writeFileSync(join(OUT, 'box.log'), proof.instances[0] ? proof.logOf(proof.instances[0]) : '')
  await proof.close()
  console.log(failed() === 0 ? 'ALL PASS' : `${failed()} FAILED`)
  process.exit(failed() === 0 ? 0 : 1)
}
