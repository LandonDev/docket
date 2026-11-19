import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttps } from 'node:https'
import { connect, createServer as createTcp, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSdkMcpServer, query, tool, type Options } from '@anthropic-ai/claude-agent-sdk'

vi.mock('electron', () => ({ nativeImage: {} }))

const { claudeExtraArgs, fenceWorkOptions, workToolRefusal } = await import('../drivers/claude')
const { CODEX_WORK_CONFIG, codexWorkArgs, codexWorkThreadConfig, ensureCodexWorkHome } = await import('../drivers/codex')
const { resolveBinary, resolveClaude } = await import('../drivers/binaries')
const { ensureClaudeWorkRoot } = await import('../skills/claudeRoots')
const { WORK_STANDING_RULE } = await import('./preamble')

/**
 * The first step of the Work fence, kept so a new source fails it
 * (docs/agents/work.md "The fence"). One fake MCP server is planted in EVERY
 * place each harness reads servers from, and the real CLI is started twice:
 *
 *  - as a code thread starts it (the control): every plant must load, or the
 *    plant proves nothing;
 *  - as a Work thread starts it, with exactly what the drivers build
 *    (drivers/claude.ts `fenceWorkOptions`, drivers/codex.ts
 *    `ensureCodexWorkHome`, `codexWorkArgs`, `codexWorkThreadConfig`): no
 *    plant loads, and the app's own server does.
 *
 * A Work thread, a child it spawns and a thread it starts on another project
 * are the same spawn to a harness (the row's `scope` picks the fence; the
 * registry tests show each of the three carries it), so the fenced cases
 * differ by folder: the Work folder, another project's folder with every
 * project-level plant in it, and a config root an agent has written into.
 *
 * No model is called and nothing leaves the machine: the Claude CLI's API
 * host is a stand-in on the loopback, which also serves the planted account
 * connector. The person's own config is never read or written: every home is
 * a scratch folder.
 *
 * A harness whose CLI is not installed is skipped with a line saying so;
 * `TEMP_CODE_REQUIRE_FENCE_PROOF=1` makes that a failure. Muse Code's
 * proof is its sibling, fence-muse.proof.test.ts.
 */

const REQUIRED = process.env.TEMP_CODE_REQUIRE_FENCE_PROOF === '1'
const NODE = process.execPath
let scratch: string
let fakeServer: string

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'tc-fence-proof-'))
  fakeServer = join(scratch, 'fake-mcp.mjs')
  // A planted server says so the moment a harness starts it, then speaks enough MCP to be listed and called.
  writeFileSync(
    fakeServer,
    `import { appendFileSync } from 'node:fs'
const [marker, name] = process.argv.slice(2)
const mark = (what) => appendFileSync(marker, name + ' ' + what + '\\n')
mark('spawned')
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id === undefined) continue
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
    if (msg.method === 'initialize') reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version: '0.0.1' } })
    else if (msg.method === 'tools/list') reply({ tools: [{ name: 'leak', description: 'planted', inputSchema: { type: 'object', properties: {} } }] })
    else if (msg.method === 'tools/call') { mark('called'); reply({ content: [{ type: 'text', text: 'a planted tool ran' }] }) }
    else reply({})
  }
})
process.stdin.on('end', () => process.exit(0))
`
  )
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const write = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const json = (file: string, value: unknown): void => write(file, JSON.stringify(value))
const marks = (marker: string): string[] => (existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean) : [])
/** The planted servers a case started. */
const spawned = (marker: string): string[] => [...new Set(marks(marker).filter((l) => l.endsWith(' spawned')).map((l) => l.split(' ')[0]))].sort()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const skip = (harness: string, why: string): void => {
  if (REQUIRED) throw new Error(`${harness}: ${why}, and TEMP_CODE_REQUIRE_FENCE_PROOF is set`)
  console.warn(`[fence proof] ${harness} NOT PROVEN on this machine: ${why}`)
}

// ── Claude Code ──────────────────────────────────────────────────────────

