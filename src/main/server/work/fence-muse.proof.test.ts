import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MspError, type Connection } from '@muse-code/sdk'
import { configureMuseDirs, museConfigDirFor, museDirKind, museWorkDirs } from '../museConfigDirs'
import { spawnMuseHost } from '../drivers/harness/museHost'
import { SERVE_ARGS, sessionStartParams } from '../drivers/harness/museProtocol'

/**
 * The Muse Code fence for Work threads, proven on the real binary
 * (docs/agents/work-scope.md "Muse Code"). One fake MCP server (or hook) is
 * planted in every source Muse 1.4.24 loads, and `muse serve` is started
 * with the driver's own functions:
 *
 *  - as a code thread starts it (museConfigDirFor, the person's data home,
 *    the folder as cwd and root): every plant must load, or it proves nothing;
 *  - with the Work dirs as an agent left them, before the reset: the
 *    agent's plants load, so the reset is what cuts them;
 *  - as a Work thread starts it (museWorkDirs: its config and data dirs, the
 *    empty root as cwd and primary root, the folder an extra root): no
 *    plant loads, the app's own server does, and so does the store's skill.
 *
 * No model is called and no sign-in is used: the host runs Muse's offline
 * echo provider (`--provider echo`) for one turn, since Muse mounts servers
 * when the session's runtime is built at its first turn. Every home is a
 * scratch folder. The binary is the versioned one beside the launcher
 * (`MUSE_BIN` names another); without it the case is skipped with a line,
 * and `TEMP_CODE_REQUIRE_FENCE_PROOF=1` makes that a failure. The sources and
 * the spike behind them are in `.temp-code/plans/landed/M06/muse-sources.md`.
 */

const REQUIRED = process.env.TEMP_CODE_REQUIRE_FENCE_PROOF === '1'
const NODE = process.execPath
const MUSE = process.env.MUSE_BIN ?? join(process.env.HOME ?? '', '.local/bin/muse-bin-1.4.24-R9131.1')

let s: string
let fake: string
let marker: string

beforeAll(() => {
  s = realpathSync(mkdtempSync(join(tmpdir(), 'tc-muse-fence-')))
  fake = join(s, 'fake-mcp.mjs')
  marker = join(s, 'marker.log')
  writeFileSync(
    fake,
    `import { appendFileSync } from 'node:fs'
const [marker, name] = process.argv.slice(2)
appendFileSync(marker, name + ' spawned\\n')
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
    else reply({})
  }
})
process.stdin.on('end', () => process.exit(0))
`
  )
})
afterAll(() => {
  configureMuseDirs(null)
  rmSync(s, { recursive: true, force: true })
})

const write = (file: string, value: unknown): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
const stdio = (name: string) => ({ type: 'stdio', command: NODE, args: [fake, marker, name] })
const mcpJson = (name: string) => ({ mcpServers: { [name]: stdio(name) } })
const sessionHook = (name: string) => ({ SessionStart: [{ hooks: [{ type: 'command', command: `echo '${name} spawned' >> '${marker}'` }] }] })
const git = (dir: string): void => void execFileSync('git', ['init', '-q', '--template=', dir])
const spawned = (): string[] => [...new Set(readFileSync(marker, 'utf8').split('\n').filter((l) => l.endsWith(' spawned')).map((l) => l.split(' ')[0]))].sort()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A plugin as `muse plugins install` takes it: one stdio server, and a SessionStart hook when asked. */
function plugin(dir: string, id: string, withHook: boolean): void {
  if (withHook) {
    write(join(dir, 'hooks/h.sh'), `#!/bin/sh\necho '${id}-hook spawned' >> '${marker}'\n`)
    chmodSync(join(dir, 'hooks/h.sh'), 0o755)
  }
  write(join(dir, '.muse-plugin/plugin.json'), {
    schemaVersion: 1,
    name: id,
    displayName: id,
    version: '0.1.0',
    description: 'fence proof',
    compat: { source: 'native', manifestDir: '.muse-plugin' },
    capabilities: {
      skills: [],
      commands: [],
      reminders: [],
      hooks: withHook ? [{ id: 'h', event: 'SessionStart', command: ['sh', 'hooks/h.sh'], timeoutMs: 3000 }] : [],
      mcpServers: [{ id: 'srv', transport: 'stdio', command: [NODE, fake, marker, id] }]
    }
  })
}

interface Case {
  spawned: string[]
  inventory: string[]
  hooks: number
  skills: string[]
  bundled: number
}

