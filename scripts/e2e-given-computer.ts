/**
 * A given computer for real (docs/agents/pc-setup.md, plan M3): three isolated
 * headless instances of the BUILT tree on this box, each with its own HOME,
 * userData, key-file vault (TEMP_CODE_ALIAX_DATA_DIR) and remote port, and a
 * fake provider in place of Anthropic and OpenAI (TEMP_CODE_FAKE_PROVIDERS):
 *  - G, the giver, plays the Mac (TEMP_CODE_BUILD_PLATFORM=darwin). Its vault
 *    holds two static Claude tokens, a Muse login and a Codex row the box owns.
 *  - X, the stand-in box. It refreshes the Codex grant. It names G's key the
 *    giver (`devices.setGiver`, as tc-local would) and G's own claim on the
 *    link fills in its identity.
 *  - C, the given computer. It holds one Claude sign-in of its own.
 * The setup link (M4) is not built, so the script activates C by hand: X mints
 * a plain client key, G binds it (`devices.activate`) and posts the activate
 * letter and the first manifest, and C pins the giver and adds the box sealed
 * (`devices.proof`, TEMP_CODE_E2E_DEVICES=1, isolated instances only). Then,
 * each a named check:
 *  1. a static account G holds arrives on C and is routable
 *  2. the Codex account X owns arrives as an admission, its access copy comes
 *     from X, and a rotation on X reaches C with no refresh token
 *  3. an account removed on G is gone from C after the next manifest
 *  4. Stop empties C, Start brings the accounts back
 *  5. a replayed older manifest, posted to X again or fed to C, is dropped
 *  6. a crash mid-apply (TEMP_CODE_E2E_APPLY_CRASH=deny ends C between the deny
 *     markers and the commit) resumes: the next start finishes the same letter
 *  7. Remove wipes C (no given rows, its tagged files, the box environment,
 *     the pins, its identity), X records the signed receipt and the key ends
 * Run: bun scripts/e2e-given-computer.ts   (build first: electron-vite build)
 * On Linux each instance runs under its own xvfb-run and dbus-run-session.
 * Nothing here touches /Applications/TempCode.app, a real HOME or vault, or
 * the box's live temp-code.service.
 */
import { Database } from 'bun:sqlite'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttp, type IncomingMessage } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromiumDecrypt, chromiumEncrypt, deriveChromiumKey } from 'aliax-core/vault'
import { museAccountDirName } from '../src/shared/museSettings'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_GC_KEEP === '1'
const T0 = Date.now()
const times: { name: string; ms: number; ok: boolean }[] = []
let failures = 0
let stepStart = Date.now()
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** One numbered check's whole span, for the summary. */
async function stage(name: string, fn: () => Promise<void>): Promise<void> {
  const before = failures
  stepStart = Date.now()
  console.log(`\n── ${name}`)
  try {
    await fn()
  } catch (err) {
    check(`${name}: ran to the end`, false, err instanceof Error ? err.message : String(err))
  }
  times.push({ name, ms: Date.now() - stepStart, ok: failures === before })
}

if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) {
  console.error('out/main is missing: run electron-vite build first')
  process.exit(2)
}
const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

const root = (() => {
  const d = mkdtempSync(join(tmpdir(), 'tc-given-computer-e2e-'))
  return spawnSync('realpath', [d]).stdout.toString().trim() || d
})()
interface Inst {
  name: string
  home: string
  tmp: string
  data: string
  log: string
  remote: number
  extra: Record<string, string>
  proc?: ChildProcess
}
async function inst(name: string, extra: Record<string, string> = {}): Promise<Inst> {
  const base = join(root, name)
  const i: Inst = { name, home: join(base, 'home'), tmp: join(base, 'tmp'), data: join(base, 'data'), log: join(root, `${name}.log`), remote: await freePort(), extra }
  for (const d of [i.home, i.tmp, i.data, join(i.home, '.codex'), join(i.home, '.claude')]) mkdirSync(d, { recursive: true })
  return i
}
const G = await inst('giver', { TEMP_CODE_BUILD_PLATFORM: 'darwin' })
const X = await inst('box')
const C = await inst('given')