/** A stand-in for Anthropic's API hosts, reached through HTTPS_PROXY: it lists one planted account connector and answers as that connector. */
async function standInApi(dir: string, marker: string): Promise<{ proxy: string; ca: string; close(): void } | null> {
  const key = join(dir, 'ca.key')
  const ca = join(dir, 'ca.pem')
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', key, '-out', ca, '-subj', '/CN=tc-fence-proof', '-addext', 'subjectAltName=DNS:api.anthropic.com,DNS:mcp-proxy.anthropic.com,DNS:*.anthropic.com,DNS:claude.ai'], { stdio: 'ignore' })
  } catch {
    return null
  }
  const mark = (line: string): void => void writeFileSync(marker, `${line}\n`, { flag: 'a' })
  const web = createHttps({ key: readFileSync(key), cert: readFileSync(ca) }, (req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const url = req.url ?? ''
      const answer = (code: number, value: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(code, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(value))
      }
      if (url.startsWith('/v1/mcp_servers')) {
        mark('plant_connector asked-for')
        return answer(200, { data: [{ type: 'mcp_server', id: 'mcpsrv_plant', display_name: 'plant connector', url: 'https://plant.invalid/mcp', created_at: '2026-01-01T00:00:00Z', eligible: true }], has_more: false })
      }
      if (url.startsWith('/v1/mcp/mcpsrv_plant')) {
        mark('plant_connector spawned')
        if (req.method !== 'POST') return answer(405, {})
        let msg: { id?: number; method?: string; params?: { protocolVersion?: string } } = {}
        try {
          msg = JSON.parse(body)
        } catch {
          // not JSON
        }
        if (msg.method === 'initialize') return answer(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'plant_connector', version: '0.0.1' } } }, { 'mcp-session-id': 'plant' })
        if (msg.method === 'tools/list') return answer(200, { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'leak', description: 'planted', inputSchema: { type: 'object', properties: {} } }] } })
        if (msg.id === undefined) {
          res.writeHead(202)
          return res.end()
        }
        return answer(200, { jsonrpc: '2.0', id: msg.id, result: {} })
      }
      answer(404, { error: 'not here' })
    })
  })
  await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve))
  const webPort = (web.address() as { port: number }).port
  const proxy: Server = createTcp((sock) => {
    sock.once('data', (head) => {
      if (!head.toString().startsWith('CONNECT ')) return void sock.end('HTTP/1.1 502 no\r\n\r\n')
      const up = connect(webPort, '127.0.0.1', () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        sock.pipe(up)
        up.pipe(sock)
      })
      up.on('error', () => sock.destroy())
      sock.on('error', () => up.destroy())
    })
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  return {
    proxy: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
    ca,
    close() {
      proxy.close()
      web.close()
      web.closeAllConnections?.()
    }
  }
}

interface ClaudeCase {
  /** name → status, as the CLI reports its MCP servers */
  servers: Record<string, string>
  spawned: string[]
  marks: string[]
}

/** Start the real CLI with these options, let its servers mount, and read what it mounted. No message is sent: no model is called. */
async function claudeCase(options: Options, marker: string, settleMs: number, until?: (servers: Record<string, string>) => boolean): Promise<ClaudeCase> {
  async function* never(): AsyncGenerator<never> {
    await new Promise(() => {})
  }
  const q = query({ prompt: never() as never, options })
  void (async () => {
    try {
      for await (const _ of q) {
        // nothing: no turn runs
      }
    } catch {
      // the query was closed
    }
  })()
  try {
    const read = async (): Promise<Record<string, string>> => Object.fromEntries((await q.mcpServerStatus()).map((s) => [s.name, s.status]))
    const started = Date.now()
    let servers = await read()
    // The control waits until every plant shows; a fenced case has nothing to wait for but time.
    while (Date.now() - started < settleMs && !(until?.(servers) ?? false)) {
      await sleep(1000)
      servers = await read()
    }
    await sleep(500)
    return { servers, spawned: spawned(marker), marks: marks(marker) }
  } finally {
    ;(q as { close?: () => void }).close?.()
  }
}

