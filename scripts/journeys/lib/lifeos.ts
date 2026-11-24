import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import type { Value } from 'convex/values'
import { freePort } from '../../e2e-work-lib'
import { mainCheckout } from './record'
import { seedDeadline, seedLifeos } from './lifeosSeed'
import { until } from './window'

const SOURCE = '/srv/agents/work/lifeos'
const WORK_KIT = '/srv/agents/work/work-kit'
const BINARIES = '/srv/agents/home/.cache/convex/binaries'
const OFFLINE = 'http://127.0.0.1:0'
const OWNER = 'journey-owner'
const ENV_NAMES = ['JWKS', 'JWT_PRIVATE_KEY']
type Args = Record<string, Value>
export type LifeosRead = <T>(fn: string, args?: Args) => Promise<T>
export type Sandbox = {
  url: string
  siteUrl: string
  mcpUrl: string
  deviceToken: string
  mintDevice(): Promise<string>
  seedDeadline(title: string, startsAt: number): Promise<() => Promise<void>>
  query: LifeosRead
  stop(): Promise<void>
}

const exec = promisify(execFile)

function backendBinary(): string {
  for (const version of readdirSync(BINARIES).sort().reverse()) {
    const file = join(BINARIES, version, 'convex-local-backend')
    if (existsSync(file)) return file
  }
  throw new Error('No cached convex-local-backend binary')
}