// ── the fake provider: static Claude tokens, C's own refreshing Claude grant, and the Codex grant X refreshes ──
const S1 = { name: 'static-one@example.com', id: 'u-static-one', token: 'ST-ONE' }
const S2 = { name: 'static-two@example.com', id: 'u-static-two', token: 'ST-TWO' }
const S3 = { name: 'static-three@example.com', id: 'u-static-three', token: 'ST-THREE' }
const OWN = { name: 'own@example.com', id: 'u-own' }
const MUSE = { name: 'muse@example.com', id: 'muse-one' }
const CODEX = { name: 'codex@example.com', id: 'acct-codex' }
const jwt = (claims: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
const codexAccess = (n: number, ttlS: number): string => jwt({ exp: Math.floor(Date.now() / 1000) + ttlS, n })
const fake = {
  claude: new Map<string, { uuid: string; email: string }>([
    [S1.token, { uuid: S1.id, email: S1.name }],
    [S2.token, { uuid: S2.id, email: S2.name }],
    [S3.token, { uuid: S3.id, email: S3.name }],
    ['OT1', { uuid: OWN.id, email: OWN.name }]
  ]),
  own: { access: 'OT1', refresh: 'OR1', n: 1 },
  codex: { access: codexAccess(1, 10 * 86_400), refresh: 'CXR1', n: 1, dead: new Set<string>() },
  presented: [] as string[]
}
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((ok) => {
    let text = ''
    req.on('data', (c: Buffer) => (text += c.toString()))
    req.on('end', () => ok(text))
  })
const provider = createHttp(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/v1/oauth/token' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as { refresh_token?: string }
    fake.presented.push(body.refresh_token ?? '?')
    if (body.refresh_token !== fake.own.refresh) return json(400, { error: 'invalid_grant' })
    fake.own.n++
    fake.claude.delete(fake.own.access)
    fake.own.access = `OT${fake.own.n}`
    fake.own.refresh = `OR${fake.own.n}`
    fake.claude.set(fake.own.access, { uuid: OWN.id, email: OWN.name })
    return json(200, { access_token: fake.own.access, refresh_token: fake.own.refresh, expires_in: 3600 })
  }
  if (url.pathname === '/oauth/token' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req)) as { refresh_token?: string }
    fake.presented.push(body.refresh_token ?? '?')
    if (body.refresh_token !== fake.codex.refresh) return json(400, { error: 'invalid_grant' })
    fake.codex.n++
    fake.codex.dead.add(fake.codex.access)
    fake.codex.access = codexAccess(fake.codex.n, 10 * 86_400)
    fake.codex.refresh = `CXR${fake.codex.n}`
    return json(200, { access_token: fake.codex.access, refresh_token: fake.codex.refresh })
  }
  if (url.pathname === '/api/oauth/usage') return fake.claude.has(bearer) ? json(200, { limits: [{ kind: 'session', group: 'session', percent: 10 }] }) : json(401, { error: 'expired' })
  if (url.pathname === '/api/oauth/profile') {
    const account = fake.claude.get(bearer)
    return account ? json(200, { account, organization: { uuid: 'org-fake', name: 'Fake', rate_limit_tier: 'default_claude_max_5x' } }) : json(401, {})
  }
  if (url.pathname === '/backend-api/codex/usage') return bearer && !fake.codex.dead.has(bearer) ? json(200, { rate_limit: null }) : json(401, {})
  json(404, { error: 'not here' })
})
await new Promise<void>((ok) => provider.listen(0, '127.0.0.1', ok))
const providerPort = (provider.address() as { port: number }).port

