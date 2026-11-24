/**
 * The stand-ins the PC setup proof talks to (scripts/e2e-pc-setup-rig.ts, plan M7), none of them his:
 *  - a fake provider that answers the dummy Claude tokens and the lent one's profile and usage;
 *  - LifeOS's update feed for the stand-in LifeOS installer (latest.yml and the .exe), on 127.0.0.1;
 *  - X, the stand-in box: an isolated headless instance whose listener the rig reaches at 10.0.2.2;
 *  - G, the stand-in Mac: an isolated windowed instance under xvfb (TEMP_CODE_BUILD_PLATFORM=darwin), the giver,
 *    holding two dummy Claude accounts and the lent sign-in, its Work signed in to the stand-in LifeOS.
 * The lent sign-in is the box's own Claude CLI token (a one-year token with no refresh token), read from the box's
 * credentials file into G's vault and never printed; the proof's own Remove takes it back from the PC.
 */
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer as createHttp, type Server } from 'node:http'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { chromiumEncrypt, deriveChromiumKey } from 'aliax-core/vault'
import { isUp, launch, rpc, standIn, stop, until, type StandIn } from './pcRig'

export const PORTS = { box: 47320, mac: 47321, macDebug: 9401, fake: 47331, feed: 3332, lifeos: 3330 }
export const DUMMY = [
  { name: 'dummy-one@example.com', id: 'u-dummy-one', token: 'DUMMY-ONE' },
  { name: 'dummy-two@example.com', id: 'u-dummy-two', token: 'DUMMY-TWO' }
]

/** The box's Claude sign-in, lent: the token and the account it names, never printed. */
export function lentSignIn(): { token: string; expiresAt: number; uuid: string; email: string } {
  const creds = JSON.parse(readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8')) as { claudeAiOauth: { accessToken: string; expiresAt: number } }
  const account = (JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')) as { oauthAccount: { accountUuid: string; emailAddress: string } }).oauthAccount
  return { token: creds.claudeAiOauth.accessToken, expiresAt: creds.claudeAiOauth.expiresAt, uuid: account.accountUuid, email: account.emailAddress }
}

/** Answers profile and usage for the dummy tokens and the lent one; nothing else. */
export function fakeProvider(lent: { token: string; uuid: string; email: string }): Promise<Server> {
  const known = new Map<string, { uuid: string; email: string }>([...DUMMY.map((d) => [d.token, { uuid: d.id, email: d.name }] as const), [lent.token, { uuid: lent.uuid, email: lent.email }]])
  const server = createHttp((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const who = known.get((req.headers.authorization ?? '').replace(/^Bearer /, ''))
    const json = (status: number, body: unknown): void => void (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)))
    if (url.pathname === '/api/oauth/usage') return who ? json(200, { limits: [{ kind: 'session', group: 'session', percent: 10 }] }) : json(401, {})
    if (url.pathname === '/api/oauth/profile') return who ? json(200, { account: { uuid: who.uuid, email: who.email }, organization: { uuid: 'org-fake', name: 'Fake', rate_limit_tier: 'default_claude_max_5x' } }) : json(401, {})
    json(404, { error: 'not here' })
  })
  return new Promise((ok) => server.listen(PORTS.fake, '127.0.0.1', () => ok(server)))
}

/** A plain feed: every file in `dir` by its name (latest.yml and the installer). */
export function feedServer(dir: string): Promise<Server> {
  const server = createHttp((req, res) => {
    const name = basename(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname))
    const file = join(dir, name)
    if (!name || !existsSync(file)) return void (res.writeHead(404), res.end())
    res.writeHead(200, { 'content-length': String(statSync(file).size) })
    createReadStream(file).pipe(res)
  })
  return new Promise((ok) => server.listen(PORTS.feed, '127.0.0.1', () => ok(server)))
}

const vaultDir = (s: StandIn): string => join(s.data, 'aliax')
const fileOf = (service: string, name: string): string => `${service}__${encodeURIComponent(name)}`
const claudeStatic = (token: string, expiresAt: number, a: { id: string; name: string }): string =>
  JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt, scopes: ['user:inference', 'user:profile'] } }), oauthAccount: { accountUuid: a.id, emailAddress: a.name } })