async function checkoutCopy(folder: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  const root = join(dirname(dirname(folder)), '.lifeos-cache')
  mkdirSync(root, { recursive: true })
  if (realpathSync(root) !== root) throw new Error('The sandbox cache must be inside the journeys directory')
  const options = { cwd: folder, env, signal, timeout: 30_000 }
  const git = (repo: string, args: string[]) => exec('git', ['-C', repo, ...args], options).then(({ stdout }) => stdout.trim())
  const revision = await git(SOURCE, ['rev-parse', 'origin/main'])
  const cached = join(root, 'v4-' + revision)
  if (!existsSync(cached)) {
    const temp = mkdtempSync(join(root, 'source-'))
    try {
      const archive = async (repo: string, rev: string, to: string, paths: string[], allow: RegExp) => {
        const entries = await git(repo, ['ls-tree', '-r', rev, ...paths])
        const files = entries.split('\n').flatMap((entry) => {
          const [mode, path] = entry.split('\t')
          if (!path || !allow.test(path) || path.endsWith('.test.ts') ||
            path.split('/').some((part) => part.startsWith('.'))) return []
          if (!/^100(644|755) blob /.test(mode ?? '')) throw new Error('Expected a regular sandbox source file')
          return [path]
        })
        if (!files.length) throw new Error('No source files matched the sandbox copy')
        const tar = join(temp, 'source.tar')
        await git(repo, ['archive', '--output', tar, rev, '--', ...files])
        mkdirSync(to, { recursive: true })
        await exec('tar', ['-xf', tar, '-C', to], options)
        rmSync(tar)
      }
      await archive(SOURCE, revision, temp, ['packages/backend', 'packages/shared', 'apps/worker'],
        /^(packages\/(backend\/(convex\/.*\.(json|ts|js)|scripts\/keys\.ts|package\.json)|shared\/(src\/.*\.ts|package\.json))|apps\/worker\/(package\.json|src\/(mcp\/.*|avatars\/(store|fetch)|lib\/time|convex|health)\.ts))$/)
      const kit = join(temp, 'work-kit')
      const pinned: string | undefined = JSON.parse(readFileSync(join(temp, 'packages/shared/package.json'), 'utf8'))
        .dependencies['work-kit'].match(/#([a-f0-9]{40})$/)?.[1]
      if (!pinned) throw new Error('LifeOS does not pin a work-kit commit')
      await archive(WORK_KIT, pinned, kit, ['package.json', 'src'], /^(package\.json|src\/.*\.(css|json|ts|tsx|js|mjs|svg))$/)
      symlinkSync(dirname(realpathSync(join(SOURCE, 'packages/shared/node_modules/work-kit'))), join(kit, 'node_modules'))
      // Link installed dependencies read-only by convention. The workspace dependency
      // resolves to the shared source copied from the same commit as the backend.
      for (const [pkg, deps] of [
        ['packages/backend', ['convex', 'convex-helpers', 'jose', 'rrule']],
        ['packages/shared', ['zod']],
        ['apps/worker', ['@modelcontextprotocol/sdk', 'convex', 'zod']]
      ] as const) {
        const modules = join(temp, pkg, 'node_modules')
        for (const dep of deps) {
          mkdirSync(dirname(join(modules, dep)), { recursive: true })
          symlinkSync(realpathSync(join(SOURCE, pkg, 'node_modules', dep)), join(modules, dep))
        }
      }
      symlinkSync('../../../work-kit', join(temp, 'packages/shared/node_modules/work-kit'))
      const modules = join(temp, 'packages/backend/node_modules')
      mkdirSync(join(modules, '.bin'))
      mkdirSync(join(modules, '@lifeos'))
      symlinkSync('../convex/bin/main.js', join(modules, '.bin/convex'))
      symlinkSync('../../../shared', join(modules, '@lifeos/shared'))
      const worker = join(temp, 'apps/worker/node_modules/@lifeos')
      mkdirSync(worker)
      for (const pkg of ['backend', 'shared']) symlinkSync(`../../../../packages/${pkg}`, join(worker, pkg))
      try {
        renameSync(temp, cached)
      } catch (error) {
        if (!existsSync(cached)) throw error
      }
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }
  console.log('LifeOS copied from local origin/main ' + revision)
  const copy = join(folder, 'source')
  cpSync(cached, copy, { recursive: true, verbatimSymlinks: true })
  return join(copy, 'packages/backend')
}

export function assertSandboxKeys(names: string[], privateKey: string, jwks: string, kid: string): string {
  if ([...names].sort().join('\n') !== ENV_NAMES.join('\n')) throw new Error('Unexpected sandbox environment keys')
  try {
    const prefix = 'data:text/plain;charset=utf-8;base64,'
    if (!jwks.startsWith(prefix)) throw new Error()
    const { keys } = JSON.parse(Buffer.from(jwks.slice(prefix.length), 'base64').toString())
    const { kty, crv, x, y } = createPublicKey(createPrivateKey(privateKey)).export({ format: 'jwk' })
    const thumbprint = createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest('base64url')
    if (keys.length !== 1 || kty !== 'EC' || crv !== 'P-256' || kid !== thumbprint ||
      keys[0].kid !== kid || keys[0].kty !== kty || keys[0].crv !== crv || keys[0].x !== x || keys[0].y !== y ||
      keys[0].alg !== 'ES256' || keys[0].use !== 'sig' || 'd' in keys[0]) throw new Error()
  } catch {
    throw new Error('Sandbox environment does not contain the fresh JWT pair')
  }
  return 'Sandbox environment verified before seed: JWKS, JWT_PRIVATE_KEY (fresh pair; values omitted)'
}

function managed(proc: ChildProcess) {
  let failed: Error | undefined
  const exited = new Promise<void>((resolve) => {
    proc.once('error', (error) => { failed = error; resolve() })
    proc.once('exit', (code, signal) => {
      failed = new Error(`Process exited (${signal ?? code})`)
      resolve()
    })
  })
  return {
    check(label: string) {
      if (failed) throw new Error(label + ': ' + failed.message)
    },
    async stop() {
      if (!failed && proc.pid) {
        try {
          process.kill(-proc.pid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await exited
    }
  }
}

async function startMcp(folder: string, siteUrl: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const worker = join(folder, 'source/apps/worker')
  const server = join(worker, 'src/mcp/server.ts')
  const code = readFileSync(server, 'utf8')
  const site = /^const SITE = "[^"]+"$/m
  if (!site.test(code)) throw new Error('Cannot point the copied LifeOS tool metadata at the sandbox')
  writeFileSync(server, code.replace(site, `const SITE = ${JSON.stringify(siteUrl + '/')}`))
  copyFileSync(join(import.meta.dir, 'lifeosMcp.ts'), join(worker, 'journey-mcp.ts'))
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const log = openSync(join(folder, 'mcp.log'), 'w', 0o600)
  let proc: ReturnType<typeof managed>
  try {
    proc = managed(spawn('bun', ['--no-env-file', 'journey-mcp.ts', String(port)], {
      cwd: worker, env, detached: true, stdio: ['ignore', log, log]
    }))
  } finally {
    closeSync(log)
  }
  try {
    await until('the LifeOS tools listener', 10_000, async () => {
      proc.check(`LifeOS tools; see ${folder}/mcp.log`)
      return (await fetch(origin + '/mcp', { redirect: 'error', signal: AbortSignal.timeout(1000) }).catch(() => null))?.status === 401
    }, signal)
    console.log(`LifeOS tools ${origin}/mcp`)
    return { url: origin + '/mcp', port, stop: proc.stop }
  } catch (error) {
    await proc.stop()
    throw error
  }
}

export async function startSandbox(runFolder: string, signal?: AbortSignal, tools = false): Promise<Sandbox> {
  const runs = join(mainCheckout(resolve(import.meta.dir, '../../..')), '.temp-code/journeys')
  const run = realpathSync(runFolder)
  if (dirname(run) !== runs) throw new Error('LifeOS sandbox requires its own journey run folder')
  const folder = join(run, 'lifeos')
  mkdirSync(folder, { mode: 0o700 })
  const home = join(folder, 'home')
  mkdirSync(home)
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: folder,
    CI: '1',
    CONVEX_PROVISION_HOST: OFFLINE
  }
  const binary = backendBinary()
  const backend = await checkoutCopy(folder, env, signal)
  const port = await freePort()
  let sitePort = await freePort()
  while (port === sitePort) sitePort = await freePort()
  const url = `http://127.0.0.1:${port}`
  const siteUrl = `http://127.0.0.1:${sitePort}`
  const name = `journey-${randomUUID()}`
  const identity = ['--instance-name', name, '--instance-secret', randomBytes(32).toString('hex')]
  const { stdout: key } = await exec(binary, ['keygen', 'admin-key', ...identity], {
    cwd: folder, env, signal, timeout: 15_000
  }).catch(() => { throw new Error('Convex local admin key generation failed') })
  const adminKey = key.trim()
  if (!adminKey.startsWith(name + '|')) throw new Error('Convex did not generate a sandbox admin key')
  const cliEnv = { ...env, CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey }
  const command = async (args: string[], label: string) => {
    try {
      return await exec('bun', args, { cwd: backend, env: cliEnv, signal, timeout: 180_000 })
    } catch (error) {
      // Only the deploy's diagnostics are needed. Never echo key or env commands.
      const detail = label === 'deploy' ? (error as { stderr?: string }).stderr?.replaceAll(adminKey, '[omitted]').trim() : ''
      throw new Error(`Sandbox LifeOS ${label} failed${detail ? ': ' + detail : ''}`)
    }
  }
  const cli = (...args: string[]) => command(['x', 'convex', ...args], args[0]!)
  const log = openSync(join(folder, 'backend.log'), 'w', 0o600)
  let proc
  try {
    proc = spawn(binary, [
      ...identity, '--interface', '127.0.0.1', '--port', String(port), '--site-proxy-port', String(sitePort),
      '--convex-origin', url, '--convex-site', siteUrl, '--convex-http-proxy', OFFLINE,
      '--control-plane-url', OFFLINE, '--disable-beacon', '--do-not-require-ssl',
      '--local-storage', join(folder, 'storage'), join(folder, 'db.sqlite3')
    ], { cwd: folder, env, detached: true, stdio: ['ignore', log, log] })
  } finally {
    closeSync(log)
  }
  const child = managed(proc)
  let mcp: Awaited<ReturnType<typeof startMcp>> | undefined
  let stopped: Promise<void> | undefined
  const stop = () => stopped ??= (async () => {
    try {
      await mcp?.stop()
    } finally {
      await child.stop()
      const { stdout } = await exec('ss', ['-H', '-ltn'], { cwd: folder, env, timeout: 3000 })
      const ports = [port, sitePort, ...(mcp ? [mcp.port] : [])]
      if (stdout.split('\n').some((line) => ports.some((p) => line.trim().split(/\s+/)[3]?.endsWith(':' + p)))) {
        throw new Error(`A sandbox listener remains on ports ${ports.join(', ')}`)
      }
    }
  })()
  const request: typeof fetch = (input, init) => fetch(input, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])])
  })
  const admin = new ConvexHttpClient(url, { fetch: request })
  admin.setAdminAuth(adminKey)
  const owner = new ConvexHttpClient(url, { fetch: request })
  owner.setDebug(false)
  try {
    await until('the named sandbox backend', 20_000, async () => {
      child.check(`Convex backend; see ${folder}/backend.log`)
      const response = await request(url + '/instance_name').catch(() => null)
      if (!response?.ok) return false
      if ((await response.text()).trim() !== name) throw new Error('A different backend answered on the sandbox port')
      return true
    }, signal)
    console.log(`LifeOS sandbox ${url}, site ${siteUrl}`)
    const list = async () => (await cli('env', 'list', '--names-only')).stdout.trim().split(/\s+/).filter(Boolean)
    if ((await list()).length) throw new Error('Fresh sandbox already has deployment environment variables')
    const { stdout } = await command(['run', 'keys'], 'keys')
    const kid = stdout.match(/keys: kid ([\w-]+)\./)?.[1] ?? ''
    await cli('deploy', '--yes', '--typecheck', 'disable', '--codegen', 'disable')
    const names = await list()
    if ([...names].sort().join('\n') !== ENV_NAMES.join('\n')) throw new Error('Unexpected sandbox environment keys')
    const privateKey = (await cli('env', 'get', 'JWT_PRIVATE_KEY')).stdout.trim()
    const jwks = (await cli('env', 'get', 'JWKS')).stdout.trim()
    console.log(assertSandboxKeys(names, privateKey, jwks, kid))
    const mint = (name: string) => admin.action(makeFunctionReference<'action'>('auth:mint'), { ownerId: OWNER, name }) as Promise<string>
    const mintDevice = () => mint('Journey box')
    const deviceToken = await mintDevice()
    const { jwt } = await owner.action(makeFunctionReference<'action'>('auth:token'), { token: await mint('Journey proof reader') }) as { jwt: string }
    owner.setAuth(jwt)
    const query: LifeosRead = (fn, args = {}) => owner.query(makeFunctionReference<'query'>(fn), args)
    const internal = <T>(fn: string, args: Args) => admin.mutation(makeFunctionReference<'mutation'>(fn), { ...args, ownerId: OWNER }) as Promise<T>
    await seedLifeos({
      query,
      mutate: (fn, args) => owner.mutation(makeFunctionReference<'mutation'>(fn), args),
      internal,
      upload: async (body) => {
        const uploadUrl = new URL(await owner.mutation(makeFunctionReference<'mutation'>('compose:uploadUrl')) as string)
        if (uploadUrl.origin !== url) throw new Error('File upload URL is outside the sandbox')
        const response = await request(uploadUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })
        if (!response.ok) throw new Error(`Sandbox file upload returned ${response.status}`)
        return (await response.json() as { storageId: string }).storageId
      }
    })
    await admin.mutation(makeFunctionReference<'mutation'>('mailWaits:due'), {})
    const waits = await query<{ page: { subject: string }[] }>('mailWaits:list', {
      paginationOpts: { cursor: null, numItems: 20 }
    })
    if (!waits.page.some(({ subject }) => subject === 'Spring LAN unanswered room request')) throw new Error('LifeOS did not list the unanswered mail')
    if (tools) mcp = await startMcp(folder, siteUrl, cliEnv, signal)
    return { url, siteUrl, mcpUrl: mcp?.url ?? siteUrl + '/mcp', deviceToken, mintDevice, query, seedDeadline: (title, startsAt) => seedDeadline(internal, title, startsAt), stop }
  } catch (error) {
    await stop()
    throw error
  }
}