/** One `muse serve` through the driver's host (harness/museHost.ts), one echo turn, then what the session mounted. */
async function runCase(label: string, opts: { cwd: string; configDir: string; dataDir?: string; credentialFile?: boolean; env: Record<string, string>; roots?: string[] }): Promise<Case> {
  writeFileSync(marker, '')
  const host = await spawnMuseHost({
    sessionId: 'proof',
    museBin: MUSE,
    cwd: opts.cwd,
    configDir: opts.configDir,
    credentialFile: opts.credentialFile,
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    env: opts.env,
    args: [...SERVE_ARGS, '--provider', 'echo']
  })
  const conn: Connection = host.connection
  const notes: string[] = []
  conn.onNotification((n) => void notes.push(n.method))
  conn.onServerRequest(async (req) => {
    throw new MspError({ code: -32601, message: `method not found: ${req.method}`, data: { kind: 'methodNotFound', retryable: false } })
  })
  try {
    const params = sessionStartParams({ cwd: opts.cwd, model: '', permission: 'edits', bridge: { command: NODE, args: [fake, marker, 'app'], env: {} }, ...(opts.roots ? { roots: opts.roots } : {}) })
    const start = (await conn.command('session/start', params as unknown as Record<string, unknown>)) as { session: { sessionId: string } }
    const sessionId = start.session.sessionId
    await conn.command('turn/start', { sessionId, input: [{ type: 'text', text: 'echo' }] })
    for (let i = 0; i < 80 && !notes.includes('turn/completed'); i++) await sleep(250)
    let inventory: { name: string; state: string }[] = []
    for (let i = 0; i < 40; i++) {
      const notices = (await conn.request('mcpServer/readStartupNotices', { sessionId })) as { settled?: boolean }
      inventory = ((await conn.request('mcpServer/readInventory', { sessionId, includeTools: true })) as { servers: { name: string; state: string }[] }).servers
      if (notices.settled && inventory.every((x) => x.state !== 'connecting' && x.state !== 'pending')) break
      await sleep(250)
    }
    await sleep(1000)
    const hooks = ((await conn.request('hook/list', { sessionId })) as { hooks: unknown[] }).hooks
    const skills = ((await conn.request('skill/list', { sessionId })) as { skills: { source: string; selector: string }[] }).skills
    const c = {
      spawned: spawned(),
      inventory: inventory.map((x) => x.name).sort(),
      hooks: hooks.length,
      skills: skills.filter((k) => k.source !== 'bundled' && k.source !== 'plugin').map((k) => k.selector),
      bundled: skills.filter((k) => k.source === 'bundled').length
    }
    console.log(`[muse fence proof] ${label.padEnd(26)} spawned: ${c.spawned.join(' ')} | inventory: ${c.inventory.join(' ')} | hooks: ${c.hooks} | skills: ${c.skills.join(' ')} (+${c.bundled} bundled)`)
    return c
  } finally {
    await host.close()
    await sleep(300)
  }
}