/** G's vault, sealed by a key file: the two dummy accounts and the lent one, all static. */
export function seedGiverVault(g: StandIn, lent: ReturnType<typeof lentSignIn>): void {
  const dir = vaultDir(g)
  mkdirSync(join(dir, 'secrets'), { recursive: true, mode: 0o700 })
  const password = randomBytes(32).toString('hex')
  writeFileSync(join(dir, 'vault.key'), `${password}\n`, { mode: 0o600 })
  const key = deriveChromiumKey(password)
  const now = Date.now()
  const accounts = [...DUMMY.map((d) => ({ ...d, expiresAt: now + 365 * 86_400_000 })), { name: lent.email, id: lent.uuid, token: lent.token, expiresAt: lent.expiresAt }]
  const profiles = accounts.map((a) => ({ name: a.name, accountId: a.id, email: a.name, color: '#5b8def', createdAt: now, static: true }))
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ 'claude-code': profiles }, null, 2))
  for (const a of accounts) writeFileSync(join(dir, 'secrets', `${fileOf('claude-code', a.name)}.bin`), chromiumEncrypt(key, claudeStatic(a.token, a.expiresAt, a)), { mode: 0o600 })
}

export interface Standins {
  box: StandIn
  mac: StandIn
  workspace: string
  close(): Promise<void>
}

/** Starts and wires the stand-ins; G holds the box as the giver and its Work signed in to the stand-in LifeOS. */
export async function startStandins(root: string, opts: { lifeosToken: string; feedDir: string; log: (m: string) => void }): Promise<Standins> {
  const lent = lentSignIn()
  const fake = await fakeProvider(lent)
  const feed = await feedServer(opts.feedDir)
  const fakeUrl = `http://127.0.0.1:${PORTS.fake}`
  const lifeosUrl = `http://127.0.0.1:${PORTS.lifeos}`
  const box = standIn(root, 'box', PORTS.box, { headless: true, env: { TEMP_CODE_FAKE_PROVIDERS: fakeUrl, TEMP_CODE_REMOTE_TRACE: '1', TEMP_CODE_LIFEOS_URL: lifeosUrl } })
  const mac = standIn(root, 'mac', PORTS.mac, { headless: false, debug: PORTS.macDebug, env: { TEMP_CODE_FAKE_PROVIDERS: fakeUrl, TEMP_CODE_BUILD_PLATFORM: 'darwin', TEMP_CODE_LIFEOS_URL: lifeosUrl } })
  launch(box, true)
  if (!(await isUp(box))) throw new Error('the stand-in box did not start')
  await rpc(box, 'remote.settings.set', { publicOrigin: `http://10.0.2.2:${PORTS.box}` })
  await rpc(box, 'work.set', { enabled: true })
  const ws = await rpc<{ id: string }>(box, 'workspace.create', { kind: 'work', name: 'Purdue (rig)', sector: 'purdue' })
  const key = await rpc<{ token: string; key: { id: string } }>(box, 'remote.keys.create', { name: 'Stand-in Mac', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  await rpc(box, 'devices.setGiver', { keyId: key.key.id, name: 'Stand-in Mac' })
  opts.log('the stand-in box is up, Work on, its giver named')

  seedGiverVault(mac, lent)
  launch(mac, false)
  if (!(await isUp(mac))) throw new Error('the stand-in Mac did not start')
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${PORTS.box}`, key: key.token, name: 'tempcode-box' })
  const claimed = await until("the Mac's giver claim", 90_000, async () => !!(await rpc<{ giver: { identity?: unknown } | null }>(box, 'devices.giver')).giver?.identity)
  if (!claimed) throw new Error('the stand-in Mac never claimed the giver')
  await rpc(mac, 'work.set', { enabled: true })
  const signed = await rpc<{ lifeos: { state: string } }>(mac, 'work.lifeos.setToken', { token: opts.lifeosToken })
  opts.log(`the stand-in Mac is up, the giver, its Work on, LifeOS ${signed.lifeos.state}`)
  return {
    box,
    mac,
    workspace: ws.id,
    close: async () => {
      await stop(mac)
      await stop(box)
      fake.close()
      feed.close()
    }
  }
}