describe('Claude Code: a planted server in every source', () => {
  it('each plant loads for a code thread, and none for a Work thread, in the Work folder, in another project and after an agent wrote into the config root', async () => {
    const cli = (await resolveClaude()).path
    const dir = join(scratch, 'claude')
    const person = join(dir, 'person')
    const workFolder = join(dir, 'Work', 'purdue')
    const otherProject = join(dir, 'other-project')
    const harness = join(dir, 'harness')
    const pointer = join(harness, 'claude', 'scope', 'global')
    const marker = (name: string): string => join(dir, `marker-${name}.log`)
    const plant = (m: string, name: string) => ({ type: 'stdio', command: NODE, args: [fakeServer, m, name] })
    mkdirSync(join(pointer, 'skills'), { recursive: true })

    /** What a person's own setup holds, pointed at one marker: user and local servers, a plugin, the account sign-in. */
    const plantPerson = (m: string): void => {
      json(join(person, '.claude.json'), {
        hasCompletedOnboarding: true,
        // user scope
        mcpServers: { plant_user: plant(m, 'plant_user') },
        // local scope, per folder
        projects: Object.fromEntries([workFolder, otherProject].map((cwd) => [cwd, { hasTrustDialogAccepted: true, mcpServers: { plant_local: plant(m, 'plant_local') }, enabledMcpjsonServers: ['plant_mcpjson', 'app'] }]))
      })
      // a plugin from a marketplace the settings name, with its own server
      const market = join(dir, 'market')
      json(join(market, '.claude-plugin', 'marketplace.json'), { name: 'plantmarket', owner: { name: 'test' }, plugins: [{ name: 'planted', source: './plugins/planted', description: 'planted' }] })
      json(join(market, 'plugins', 'planted', '.claude-plugin', 'plugin.json'), { name: 'planted', version: '0.0.1', description: 'planted' })
      json(join(market, 'plugins', 'planted', '.mcp.json'), { mcpServers: { plant_plugin: plant(m, 'plant_plugin') } })
      json(join(person, 'settings.json'), { enabledPlugins: { 'planted@plantmarket': true }, extraKnownMarketplaces: { plantmarket: { source: { source: 'directory', path: market } } } })
      // signed in, with the scope that lets the CLI ask the account for its connectors
      json(join(person, '.credentials.json'), { claudeAiOauth: { accessToken: 'sk-ant-oat01-fake', refreshToken: 'sk-ant-ort01-fake', expiresAt: Date.now() + 86_400_000, scopes: ['user:inference', 'user:profile', 'user:mcp_servers'], subscriptionType: 'max' } })
    }
    /** What a folder can hold, and an agent can write: project servers (one named like the app's own) and settings that approve them. */
    const plantFolder = (cwd: string, m: string): void => {
      json(join(cwd, '.mcp.json'), { mcpServers: { plant_mcpjson: plant(m, 'plant_mcpjson'), app: plant(m, 'plant_named_app') } })
      json(join(cwd, '.claude', 'settings.json'), { enableAllProjectMcpServers: true })
      json(join(cwd, '.claude', 'settings.local.json'), { enableAllProjectMcpServers: true })
    }

    const api = await standInApi(dir, marker('api'))
    if (!api) return skip('Claude Code', 'openssl is not here to make the stand-in API its certificate')
    try {
      const env = (configDir: string): Record<string, string> => ({
        PATH: process.env.PATH ?? '',
        HOME: join(dir, 'home'),
        CLAUDE_CONFIG_DIR: configDir,
        // an API host that is nobody's: no model can be reached
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
        HTTPS_PROXY: api.proxy,
        NODE_EXTRA_CA_CERTS: api.ca,
        DISABLE_AUTOUPDATER: '1'
      })
      mkdirSync(join(dir, 'home'), { recursive: true })
      const ours = (): Options['mcpServers'] => ({ app: createSdkMcpServer({ name: 'app', version: '0.0.1', tools: [tool('ours', 'the app’s own tool', {}, async () => ({ content: [] }))] }) })
      const base = (cwd: string, configDir: string): Options => ({
        cwd,
        env: env(configDir),
        ...(cli ? { pathToClaudeCodeExecutable: cli } : {}),
        mcpServers: ours(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true
      })

      // ── the control: a code thread in the other project, the person's config as it is ──
      plantPerson(marker('control'))
      plantFolder(otherProject, marker('control'))
      const everyPlant = ['plant_local', 'plant_mcpjson', 'plant_named_app', 'plant_plugin', 'plant_user']
      const control = await claudeCase({ ...base(otherProject, person), extraArgs: claudeExtraArgs({ model: 'claude-opus-5-5' }) }, marker('control'), 60_000, () =>
        everyPlant.every((p) => spawned(marker('control')).includes(p)) && marks(marker('api')).includes('plant_connector spawned')
      )
      if (control.spawned.length === 0 && Object.keys(control.servers).length === 0) return skip('Claude Code', 'the CLI did not start')
      // Every plant is live: a source the fence is not tested against is one it is not known to cut.
      expect(control.spawned, 'the control must load every planted server').toEqual(everyPlant)
      expect(marks(marker('api')), 'the control must mount the planted account connector').toContain('plant_connector spawned')
      const leaked = Object.keys(control.servers).filter((name) => name !== 'app')
      expect(leaked.length).toBeGreaterThanOrEqual(5)
      // unfenced, a folder's server named `app` takes the name of the app's own server
      expect(control.spawned).toContain('plant_named_app')

      // ── fenced: what the driver builds for a Work thread ──
      const fenced = (cwd: string): Options => {
        // the Work root, put back as it is at every spawn
        const root = ensureClaudeWorkRoot({ root: harness, scope: 'global', pointer, personDir: person, personJson: join(person, '.claude.json'), log: () => {} })
        return fenceWorkOptions({ ...base(cwd, root), extraArgs: claudeExtraArgs({ model: 'claude-opus-5-5', scope: 'work' }) }, { scope: 'work' }, { work: true })
      }
      const apiBefore = marks(marker('api')).length

      // (1) a Work thread in its own folder, into which an agent wrote project servers
      plantPerson(marker('work'))
      plantFolder(workFolder, marker('work'))
      // (2) a thread a Work thread started on another project: every project-level plant is there
      plantFolder(otherProject, marker('other'))
      const [inWork, inOther] = await Promise.all([claudeCase(fenced(workFolder), marker('work'), 14_000), claudeCase(fenced(otherProject), marker('other'), 14_000)])

      // (3) an agent wrote into the Work root itself: servers in the root's own .claude.json, plugins in its settings
      const root = join(harness, 'claude-config-work', 'global')
      json(join(root, '.claude.json'), {
        hasCompletedOnboarding: true,
        mcpServers: { plant_user: plant(marker('tampered'), 'plant_user') },
        projects: { [workFolder]: { hasTrustDialogAccepted: true, mcpServers: { plant_local: plant(marker('tampered'), 'plant_local') }, enabledMcpjsonServers: ['plant_mcpjson', 'app'] } }
      })
      json(join(root, 'settings.json'), JSON.parse(readFileSync(join(person, 'settings.json'), 'utf8')))
      plantFolder(workFolder, marker('tampered'))
      const tampered = await claudeCase(fenced(workFolder), marker('tampered'), 14_000)

      for (const [name, got] of Object.entries({ 'the Work folder': inWork, 'another project': inOther, 'a tampered config root': tampered })) {
        expect(got.spawned, `${name}: no planted server may start`).toEqual([])
        expect(Object.keys(got.servers), `${name}: only the app's own server is mounted`).toEqual(['app'])
        expect(got.servers.app, `${name}: the app's own server is up`).toBe('connected')
      }
      // the account was never asked for its connectors, and none was mounted
      expect(marks(marker('api')).slice(apiBefore), 'a Work thread never asks the account for connectors').toEqual([])

      // ── and none can be called: each plant's tool, by the name the control gave it, is refused by the hook ──
      const mounted = { app: {}, orchestrator: {}, work: {} }
      for (const server of leaked) {
        const toolName = `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, '_')}__leak`
        expect(workToolRefusal(toolName, mounted), toolName).toMatch(/not a tool of an MCP server this Work thread loads/)
      }
      // the hook is in the options the fenced CLI ran with
      const options = fenced(workFolder)
      const deny = await options.hooks!.PreToolUse![0].hooks[0]({ tool_name: 'mcp__plant_user__leak' } as never, undefined, { signal: new AbortController().signal })
      expect(deny).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    } finally {
      api.close()
    }
  }, 240_000)
})

// ── Codex ────────────────────────────────────────────────────────────────

interface CodexCase {
  servers: string[]
  hooks: string[]
  marketplaces: string[]
  spawned: string[]
  threadId: string | null
  error: string | null
}

/** One `codex app-server`: initialize, start or resume a thread as given, let servers mount, read what is there. No turn runs. */
async function codexCase(bin: string, opts: { home: string; cwd: string; args: string[]; marker: string }, start: (req: (method: string, params: unknown, ms?: number) => Promise<unknown>) => Promise<unknown>): Promise<CodexCase> {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: opts.home }
  delete env.CODEX_SQLITE_HOME
  const proc = spawn(bin, [...opts.args, 'app-server'], { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let id = 1
  let out = ''
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  proc.stderr.on('data', () => {})
  proc.stdout.on('data', (chunk) => {
    out += chunk
    let nl: number
    while ((nl = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, nl)
      out = out.slice(nl + 1)
      let msg: { id?: number; method?: string; result?: unknown; error?: unknown }
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      // a request from the server (an approval): declined
      if (msg.id !== undefined && msg.method) proc.stdin.write(`${JSON.stringify({ id: msg.id, result: { decision: 'decline' } })}\n`)
      else if (msg.id !== undefined) {
        const waiter = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) waiter?.reject(new Error(JSON.stringify(msg.error)))
        else waiter?.resolve(msg.result)
      }
    }
  })
  const exited = new Promise<void>((resolve) => proc.on('exit', () => resolve()))
  const req = (method: string, params: unknown, ms = 60_000): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const n = id++
      pending.set(n, { resolve, reject })
      proc.stdin.write(`${JSON.stringify({ id: n, method, params })}\n`)
      setTimeout(() => pending.delete(n) && reject(new Error(`${method} timed out`)), ms).unref()
    })
  const result: CodexCase = { servers: [], hooks: [], marketplaces: [], spawned: [], threadId: null, error: null }
  try {
    await req('initialize', { clientInfo: { name: 'tc-fence-proof', version: '0.0.1' } })
    proc.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    const thread = (await start(req)) as { thread?: { id?: string } }
    result.threadId = thread?.thread?.id ?? null
    await sleep(5_000)
    const status = (await req('mcpServerStatus/list', { threadId: result.threadId, detail: 'toolsAndAuthOnly' })) as { data?: { name: string }[] }
    result.servers = (status.data ?? []).map((s) => s.name).sort()
    const hooks = (await req('hooks/list', { cwds: [opts.cwd] }).catch(() => ({}))) as { data?: { hooks?: { sourcePath: string }[] }[] }
    result.hooks = (hooks.data ?? []).flatMap((d) => d.hooks ?? []).map((h) => h.sourcePath)
    const plugins = (await req('plugin/list', { cwds: [opts.cwd] }, 90_000).catch(() => ({}))) as { marketplaces?: { name: string }[] }
    result.marketplaces = (plugins.marketplaces ?? []).map((m) => m.name)
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  }
  proc.stdin.end()
  const kill = setTimeout(() => proc.kill('SIGKILL'), 3_000)
  proc.kill('SIGTERM')
  await exited
  clearTimeout(kill)
  await sleep(300)
  result.spawned = spawned(opts.marker)
  return result
}

