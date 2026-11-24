/**
 * The rig for the PC drive bench (scripts/bench-pc-drive.ts): the share, the slow link, the Windows rig through it,
 * the stand-in box and Mac from a given tree, and the PC installed and set up as he has his laptop: paired with the
 * box, Work on, J: mapped and J:\Bench a folder in Files, the box's Purdue workspace allowed to use the PC, the PC's
 * bridge for the box at Read. Nothing here is his: dummy files, isolated instances, the rig's throwaway overlay.
 *
 * Import it only after setting RIG_REPO (pcRig.ts reads it once, at import), so the stand-ins run the tree asked for.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { basename, join, resolve } from 'node:path'
import { anonGiB, APP_DIR, GUEST_LOCAL, inSession, isUp, launch, openHostPorts, ps, rpc, rpcAt, sleep, standIn, stop, tunnel, until, vm, Window, type StandIn } from './pcRig'

export const BENCH = '/tmp/tc-pc-rig/bench'
export const SHARE = '/tmp/tc-pc-rig/jshare'
const SMB_PASS = '/tmp/tc-pc-rig/smb.pass'
const SMB_PY = '/tmp/tc-pc-rig/smbenv/bin/python'
export const PORT = { smb: 44500, link: 44501, control: 44502, box: 47320, mac: 47321, macDebug: 9401, guestCdp: 9333, cdp: 9338, server: 9339 }
export const USER_DATA = `${GUEST_LOCAL}\\temp-code-bench`
const HERE = resolve(import.meta.dir, '..', '..')

export interface BenchState {
  workspace: string
  /** the PC as the box knows it */
  pcHost: string
  /** the box as the PC saved it */
  boxOnPc: string
  installer: string
  tree: string
  version: string
}

const listening = (port: number): Promise<boolean> =>
  new Promise((ok) => {
    const s = connect(port, '127.0.0.1')
    s.once('connect', () => (s.destroy(), ok(true)))
    s.once('error', () => ok(false))
  })

/** A program that outlives this script (with --keep), its output to a file and its pid kept. */
function detached(name: string, argv: string[]): number {
  mkdirSync(BENCH, { recursive: true })
  const proc = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'ignore', 'ignore'], detached: true, cwd: HERE })
  proc.unref()
  writeFileSync(join(BENCH, `${name}.pid`), String(proc.pid))
  return proc.pid!
}
function stopDetached(name: string): void {
  const file = join(BENCH, `${name}.pid`)
  if (!existsSync(file)) return
  try {
    process.kill(Number(readFileSync(file, 'utf8')), 'SIGTERM')
  } catch {
    /* gone */
  }
}

/** The share (impacket's smbserver, user jproof) and the slow link in front of it, each started when not running. */
export async function startShare(log: (m: string) => void): Promise<void> {
  if (!existsSync(join(SHARE, 'Bench.manifest.json'))) {
    log('making the bench tree on the share')
    const made = Bun.spawnSync(['bun', join(HERE, 'scripts', 'make-pc-drive-bench.ts'), SHARE], { stdout: 'inherit', stderr: 'inherit' })
    if (made.exitCode !== 0) throw new Error('the bench tree was not made')
  }
  if (!(await listening(PORT.smb))) {
    detached('smb', ['sh', '-c', `exec ${SMB_PY} -I ${SMB_PY.replace(/python$/, 'smbserver.py')} -smb2support -ip 127.0.0.1 -port ${PORT.smb} -username jproof -password "$(cat ${SMB_PASS})" JDRIVE ${SHARE} >> ${BENCH}/smb.log 2>&1`])
    if (!(await until('the share', 20_000, () => listening(PORT.smb)))) throw new Error('the SMB share did not start')
    log(`the share: smbserver on :${PORT.smb}`)
  }
  if (!(await listening(PORT.control))) {
    detached('link', ['sh', '-c', `exec bun ${join(HERE, 'scripts', 'lib', 'slowLink.ts')} --listen ${PORT.link} --target ${PORT.smb} --control ${PORT.control} >> ${BENCH}/link.log 2>&1`])
    if (!(await until('the slow link', 20_000, () => listening(PORT.control)))) throw new Error('the slow link did not start')
    log(`the slow link: :${PORT.link} → :${PORT.smb}, control :${PORT.control}`)
  }
}
export function stopShare(): void {
  stopDetached('link')
  stopDetached('smb')
}

export interface LinkCount {
  up: number
  down: number
  turns: number
  conns: number
  ms: number
}
const control = async <T>(path: string, method = 'GET'): Promise<T> => (await fetch(`http://127.0.0.1:${PORT.control}${path}`, { method })).json() as Promise<T>
export const link = {
  shape: (delayMs: number, rateMbit: number) => control<{ delayMs: number; rateMbit: number }>(`/shape?delay=${delayMs}&rate=${rateMbit}`, 'POST'),
  reset: () => control<LinkCount>('/reset', 'POST'),
  counters: () => control<LinkCount>('/counters')
}