describe('Muse Code: a planted server in every source', () => {
  it('each plant loads for a code thread and after an agent wrote into the Work dirs, none for a Work thread, in the Work folder and in another project', async () => {
    if (!existsSync(MUSE)) {
      if (REQUIRED) throw new Error(`Muse Code: ${MUSE} is not here, and TEMP_CODE_REQUIRE_FENCE_PROOF is set`)
      return console.warn(`[fence proof] Muse Code NOT PROVEN on this machine: ${MUSE} is not here`)
    }
    const home = join(s, 'person/home')
    const personCfg = join(s, 'person/config')
    const personData = join(s, 'person/data')
    const pm = join(personCfg, 'muse')
    const userData = join(s, 'userData')
    const store = join(s, 'store/scope/global')
    const workFolder = join(s, 'work-folder')
    const proj = join(s, 'outer/code-project')
    const sub = join(proj, 'sub')
    mkdirSync(home, { recursive: true })
    write(join(store, 'skills/store-skill/SKILL.md'), '---\nname: store-skill\ndescription: the store\'s skill\n---\nbody\n')
    const env = (cfg: string, data: string): Record<string, string> => ({ HOME: home, PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: cfg, XDG_DATA_HOME: data })
    const cli = (args: string[], cwd: string, e: Record<string, string>): void => void execFileSync(MUSE, args, { cwd, env: { ...e, MUSE_CONTRIBUTOR_MODE: '0' }, stdio: 'ignore' })

    // The person's own Muse config and data, as ~/.config/muse and ~/.local/share/muse hold them.
    write(join(pm, 'settings.json'), { schema_version: 1, mcpServers: { user_settings: stdio('user_settings') }, hooks: sessionHook('user_settings_hook') })
    // A project plugin installs only into a trusted folder.
    write(join(pm, 'trust.json'), { schema_version: 1, projects: { [proj]: { decision: 'trusted' } } })
    git(proj)
    write(join(proj, '.mcp.json'), mcpJson('ws_repo_root'))
    write(join(sub, '.mcp.json'), mcpJson('ws_subdir'))
    mkdirSync(workFolder, { recursive: true })
    write(join(workFolder, '.mcp.json'), mcpJson('work_folder'))
    plugin(join(s, 'src/plug-user'), 'plug-user', true)
    plugin(join(proj, 'tools/plug-proj'), 'plug-proj', false)
    const penv = env(personCfg, personData)
    cli(['plugins', 'install', join(s, 'src/plug-user'), '--json'], proj, penv)
    cli(['plugins', 'install', join(proj, 'tools/plug-proj'), '--scope', 'project', '--json'], proj, penv)
    cli(['plugins', 'approve', 'plug-user', '--json'], proj, penv)
    cli(['plugins', 'approve', 'plug-proj', '--json'], proj, penv)

    configureMuseDirs({ root: join(userData, 'muse-accounts'), readBlob: () => null, userConfigDir: pm })
    const codeDir = museConfigDirFor(null, 'global', store)!
    const code = (label: string, cwd: string) => runCase(label, { cwd, configDir: codeDir, credentialFile: museDirKind(codeDir) === 'account', env: env(codeDir, personData) })
    const PERSON = ['plug-proj', 'plug-user', 'plug-user-hook', 'user_settings', 'user_settings_hook']

    // Controls: a code thread in the other project's subfolder and in the Work folder.
    const controlCode = await code('code thread, other project', sub)
    expect(controlCode.spawned, 'a code thread loads every plant').toEqual(['app', ...PERSON, 'ws_repo_root', 'ws_subdir'].sort())
    const controlFolder = await code('code thread, Work folder', workFolder)
    expect(controlFolder.spawned).toEqual(['app', ...PERSON, 'work_folder'].sort())

    // The Work dirs as an agent left them: servers and a hook in the settings, an approved plugin in the data dir,
    // a .mcp.json in the root, and the root's own repo removed for one above it with a .mcp.json of its own.
    const first = museWorkDirs('t1', null, 'global', store)
    write(join(first.configDir, 'muse/settings.json'), { schema_version: 1, mcpServers: { tamper_settings: stdio('tamper_settings') }, hooks: sessionHook('tamper_settings_hook') })
    plugin(join(s, 'src/plug-tamper'), 'plug-tamper', false)
    const tenv = env(first.configDir, first.dataDir)
    cli(['plugins', 'install', join(s, 'src/plug-tamper'), '--json'], workFolder, tenv)
    cli(['plugins', 'approve', 'plug-tamper', '--json'], workFolder, tenv)
    const roots = dirname(first.root)
    rmSync(join(first.root, '.git'), { recursive: true, force: true })
    git(roots)
    write(join(roots, '.mcp.json'), mcpJson('tamper_above_root'))
    write(join(first.root, '.mcp.json'), mcpJson('tamper_root'))
    const tampered = await runCase('Work dirs as an agent left', { cwd: first.root, configDir: first.configDir, dataDir: first.dataDir, env: { HOME: home, PATH: '/usr/bin:/bin' }, roots: [first.root, workFolder] })
    expect(tampered.spawned, 'the agent\'s plants load until the dirs are put back').toEqual(['app', 'plug-tamper', 'tamper_above_root', 'tamper_root', 'tamper_settings', 'tamper_settings_hook'])

    // Fenced: as the driver starts a Work thread, in the Work folder and in the other project.
    const fenced = async (label: string, folder: string): Promise<Case> => {
      const d = museWorkDirs('t1', null, 'global', store)
      return runCase(label, { cwd: d.root, configDir: d.configDir, dataDir: d.dataDir, credentialFile: d.credentialFile, env: { HOME: home, PATH: '/usr/bin:/bin' }, roots: [d.root, realpathSync(folder)] })
    }
    for (const [label, folder] of [['the Work folder', workFolder], ['another project', sub]] as const) {
      const c = await fenced(`Work thread, ${label}`, folder)
      expect(c.spawned, `${label}: only the app's server loads`).toEqual(['app'])
      expect(c.inventory, `${label}: the inventory lists only app`).toEqual(['app'])
      expect(c.hooks, `${label}: no hook`).toBe(0)
      expect(c.skills, `${label}: the store's skill reaches the thread`).toContain('store-skill')
      // The data dir's muse/skills was removed; Muse extracts its bundled skills there again.
      expect(c.bundled, `${label}: the bundled skills still load`).toBeGreaterThan(0)
    }
    // The reset touched nothing of the person's.
    expect(JSON.parse(readFileSync(join(pm, 'settings.json'), 'utf8')).mcpServers).toHaveProperty('user_settings')
    expect(readdirSync(join(personData, 'muse', 'plugins')).length).toBeGreaterThan(0)
  }, 300_000)
})