// ── vaults, sealed by key files the script can read ──
const vaultDir = (i: Inst): string => join(i.data, 'aliax')
const fileOf = (service: string, name: string): string => `${service}__${encodeURIComponent(name)}`
function seedVault(i: Inst, profiles: Record<string, unknown[]>, secrets: Record<string, string>): void {
  const dir = vaultDir(i)
  mkdirSync(join(dir, 'secrets'), { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'vault.key'), `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify(profiles, null, 2))
  for (const [file, blob] of Object.entries(secrets)) writeSecret(i, file, blob)
}
const keyOf = (i: Inst): Buffer => deriveChromiumKey(readFileSync(join(vaultDir(i), 'vault.key'), 'utf8').trim())
function writeSecret(i: Inst, file: string, blob: string): void {
  writeFileSync(join(vaultDir(i), 'secrets', `${file}.bin`), chromiumEncrypt(keyOf(i), blob))
}
function addProfile(i: Inst, service: string, profile: Record<string, unknown>, blob: string): void {
  const path = join(vaultDir(i), 'profiles.json')
  const meta = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>[]>
  meta[service] = [...(meta[service] ?? []).filter((p) => p.name !== profile.name), profile]
  writeFileSync(path, JSON.stringify(meta, null, 2))
  writeSecret(i, fileOf(service, profile.name as string), blob)
}
const hasSecret = (i: Inst, file: string): boolean => existsSync(join(vaultDir(i), 'secrets', `${file}.bin`))
function readBlob(i: Inst, file: string): Record<string, any> | null {
  const path = join(vaultDir(i), 'secrets', `${file}.bin`)
  return existsSync(path) ? JSON.parse(chromiumDecrypt(keyOf(i), readFileSync(path))) : null
}
const profilesOn = (i: Inst, service: string): { name: string; accountId?: string; owner?: string; static?: boolean }[] =>
  (JSON.parse(readFileSync(join(vaultDir(i), 'profiles.json'), 'utf8')) as Record<string, { name: string }[]>)[service] ?? []
const claudeStatic = (token: string, account: { id: string; name: string }): string =>
  JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 365 * 86_400_000, scopes: ['user:inference', 'user:profile'] } }), oauthAccount: { accountUuid: account.id, emailAddress: account.name } })
const claudeOwn = (): string =>
  JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'OT1', refreshToken: 'OR1', expiresAt: Date.now() + 3_600_000, scopes: ['user:inference', 'user:profile'] } }), oauthAccount: { accountUuid: OWN.id, emailAddress: OWN.name } })
const codexAuth = (access: string, refresh: string | null): string =>
  JSON.stringify({
    tokens: { access_token: access, ...(refresh ? { refresh_token: refresh } : {}), id_token: jwt({ email: CODEX.name, 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }), account_id: CODEX.id },
    last_refresh: new Date().toISOString()
  })
const museAuth = JSON.stringify({ api_key: 'muse-key-one', account: MUSE.name })
const now = Date.now()
const row = (a: { name: string; id: string }, extra: Record<string, unknown> = {}) => ({ name: a.name, accountId: a.id, email: a.name, color: '#5b8def', createdAt: now, ...extra })

// X refreshes the Codex grant; C has its own Claude sign-in. G's vault waits for X's env id (its Codex row names X its owner).
seedVault(X, { codex: [row(CODEX)] }, { [fileOf('codex', CODEX.name)]: codexAuth(fake.codex.access, fake.codex.refresh) })
seedVault(C, { 'claude-code': [row(OWN)] }, { [fileOf('claude-code', OWN.name)]: claudeOwn() })

// ── launch, rpc, stop ──
function launch(i: Inst, extra: Record<string, string> = {}): void {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: i.home,
    TMPDIR: i.tmp,
    TEMP_CODE_USER_DATA: i.data,
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_REMOTE_PORT: String(i.remote),
    TEMP_CODE_REMOTE_TRACE: '1',
    TEMP_CODE_ALIAX_DATA_DIR: vaultDir(i),
    TEMP_CODE_FAKE_PROVIDERS: `http://127.0.0.1:${providerPort}`,
    TEMP_CODE_GATEWAY_ROLE: 'owner',
    TEMP_CODE_E2E_DEVICES: '1',
    TEMP_CODE_CLAIM_SHIM: '0',
    CLAUDE_CONFIG_DIR: join(i.home, '.claude'),
    CODEX_HOME: join(i.home, '.codex'),
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash',
    ...i.extra,
    ...extra
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TEMP_CODE_DEBUG_PORT
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const argv = process.platform === 'linux' ? ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.'] : [electron, '.']
  rmSync(join(i.data, 'server.json'), { force: true })
  appendFileSync(i.log, `\n===== launch ${new Date().toISOString()} ${JSON.stringify(extra)}\n`)
  const proc = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(i.log, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(i.log, c))
  i.proc = proc
}
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<void> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return
    await sleep(300)
  }
  throw new Error(`timed out: ${label}`)
}
const up = (i: Inst): Promise<void> => until(`${i.name} up`, 120_000, () => existsSync(join(i.data, 'server.json')))
const exited = (i: Inst): boolean => i.proc?.exitCode !== null || i.proc?.signalCode !== null

async function rpc<T = any>(i: Inst, method: string, params: unknown = {}): Promise<T> {
  const { port } = JSON.parse(readFileSync(join(i.data, 'server.json'), 'utf8')) as { port: number }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`${i.name}: no answer to ${method}`))
    }, 60_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'e2e', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'e2e') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(`${i.name}: ${method}: ${frame.error}`))
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      fail(new Error(`${i.name}: socket error on ${method}`))
    })
  })
}