/** The rig's QEMU: its pid and whether its guestfwd for 445 goes through the slow link. */
export function rigRunning(): { pid: number; throughLink: boolean } | null {
  const found = Bun.spawnSync(['pgrep', '-f', 'qemu-system.*-name tc-win11,']).stdout.toString().trim().split('\n')[0]
  if (!found) return null
  const cmd = readFileSync(`/proc/${found}/cmdline`, 'utf8').replace(/\0/g, ' ')
  return { pid: Number(found), throughLink: cmd.includes(`10.0.2.100:445-cmd:/usr/bin/nc 127.0.0.1 ${PORT.link}`) }
}

/** The rig up through the slow link, only while the agents slice holds under 45 GiB (else it waits, and says so). */
export async function rigUp(log: (m: string) => void): Promise<boolean> {
  const running = rigRunning()
  if (running) {
    if (!running.throughLink) throw new Error(`the rig (pid ${running.pid}) is up without the guestfwd through :${PORT.link}; take it down or start it with --guestfwd 10.0.2.100:445=${PORT.link}`)
    log(`the rig is up already (pid ${running.pid}), J: through the slow link`)
    return false
  }
  for (let waited = 0; anonGiB() >= 45; waited++) {
    if (waited % 5 === 0) log(`the agents slice holds ${anonGiB()} GiB; the rig waits for under 45`)
    if (waited > 120) throw new Error('the box stayed above 45 GiB for two hours')
    await sleep(60_000)
  }
  const up = await vm('up', ['--guestfwd', `10.0.2.100:445=${PORT.link}`], 900_000)
  if (up.code !== 0) throw new Error(up.out.slice(-300))
  log('the rig is up, a fresh overlay')
  return true
}

export interface Standins {
  box: StandIn
  mac: StandIn
  workspace: string
  macKey: string
}

const standinsOf = (root: string): { box: StandIn; mac: StandIn } => {
  const dead = { TEMP_CODE_FAKE_PROVIDERS: 'http://127.0.0.1:9' }
  return {
    box: standIn(root, 'box', PORT.box, { headless: true, env: { ...dead, TEMP_CODE_REMOTE_TRACE: '1' } }),
    mac: standIn(root, 'mac', PORT.mac, { headless: false, debug: PORT.macDebug, env: { ...dead, TEMP_CODE_BUILD_PLATFORM: 'darwin' } })
  }
}