describe('Codex: a planted server in every source', () => {
  it('each plant loads for a code thread, and none for a Work thread, in another project, at its root and after an agent wrote into the Work home', async () => {
    const bin = await resolveBinary('codex')
    if (!bin) return skip('Codex', 'the codex CLI is not installed')
    const dir = join(scratch, 'codex')
    const person = join(dir, 'person-home')
    const workHome = join(dir, 'work-home')
    const market = join(dir, 'marketplace')
    const repo = join(dir, 'other-project')
    const cwd = join(repo, 'sub')
    const marker = (name: string): string => join(dir, `marker-${name}.log`)
    const fake = (m: string, name: string) => ({ command: NODE, args: [fakeServer, m, name] })
    const tomlServer = (m: string, name: string): string => `[mcp_servers.${name}]\ncommand = ${JSON.stringify(NODE)}\nargs = ${JSON.stringify([fakeServer, m, name])}\n`
    const hookJson = (m: string, name: string): string => JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `echo "${name} spawned" >> ${m}`, timeout: 5 }] }] } })
    const plugin = (root: string, name: string, m: string, plantName: string): void => {
      json(join(root, '.codex-plugin', 'plugin.json'), { name, version: '1.0.0', description: 'planted', mcpServers: './.mcp.json' })
      json(join(root, '.mcp.json'), { mcpServers: { [`${name}_srv`]: fake(m, plantName) } })
    }
    /** Every place codex reads servers and hooks from, pointed at one marker. */
    const plantAll = (m: string): void => {
      // the person's home: servers, a marketplace with an installed plugin, a hook, trust for the other project
      write(
        join(person, 'config.toml'),
        [tomlServer(m, 'home_config'), `[marketplaces.fake-mkt]\nsource_type = "local"\nsource = ${JSON.stringify(market)}\n`, '[plugins."fakeplug@fake-mkt"]\nenabled = true\n', `[projects.${JSON.stringify(repo)}]\ntrust_level = "trusted"\n`].join('\n')
      )
      write(join(person, 'hooks.json'), hookJson(m, 'home_hooks'))
      json(join(market, '.agents', 'plugins', 'marketplace.json'), { name: 'fake-mkt', plugins: [{ name: 'fakeplug', source: { source: 'local', path: './plugins/fakeplug' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] })
      plugin(join(market, 'plugins', 'fakeplug'), 'fakeplug', m, 'home_plugin')
      plugin(join(person, 'plugins', 'cache', 'fake-mkt', 'fakeplug', '1.0.0'), 'fakeplug', m, 'home_plugin')
      // the other project: a git root with its own .codex, and the folder below it with everything an agent could write there
      write(join(repo, '.git', 'HEAD'), 'ref: refs/heads/master\n')
      write(join(repo, '.codex', 'config.toml'), tomlServer(m, 'project_root'))
      write(join(cwd, '.codex', 'config.toml'), tomlServer(m, 'project_cwd'))
      write(join(cwd, '.codex', 'hooks.json'), hookJson(m, 'project_hooks'))
      json(join(cwd, '.agents', 'plugins', 'marketplace.json'), { name: 'repo-mkt', plugins: [{ name: 'repoplug', source: { source: 'local', path: './plugins/repoplug' }, policy: { installation: 'INSTALLED_BY_DEFAULT', authentication: 'ON_USE' }, category: 'Productivity' }] })
      plugin(join(cwd, 'plugins', 'repoplug'), 'repoplug', m, 'project_mkt')
    }
    const startParams = (at: string, config: Record<string, unknown>) => ({ cwd: at, approvalPolicy: 'never', sandbox: 'workspace-write', config, ...('projects' in config ? { developerInstructions: WORK_STANDING_RULE } : {}) })
    /** What the driver sends a code thread, and a Work thread: the bridge as `app`, the Work fence added for the second. */
    const codeConfig = (m: string) => ({ features: { default_mode_request_user_input: true, multi_agent: false, multi_agent_v2: false }, mcp_servers: { app: fake(m, 'app') } })
    const workConfig = (m: string, at: string) => {
      const fence = codexWorkThreadConfig(at)
      return { features: { default_mode_request_user_input: true, multi_agent: false, multi_agent_v2: false, ...fence.features }, project_root_markers: fence.project_root_markers, projects: fence.projects, mcp_servers: { app: fake(m, 'app') } }
    }

    // ── the control: a code thread on the other project, the person's home ──
    plantAll(marker('control'))
    const control = await codexCase(bin, { home: person, cwd, args: [], marker: marker('control') }, (req) => req('thread/start', startParams(cwd, codeConfig(marker('control')))))
    if (control.error && control.servers.length === 0) return skip('Codex', `the app-server did not answer (${control.error})`)
    expect(control.spawned, 'the control must load every planted server').toEqual(['app', 'home_config', 'home_plugin', 'project_cwd', 'project_root'])
    expect(control.hooks.some((h) => h.startsWith(person)), 'the home hook is listed').toBe(true)
    expect(control.hooks.some((h) => h.startsWith(cwd)), 'the project hook is listed').toBe(true)
    expect(control.marketplaces, 'the folder’s marketplace is offered').toContain('repo-mkt')

    // ── fenced: the Work home, argv and thread config the driver builds ──
    const fencedCase = async (name: string, at: string, start?: (req: Parameters<Parameters<typeof codexCase>[2]>[0]) => Promise<unknown>): Promise<CodexCase> => {
      plantAll(marker(name))
      // the driver puts the home back right before every thread start and resume
      ensureCodexWorkHome(workHome, person)
      return codexCase(bin, { home: workHome, cwd: at, args: codexWorkArgs(), marker: marker(name) }, start ?? ((req) => req('thread/start', startParams(at, workConfig(marker(name), at)))))
    }
    const expectFenced = (name: string, got: CodexCase): void => {
      expect(got.error, name).toBeNull()
      expect(got.spawned, `${name}: no planted server may start`).toEqual(['app'])
      expect(got.servers, `${name}: only the app's bridge is mounted`).toEqual(['app'])
      expect(got.hooks, `${name}: no hook is listed`).toEqual([])
      expect(got.marketplaces, `${name}: no marketplace is offered`).toEqual([])
      // thread/start under a writable sandbox writes trust into the home it runs under: here it wrote none
      expect(readFileSync(join(workHome, 'config.toml'), 'utf8'), `${name}: codex wrote nothing into the Work home's config`).toBe(CODEX_WORK_CONFIG)
    }

    // (1) a thread a Work thread started on another project, in a folder below its git root
    let threadId: string | null = null
    const inFolder = await fencedCase('folder', cwd, async (req) => {
      const thread = (await req('thread/start', startParams(cwd, workConfig(marker('folder'), cwd)))) as { thread?: { id?: string } }
      threadId = thread.thread?.id ?? null
      // a history item, so the thread has a rollout to resume from; no turn runs
      await req('thread/inject_items', { threadId, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'proof' }] }] })
      return thread
    })
    expectFenced('another project, below its root', inFolder)
    // (2) the same project's root itself
    expectFenced('another project, at its root', await fencedCase('root', repo))
    // (3) an agent wrote servers, trust for the folder and a hook into the Work home; the next start puts the home back, then resumes
    write(join(workHome, 'config.toml'), `${CODEX_WORK_CONFIG}\n${tomlServer(marker('tampered'), 'tampered_home')}\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`)
    write(join(workHome, 'hooks.json'), hookJson(marker('tampered'), 'tampered_hooks'))
    expect(threadId).not.toBeNull()
    const resumed = await fencedCase('tampered', cwd, (req) => req('thread/resume', { threadId, ...startParams(cwd, workConfig(marker('tampered'), cwd)) }))
    expectFenced('a tampered Work home, resumed', resumed)

    // (4) the race the rewrite cannot win for certain: a process the agent left behind changes the home AFTER the app
    // put it back and before codex reads it. It turns every switch back on in the file, installs a plugin and a hook,
    // adds a server, and writes the folder as trusted. The argv and the thread's config still say off, so the plugin
    // and the hook do not load. What the race does buy is servers: the one named in the file, and, because a trust
    // entry in the file beats the thread's own, the folder's project servers too. The driver stops a Work thread whose
    // app-server names any server but `app` (work/fence-codex.test.ts), and this is the second reason Codex is not
    // offered for Work yet.
    plantAll(marker('race'))
    ensureCodexWorkHome(workHome, person)
    write(
      join(workHome, 'config.toml'),
      [
        '[features]\nplugins = true\napps = true\nhooks = true\n',
        tomlServer(marker('race'), 'raced_server'),
        `[marketplaces.fake-mkt]\nsource_type = "local"\nsource = ${JSON.stringify(market)}\n`,
        '[plugins."fakeplug@fake-mkt"]\nenabled = true\n',
        `[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`
      ].join('\n')
    )
    write(join(workHome, 'hooks.json'), hookJson(marker('race'), 'raced_hook'))
    plugin(join(workHome, 'plugins', 'cache', 'fake-mkt', 'fakeplug', '1.0.0'), 'fakeplug', marker('race'), 'raced_plugin')
    const raced = await codexCase(bin, { home: workHome, cwd, args: codexWorkArgs(), marker: marker('race') }, (req) => req('thread/start', startParams(cwd, workConfig(marker('race'), cwd))))
    expect(raced.error).toBeNull()
    expect(raced.hooks, 'a lost race: no hook is listed').toEqual([])
    expect(raced.marketplaces, 'a lost race: no marketplace is offered').toEqual([])
    expect(raced.spawned, 'a lost race buys servers, from the file and from the folder it marks trusted, and nothing else').toEqual(['app', 'project_cwd', 'raced_server'])
    expect(raced.servers).toEqual(['app', 'project_cwd', 'raced_server'])
  }, 300_000)
})