/** Every process started under this run's userData dirs (electron-vite and xvfb children outlive their group). */
function pidsOf(i: Inst): number[] {
  const out: number[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const environ = readFileSync(`/proc/${entry}/environ`, 'utf8')
      if (environ.split('\0').includes(`TEMP_CODE_USER_DATA=${i.data}`)) out.push(Number(entry))
    } catch {
      // gone, or not ours
    }
  }
  return out
}
async function stop(i: Inst): Promise<void> {
  if (i.proc?.pid && !exited(i)) {
    try {
      process.kill(-i.proc.pid, 'SIGTERM')
    } catch {
      /* gone */
    }
    await until(`${i.name} stops`, 20_000, () => exited(i)).catch(() => {})
    try {
      process.kill(-i.proc.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  if (process.platform === 'linux')
    for (const pid of pidsOf(i)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
  await sleep(500)
}
const cleanup = async (): Promise<void> => {
  for (const i of [C, G, X]) await stop(i)
  provider.close()
  if (!KEEP && failures === 0) rmSync(root, { recursive: true, force: true })
  else log(`left for inspection: ${root}`)
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

const logHas = (i: Inst, text: string): boolean => existsSync(i.log) && readFileSync(i.log, 'utf8').includes(text)
interface Profile {
  name: string
  owner?: string
  static?: boolean
}
interface Snapshot {
  providers: Record<'claude' | 'codex' | 'muse', { profiles: Profile[]; reports: { profileName: string; expired?: boolean; note?: string }[] }>
  given?: { paused: boolean; giver: string; since: number }
  peers?: Record<string, { connected: boolean }>
}
const snapshot = (i: Inst): Promise<Snapshot> => rpc<Snapshot>(i, 'accounts.list')
const names = (s: Snapshot, p: 'claude' | 'codex' | 'muse'): string[] => s.providers[p].profiles.map((x) => x.name).sort()
interface Binding {
  envId: string
  state: string
  seq: number | null
  kind: string | null
  ack: { letterId: string; seq: number; holds: { service: string; account: string }[]; own: { service: string; account: string }[] } | null
}
const bindingOf = async (envId: string): Promise<Binding | undefined> => (await rpc<{ bindings: Binding[] }>(X, 'devices.list')).bindings.find((b) => b.envId === envId)
/** X's newest verified letter for a computer, straight from its database (device_state). */
function newestLetter(envId: string): { seq: number; kind: string; letter: { header: { id: string; seq: number } } } | null {
  const db = new Database(join(X.data, 'temp-code.db'), { readonly: true })
  try {
    const r = db.query('SELECT seq, kind, letter FROM device_state WHERE env_id = ?').get(envId) as { seq: number; kind: string; letter: string } | null
    return r ? { seq: r.seq, kind: r.kind, letter: JSON.parse(r.letter) } : null
  } finally {
    db.close()
  }
}
function settingOn(i: Inst, key: string): string | null {
  const db = new Database(join(i.data, 'temp-code.db'), { readonly: true })
  try {
    return (db.query('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | null)?.value ?? null
  } finally {
    db.close()
  }
}
const givenState = (): Promise<{ pinned: { generation: number } | null; state: { lastSeq: number; rows: { service: string; account: string; name: string; kind: string }[] } | null }> =>
  rpc(C, 'devices.proof', { op: 'state' })

let cEnv = ''
let xEnv = ''
let gEnv = ''
let cKey = ''
let xOrigin = ''
const c = (n: string): string => `given computer: ${n}`
try {
  // ── boot: X first (G's Codex row names it the owner), then G and C ──
  launch(X)
  await up(X)
  xEnv = (await rpc<{ environmentId: string }>(X, 'remote.status')).environmentId
  xOrigin = `http://127.0.0.1:${X.remote}`
  seedVault(
    G,
    { 'claude-code': [row(S1, { static: true }), row(S2, { static: true })], 'muse-code': [row(MUSE)], codex: [row(CODEX, { owner: xEnv })] },
    {
      [fileOf('claude-code', S1.name)]: claudeStatic(S1.token, S1),
      [fileOf('claude-code', S2.name)]: claudeStatic(S2.token, S2),
      [fileOf('muse-code', MUSE.name)]: museAuth,
      [fileOf('codex', CODEX.name)]: codexAuth(fake.codex.access, null)
    }
  )
  launch(G)
  launch(C)
  await Promise.all([up(G), up(C)])
  gEnv = (await rpc<{ environmentId: string }>(G, 'remote.status')).environmentId
  cEnv = (await rpc<{ environmentId: string }>(C, 'remote.status')).environmentId
  log(`G ${gEnv}, X ${xEnv}, C ${cEnv}; fake provider :${providerPort}; logs under ${root}`)

  await stage('setup: G is the giver, C is activated and pinned', async () => {
    const gKey = await rpc<{ token: string; key: { id: string } }>(X, 'remote.keys.create', { name: 'giver (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
    await rpc(X, 'devices.setGiver', { keyId: gKey.key.id, name: 'giver (e2e)' })
    await rpc(G, 'remote.environments.add', { url: xOrigin, key: gKey.token, name: 'box' })
    const gId = (await rpc<{ identity: { signPublic: string } }>(G, 'devices.proof', { op: 'identity' })).identity
    await until("G's claim names its identity on X", 60_000, async () => (await rpc<{ giver: { identity: { signPublic: string } } | null }>(X, 'devices.giver')).giver?.identity.signPublic === gId.signPublic)
    check("X: the giver named by setGiver filled in its identity on its own claim", true)
    // C's box key: a plain client key, made a device key by the activation.
    const minted = await rpc<{ token: string; key: { id: string } }>(X, 'remote.keys.create', { name: 'given (e2e)', audience: 'client', caps: ['read'] })
    cKey = minted.token
    const cId = await rpc<{ envId: string; identity: { signPublic: string; sealPublic: string } }>(C, 'devices.proof', { op: 'identity' })
    const given = await rpc<{ activated: boolean; manifested: boolean }>(G, 'devices.proof', { op: 'give', args: { envId: cId.envId, keyId: minted.key.id, identity: cId.identity, generation: 1, name: 'PC (e2e)' } })
    check('G: bound C on X, posted its activate letter and first manifest', given.activated && given.manifested, JSON.stringify(given))
    const bound = await bindingOf(cEnv)
    check('X: C is bound, active, and its key became a device key', bound?.state === 'active' && (bound.seq ?? 0) >= 2, JSON.stringify(bound && { state: bound.state, seq: bound.seq, kind: bound.kind }))
    const pinned = await rpc<{ environment: { id: string; caps: string[] } | null }>(C, 'devices.proof', {
      op: 'pin',
      args: { giver: { signPublic: gId.signPublic, name: 'giver (e2e)', envId: gEnv }, box: { envId: xEnv, origin: xOrigin }, boxKey: cKey, generation: 1, name: 'box' }
    })
    check('C: pinned the giver and saved the box with a device key', pinned.environment?.id === xEnv && pinned.environment.caps.includes('device'), JSON.stringify(pinned.environment && { id: pinned.environment.id, caps: pinned.environment.caps }))
    const rows = (() => {
      const db = new Database(join(C.data, 'temp-code.db'), { readonly: true })
      try {
        return (db.query("SELECT value FROM settings WHERE key LIKE '%environment%'").all() as { value: string }[]).map((r) => r.value)
      } finally {
        db.close()
      }
    })()
    check("C: the box's key is in no settings row (sealed in the vault)", rows.length > 0 && !rows.some((v) => v.includes(cKey)) && hasSecret(C, fileOf('addon', '~device-pins')))
  })

  let oldLetter: { header: { id: string; seq: number } } | null = null
  await stage('1. a static account the giver holds arrives and is routable', async () => {
    await until('C holds the static account', 90_000, async () => names(await snapshot(C), 'claude').includes(S1.name))
    const s = await snapshot(C)
    const p = s.providers.claude.profiles.find((x) => x.name === S1.name)
    check(c('the static Claude token is on file as a static row'), p?.static === true, JSON.stringify(p))
    check(c('its secret is the giver\'s token'), JSON.parse(readBlob(C, fileOf('claude-code', S1.name))?.keychain ?? '{}').claudeAiOauth?.accessToken === S1.token)
    await rpc(C, 'accounts.refresh', { provider: 'claude' })
    await until('a usage report for it', 30_000, async () => (await snapshot(C)).providers.claude.reports.some((r) => r.profileName === S1.name))
    const report = (await snapshot(C)).providers.claude.reports.find((r) => r.profileName === S1.name)
    const after = await snapshot(C)
    check(c('routable: the token answers the provider and the row is not paused'), report !== undefined && !report.expired && after.given?.paused === false, JSON.stringify({ report, given: after.given }))
    check(c('its own sign-in is still its own'), after.providers.claude.profiles.some((x) => x.name === OWN.name && !x.static && !x.owner))
    await until("X holds C's ack listing it", 30_000, async () => !!(await bindingOf(cEnv))?.ack?.holds.some((h) => h.account === S1.id))
    const b = await bindingOf(cEnv)
    check("X: C's signed ack lists what it holds and its own sign-in apart", !!b?.ack?.holds.some((h) => h.account === S1.id) && !!b.ack.own.some((o) => o.account === OWN.id) && !b.ack.holds.some((h) => h.account === OWN.id))
    oldLetter = newestLetter(cEnv)?.letter ?? null
    log(`kept letter ${oldLetter?.header.seq} for the replay`)
  })

  await stage('2. Codex: an admission, its copy from the box, a rotation on the box', async () => {
    await until('C holds the Codex row', 90_000, async () => names(await snapshot(C), 'codex').includes(CODEX.name))
    const p = (await snapshot(C)).providers.codex.profiles.find((x) => x.name === CODEX.name)
    check(c('the Codex row names the box its owner'), p?.owner === xEnv, JSON.stringify(p))
    const letter = newestLetter(cEnv)
    check('X: the letter grants Codex as access, owner X, with no secret in its header', JSON.stringify((letter?.letter.header as { grants?: unknown[] })?.grants ?? []).includes(`"kind":"access","owner":"${xEnv}"`))
    await until("the box's access copy lands on C", 60_000, () => typeof readBlob(C, fileOf('codex', CODEX.name))?.tokens?.access_token === 'string')
    const copy = readBlob(C, fileOf('codex', CODEX.name))?.tokens
    check(c('the copy is the access token X holds, with no refresh token'), copy?.access_token === fake.codex.access && copy?.refresh_token === undefined)
    // X rotates: its stored token is made to run out soon, and a usage poll renews it against the fake.
    const before = fake.codex.n
    writeSecret(X, fileOf('codex', CODEX.name), codexAuth(codexAccess(fake.codex.n, 3_600), fake.codex.refresh))
    await rpc(X, 'accounts.refresh', { provider: 'codex' })
    await until('X rotates', 60_000, () => fake.codex.n > before)
    check('X: rotated once with its own refresh token', fake.codex.n === before + 1 && fake.presented.at(-1) === `CXR${before}`, JSON.stringify(fake.presented))
    await until('the rotation reaches C', 60_000, () => readBlob(C, fileOf('codex', CODEX.name))?.tokens?.access_token === fake.codex.access)
    const rotated = readBlob(C, fileOf('codex', CODEX.name))?.tokens
    check(c('holds the rotated access token and still no refresh token'), rotated?.access_token === fake.codex.access && rotated?.refresh_token === undefined)
    const codexPresented = fake.presented.filter((t) => t.startsWith('CXR'))
    check('fake: each Codex refresh token was presented once, by X alone', codexPresented.length === fake.codex.n - 1 && new Set(codexPresented).size === codexPresented.length, JSON.stringify(codexPresented))
  })

  await stage('3. an account removed on the giver is gone after the next manifest', async () => {
    check(c('holds the second static account first'), names(await snapshot(C), 'claude').includes(S2.name))
    const seq = (await bindingOf(cEnv))?.seq ?? 0
    const deleted = await rpc<{ ok: boolean }>(G, 'accounts.delete', { service: 'claude-code', name: S2.name })
    check('G: deleted it', deleted.ok === true)
    await until('a newer manifest reaches X', 30_000, async () => ((await bindingOf(cEnv))?.seq ?? 0) > seq)
    await until('C drops it', 60_000, async () => !names(await snapshot(C), 'claude').includes(S2.name))
    check(c('the row and its secret are gone'), !profilesOn(C, 'claude-code').some((p) => p.name === S2.name) && !hasSecret(C, fileOf('claude-code', S2.name)))
    check(c('said why, by seq alone'), logHas(C, 'manifest applied') && !readFileSync(C.log, 'utf8').includes(S2.token))
    check(c('the other accounts stay'), names(await snapshot(C), 'claude').includes(S1.name) && names(await snapshot(C), 'claude').includes(OWN.name))
  })

  await stage('4. Stop empties the computer and Start brings the accounts back', async () => {
    // The given Muse account's files where a harness would have made them (museConfigDirs.ts MUSE_GIVEN, generation 1): Remove checks they go.
    const tagged = join(C.data, 'muse-accounts', 'given', 'g1', museAccountDirName(MUSE.name), 'global', 'muse')
    mkdirSync(tagged, { recursive: true })
    writeFileSync(join(tagged, 'auth.json'), museAuth)
    check(c('holds the given Muse account, its tagged files in place'), names(await snapshot(C), 'muse').includes(MUSE.name) && existsSync(tagged))
    await rpc(G, 'devices.computer', { envId: cEnv, action: 'stop' })
    await until('C drops every given account', 60_000, async () => {
      const s = await snapshot(C)
      return !names(s, 'claude').includes(S1.name) && !names(s, 'codex').includes(CODEX.name) && !names(s, 'muse').includes(MUSE.name)
    })
    const s = await snapshot(C)
    check(c('stopped: no given row left, its own sign-in kept'), names(s, 'claude').join() === OWN.name && names(s, 'codex').length === 0, JSON.stringify({ claude: names(s, 'claude'), codex: names(s, 'codex'), muse: names(s, 'muse') }))
    check(c('the given secrets are gone from the vault'), !hasSecret(C, fileOf('claude-code', S1.name)) && !hasSecret(C, fileOf('codex', CODEX.name)))
    check(c("the Muse account's generation-tagged files went with it"), !existsSync(join(C.data, 'muse-accounts', 'given', 'g1', museAccountDirName(MUSE.name))))
    const b = await bindingOf(cEnv)
    check('X: C is stopped, and its ack holds nothing', b?.state === 'stopped' && b.ack?.holds.length === 0, JSON.stringify(b && { state: b.state, holds: b.ack?.holds }))
    // X's answer to a pull from C, as its handler makes it (AccountSync.handlePull with admittedFor).
    const pulled = await rpc<{ transfers?: unknown[]; listed?: unknown[]; tombstones?: unknown[] }>(X, 'accounts.pull', { from: cEnv }).catch((err: Error) => ({ error: err.message }) as { error: string; listed?: unknown[]; tombstones?: unknown[] })
    check('X: its pull answer to stopped C carries nothing', (pulled.transfers ?? []).length === 0 && Array.isArray(pulled.listed) && pulled.listed.length === 0 && (pulled.tombstones ?? []).length === 0, JSON.stringify(pulled).slice(0, 300))
    await rpc(G, 'devices.computer', { envId: cEnv, action: 'start' })
    await until('C holds them again', 90_000, async () => {
      const s2 = await snapshot(C)
      return names(s2, 'claude').includes(S1.name) && names(s2, 'codex').includes(CODEX.name)
    })
    await until("the Codex copy comes back from X", 60_000, () => readBlob(C, fileOf('codex', CODEX.name))?.tokens?.access_token === fake.codex.access)
    check(c('started: the static and Codex accounts are back, the copy with no refresh token'), readBlob(C, fileOf('codex', CODEX.name))?.tokens?.refresh_token === undefined)
    check('X: C is active again', (await bindingOf(cEnv))?.state === 'active')
  })

  await stage('5. a replayed older manifest is dropped', async () => {
    if (!oldLetter) throw new Error('no letter was kept')
    const seqNow = (await bindingOf(cEnv))?.seq ?? 0
    const posted = await rpc<{ ok: boolean; error?: string }>(G, 'devices.proof', { op: 'post', args: { letter: oldLetter } })
    check(`X: the old letter ${oldLetter.header.seq} posted again is refused`, !posted.ok && /seq \d+ is not above/.test(posted.error ?? ''), JSON.stringify(posted))
    check('X: its newest letter did not move', (await bindingOf(cEnv))?.seq === seqNow)
    const before = (await givenState()).state?.lastSeq
    const fed = await rpc<{ applied: boolean }>(C, 'devices.proof', { op: 'apply', args: { letter: oldLetter } })
    check(c(`the old letter fed in is dropped as stale`), fed.applied === false && logHas(C, `letter ${oldLetter.header.seq}: dropped (stale-seq)`))
    const after = await givenState()
    check(c('nothing moved: same seq, the accounts still held'), after.state?.lastSeq === before && names(await snapshot(C), 'claude').includes(S1.name))
  })

  await stage('6. a crash mid-apply resumes', async () => {
    await stop(C)
    // One letter that drops S1 and adds S3: G learns of S3 on disk, then deletes S1.
    addProfile(G, 'claude-code', row(S3, { static: true }), claudeStatic(S3.token, S3))
    const seq = (await bindingOf(cEnv))?.seq ?? 0
    await rpc(G, 'accounts.delete', { service: 'claude-code', name: S1.name })
    await until('the letter reaches X', 30_000, async () => ((await bindingOf(cEnv))?.seq ?? 0) > seq)
    await sleep(3_000)
    const letter = newestLetter(cEnv)
    const grants = JSON.stringify((letter?.letter.header as { grants?: unknown[] })?.grants ?? [])
    check('X: the newest letter drops S1 and grants S3', letter?.kind === 'manifest' && grants.includes(S3.id) && !grants.includes(S1.id), `seq ${letter?.seq}`)
    const lastSeq = JSON.parse(settingOn(C, 'devices.given') ?? '{}').lastSeq as number
    launch(C, { TEMP_CODE_E2E_APPLY_CRASH: 'deny' })
    await until('C crashes after the deny step', 120_000, () => exited(C))
    check(c('ended itself after the deny markers'), logHas(C, '[given] e2e: crashing after the deny step'))
    await stop(C)
    const marker = settingOn(C, `devices.deny.claude-code:${S1.id}`)
    const state = JSON.parse(settingOn(C, 'devices.given') ?? '{}') as { lastSeq: number; rows: { name: string }[] }
    check(c('on disk: the deny marker for S1 is written'), marker !== null && JSON.parse(marker).seq === letter?.seq, String(marker))
    const s1Kept = profilesOn(C, 'claude-code').some((p) => p.name === S1.name)
    const s3Saved = hasSecret(C, fileOf('claude-code', S3.name))
    check(c('on disk: the seq is not committed, S1 is still in the vault, S3 not yet'), state.lastSeq === lastSeq && s1Kept && !s3Saved, JSON.stringify({ lastSeq: state.lastSeq, was: lastSeq, s1Kept, s3Saved }))
    check(c('on disk: the rows the apply may write are journaled as given'), state.rows.some((r) => r.name === S3.name) && state.rows.some((r) => r.name === S1.name))
    launch(C)
    await up(C)
    await until('C finishes the same letter', 90_000, async () => (await givenState()).state?.lastSeq === letter?.seq)
    const s = await snapshot(C)
    check(c('resumed: S1 gone, S3 held'), !names(s, 'claude').includes(S1.name) && names(s, 'claude').includes(S3.name) && !hasSecret(C, fileOf('claude-code', S1.name)), JSON.stringify(names(s, 'claude')))
    await until("X holds C's ack of that letter", 60_000, async () => (await bindingOf(cEnv))?.ack?.letterId === letter?.letter.header.id)
    check('X: the ack names the same letter, by id and seq', (await bindingOf(cEnv))?.ack?.seq === letter?.seq)
    check(c('own sign-in untouched through the crash'), names(s, 'claude').includes(OWN.name))
  })

  await stage('7. Remove wipes the computer, the box records the receipt, the key ends', async () => {
    const tagged = join(C.data, 'muse-accounts', 'given', 'g1', museAccountDirName(MUSE.name), 'global', 'muse')
    mkdirSync(tagged, { recursive: true })
    writeFileSync(join(tagged, 'auth.json'), museAuth)
    const idBefore = (await rpc<{ identity: { signPublic: string } }>(C, 'devices.proof', { op: 'identity' })).identity.signPublic
    const removed = await rpc<{ ok: boolean }>(G, 'devices.computer', { envId: cEnv, action: 'remove' })
    check('G: Remove answered', removed.ok === true)
    await until('X retires C on its receipt', 120_000, async () => (await bindingOf(cEnv))?.state === 'retired')
    const db = new Database(join(X.data, 'temp-code.db'), { readonly: true })
    const removal = db.query('SELECT receipt_at, revoked_at FROM device_removals WHERE env_id = ?').get(cEnv) as { receipt_at: number | null; revoked_at: number | null } | null
    db.close()
    check('X: the signed receipt is recorded and the key revoked', removal?.receipt_at != null && removal?.revoked_at != null, JSON.stringify(removal))
    await until('C forgets the box', 60_000, async () => (await givenState()).pinned === null && (await givenState()).state === null)
    const s = await snapshot(C)
    check(c('no given rows: only its own sign-in'), names(s, 'claude').join() === OWN.name && names(s, 'codex').length === 0 && names(s, 'muse').length === 0, JSON.stringify({ claude: names(s, 'claude'), codex: names(s, 'codex'), muse: names(s, 'muse') }))
    check(c('the given secrets are gone from the vault'), !hasSecret(C, fileOf('claude-code', S3.name)) && !hasSecret(C, fileOf('codex', CODEX.name)) && !hasSecret(C, fileOf('muse-code', MUSE.name)))
    check(c('its tagged files are gone'), !existsSync(join(C.data, 'muse-accounts', 'given')))
    const envs = await rpc<{ id: string }[]>(C, 'remote.environments.list')
    check(c('the box environment is gone'), !envs.some((e) => e.id === xEnv), JSON.stringify(envs.map((e) => e.id)))
    check(c('the pins are gone from the vault'), !hasSecret(C, fileOf('addon', '~device-pins')))
    check(c('no wipe journal or deny marker is left'), settingOn(C, 'devices.wipe') === null && settingOn(C, `devices.deny.claude-code:${S1.id}`) === null)
    const idAfter = (await rpc<{ identity: { signPublic: string } }>(C, 'devices.proof', { op: 'identity' })).identity.signPublic
    check(c('its identity is retired (a new one is made on next need)'), idAfter !== idBefore)
    const farewell = await fetch(`${xOrigin}/api/farewell`, { method: 'POST', headers: { authorization: `Bearer ${cKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'mail' }) })
    const ticket = await fetch(`${xOrigin}/api/ticket`, { method: 'POST', headers: { authorization: `Bearer ${cKey}` } })
    check("X: a request with C's key gets 401", farewell.status === 401 && ticket.status === 401, `farewell ${farewell.status}, ticket ${ticket.status}`)
    await until("G's Computers list drops C", 30_000, async () => !(await rpc<{ computers: { envId: string }[] }>(G, 'devices.computers')).computers.some((x) => x.envId === cEnv))
    check('G: C left its Computers list', true)
  })
} catch (err) {
  check('the run', false, err instanceof Error ? err.message : String(err))
} finally {
  await cleanup()
}
console.log('\ntimes:')
for (const t of times) console.log(`  ${t.ok ? 'ok  ' : 'FAIL'} ${(t.ms / 1000).toFixed(1).padStart(6)} s  ${t.name}`)
console.log(`  total ${((Date.now() - T0) / 1000).toFixed(1)} s`)
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