/** X, the box (headless, Work on, the Purdue workspace) and G, the Mac's window (linked to X by an admin key, Work on). */
export async function startStandins(log: (m: string) => void): Promise<Standins> {
  const root = join(BENCH, 'standins')
  const { box, mac } = standinsOf(root)
  await stop(mac)
  await stop(box)
  Bun.spawnSync(['rm', '-rf', root])
  const fresh = standinsOf(root)
  launch(fresh.box, true)
  if (!(await isUp(fresh.box))) throw new Error('the stand-in box did not start')
  await rpc(fresh.box, 'remote.settings.set', { publicOrigin: `http://10.0.2.2:${PORT.box}` })
  await rpc(fresh.box, 'work.set', { enabled: true })
  const ws = await rpc<{ id: string }>(fresh.box, 'workspace.create', { kind: 'work', name: 'Purdue (rig)', sector: 'purdue' })
  const key = await rpc<{ token: string }>(fresh.box, 'remote.keys.create', { name: 'Stand-in Mac', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  launch(fresh.mac, false)
  if (!(await isUp(fresh.mac))) throw new Error('the stand-in Mac did not start')
  await rpc(fresh.mac, 'remote.environments.add', { url: `http://127.0.0.1:${PORT.box}`, key: key.token, name: 'tempcode-box' })
  await rpc(fresh.mac, 'work.set', { enabled: true })
  log('the stand-ins: box (Work on, Purdue (rig)) and Mac (linked to it, Work on)')
  return { ...fresh, workspace: ws.id, macKey: key.token }
}
export async function stopStandins(): Promise<void> {
  const { box, mac } = standinsOf(join(BENCH, 'standins'))
  await stop(mac)
  await stop(box)
}
export const standinsNow = (): { box: StandIn; mac: StandIn } => standinsOf(join(BENCH, 'standins'))

// ── the PC ────────────────────────────────────────────────────────────────

export const pcRpc = <T = any>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> => rpcAt<T>(PORT.server, method, params, timeoutMs)
let tunnels: ReturnType<typeof tunnel>[] = []
export function closeTunnels(): void {
  for (const t of tunnels.splice(0)) t.kill()
}

/** TempCode on tcuser's desktop, its CDP and server reached through SSH forwards. */
export async function startPc(): Promise<Window> {
  const started = await inSession([`${APP_DIR}\\TempCode.exe`])
  if (started.code !== 0) throw new Error(`TempCode did not start: ${started.out.slice(0, 200)}`)
  return attachPc()
}
export async function attachPc(): Promise<Window> {
  closeTunnels()
  tunnels.push(tunnel([`${PORT.cdp}:127.0.0.1:${PORT.guestCdp}`]))
  await sleep(2500)
  const pc = await Window.attach(PORT.cdp, 180_000)
  await until('the PC window', 60_000, async () => !!(await pc.eval<number | null>('window.api?.getServerPort?.() ?? null')))
  const port = await pc.eval<number>('window.api.getServerPort()')
  tunnels.push(tunnel([`${PORT.server}:127.0.0.1:${port}`]))
  await until('the PC server', 30_000, () => pcRpc('remote.status', {}, 3000).then(() => true))
  return pc
}
export async function stopPc(): Promise<void> {
  closeTunnels()
  await ps('Get-Process TempCode -EA 0 | Stop-Process -Force -EA 0; Start-Sleep 2')
}

/** A fresh install of the installer as tcuser, its data gone first; the harness marker and its CDP port set. */
export async function installPc(installer: string, log: (m: string) => void): Promise<string> {
  const version = /temp-code-(1\.0\.\d+)-setup\.exe$/.exec(installer)?.[1]
  if (!version) throw new Error(`not a TempCode installer: ${installer}`)
  await ps(`Get-Process TempCode -EA 0 | Stop-Process -Force -EA 0; Start-Sleep 2; Remove-Item -Recurse -Force '${USER_DATA}', "$env:APPDATA\\aliax" -EA 0`)
  const copied = await vm('scp', [installer, 'guest:Downloads/'], 900_000)
  if (copied.code !== 0) throw new Error(copied.out.slice(-200))
  const t0 = Date.now()
  const installed = await vm('ssh', [`Downloads\\${basename(installer)} /S`], 1_800_000)
  if (installed.code !== 0) throw new Error(`the installer failed: ${installed.out.slice(-200)}`)
  const v = (await ps(`(Get-Content -Raw '${APP_DIR}\\resources\\app\\package.json' | ConvertFrom-Json).version`)).out.trim()
  if (v !== version) throw new Error(`installed ${v}, not ${version}`)
  await ps(`Remove-Item -Force "$env:USERPROFILE\\Downloads\\${basename(installer)}" -EA 0`)
  const fw = await openHostPorts([PORT.box])
  if (fw.code !== 0) throw new Error(`the guest firewall: ${fw.out}`)
  const env = { TEMP_CODE_USER_DATA: USER_DATA, TEMP_CODE_DEBUG_PORT: String(PORT.guestCdp) }
  await ps(Object.entries(env).map(([k, val]) => `[Environment]::SetEnvironmentVariable('${k}', '${val}', 'User')`).join('; '))
  log(`installed ${version} as tcuser in ${Math.round((Date.now() - t0) / 1000)} s`)
  return version
}

export async function mapJ(): Promise<void> {
  const pass = readFileSync(SMB_PASS, 'utf8').trim()
  const mapped = await inSession(['C:\\Windows\\System32\\cmd.exe', '/c', `(net use J: /delete /y >nul 2>&1) & net use J: \\\\10.0.2.100\\JDRIVE ${pass} /user:jproof /persistent:no && dir /b J:\\Bench`], true, 180)
  const names = mapped.out.split(/\r?\n/).filter((l) => l.trim() && !/command completed/i.test(l))
  if (mapped.code !== 0 || names.length !== 300) throw new Error(`J: was not mapped with Bench's 300 entries: ${mapped.out.slice(-200)}`)
}

/** Paired with the box by a link, Work on, J:\Bench a folder; the box's workspace may use the PC; the bridge at Read. */
export async function setUpPc(stand: Standins, log: (m: string) => void): Promise<{ pcHost: string; boxOnPc: string }> {
  const pair = await rpc<{ url: string }>(stand.box, 'remote.pairings.create', { name: 'Rig PC', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'], ttlMinutes: 60 })
  const saved = await pcRpc<{ id: string }>('remote.environments.pair', { link: pair.url, name: 'tempcode-box' })
  await pcRpc('work.set', { enabled: true })
  await pcRpc('work.office.filesSetRoots', { roots: [{ folder: 'J:\\Bench' }] })
  // The PC's own id, as the box knows it once the PC registers there as a desktop.
  const pcHost = (await pcRpc<{ host: string }>('work.office.filesLibraries', {})).host
  const known = await until("the PC among the box's desktops", 120_000, async () => (await rpc<{ id: string }[]>(stand.box, 'work.desktops')).some((d) => d.id === pcHost), 2000)
  if (!known) throw new Error(`the box lists no desktop ${pcHost}: ${JSON.stringify(await rpc(stand.box, 'work.desktops'))}`)
  await rpc(stand.box, 'work.workspace.set', { workspaceId: stand.workspace, patch: { mayUseDesktop: [pcHost] } })
  await pcRpc('macBridge.policy.set', { environmentId: saved.id, policy: 'read' })
  log(`the PC: paired (${saved.id} there), Work on, J:\\Bench a folder; the box's workspace may use it (${pcHost}); its bridge for the box at Read`)
  return { pcHost, boxOnPc: saved.id }
}

export const saveState = (s: BenchState): void => (mkdirSync(BENCH, { recursive: true }), writeFileSync(join(BENCH, 'state.json'), JSON.stringify(s, null, 2)))
export const loadState = (): BenchState | null => (existsSync(join(BENCH, 'state.json')) ? (JSON.parse(readFileSync(join(BENCH, 'state.json'), 'utf8')) as BenchState) : null)
