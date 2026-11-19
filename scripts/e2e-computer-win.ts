/**
 * Milestone 42's proof in the Windows rig (docs/computer-protocol.md §29.6):
 * tc-computer.exe, started on tcuser's desktop by the Task Scheduler
 * (run-in-session.sh), answers the wire over a loopback socket the SSH
 * tunnel carries to the box; every answer is held to the zod of §3, every
 * observation goes through parseObservation and formatObservation, and
 * set_value writes into Notepad with the pointer and the front window left
 * where they were.
 *
 *   bun scripts/e2e-computer-win.ts [--out DIR]
 *
 * Needs the rig up (scripts/win-vm/up.sh) and the exe built
 * (cargo xwin build --release --target x86_64-pc-windows-msvc in native/tc-computer-win).
 * Writes each observation text, the frames and QMP shots into DIR.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { formatObservation, parseObservation } from '../src/shared/computer/observation'
import {
  COMPUTER_METHODS,
  RpcErrorResponseSchema,
  resultFrameSchema,
  type ComputerMethod,
  type ComputerResult,
  type Observation
} from '../src/shared/computer/protocol'
import { STANDARD_USER, rigConfig, rigPaths } from './win-vm/config'

const repo = resolve(import.meta.dir, '..')
const out = resolve(process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(repo, '.temp-code/plans/landed/M42'))
mkdirSync(out, { recursive: true })
const EXE = join(repo, 'native/tc-computer-win/target/x86_64-pc-windows-msvc/release/tc-computer.exe')
const GUEST_PORT = 47820
const LOCAL_PORT = 47821

const rig = rigConfig()
const paths = rigPaths(rig)
const vm = (cmd: string, ...args: string[]) => spawnSync(join(repo, 'scripts/win-vm', `${cmd}.sh`), args, { encoding: 'utf8', timeout: 180_000 })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (what: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** What tcuser's desktop says: the pointer and the front window's title, from a program in the session. */
function desktopState(): { cursor: string; front: string } {
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices; using System.Text;',
    'public static class Fg { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); }',
    '"@',
    '$sb = New-Object System.Text.StringBuilder 512',
    '[void][Fg]::GetWindowText([Fg]::GetForegroundWindow(), $sb, 512)',
    '$p = [System.Windows.Forms.Cursor]::Position',
    'Write-Output ("cursor=" + $p.X + "," + $p.Y)',
    'Write-Output ("front=" + $sb.ToString())'
  ].join('\n')
  const encoded = Buffer.from(ps, 'utf16le').toString('base64')
  const r = vm('run-in-session', '--wait', '--timeout', '60', 'powershell.exe', '-NoProfile', '-EncodedCommand', encoded)
  const cursor = /cursor=(\S+)/.exec(r.stdout)?.[1] ?? `? ${r.stderr.trim()}`
  const front = /front=(.*)/.exec(r.stdout)?.[1]?.trim() ?? '?'
  return { cursor, front }
}

async function main(): Promise<void> {
  // the exe and its launcher in tcuser's home, the apps on the desktop
  check('the exe copies into the guest', vm('scp', EXE, 'guest:tc-computer.exe').status === 0)
  vm('ssh', '--ps', 'Stop-Process -Name tc-computer,notepad,msedge -Force -ErrorAction SilentlyContinue')
  vm('ssh', '--ps', `Set-Content -Encoding ascii -Path "$env:USERPROFILE\\tc-serve.cmd" -Value "@echo off\`r\`nset TC_COMPUTER_PROOF=1\`r\`n""%USERPROFILE%\\tc-computer.exe"" serve --listen 127.0.0.1:${GUEST_PORT} 2> ""%USERPROFILE%\\tc-computer.log""\`r\`n"`)
  vm('ssh', '--ps', 'Set-Content -Path "$env:USERPROFILE\\Documents\\m42-scratch.txt" -Value "scratch file for the M42 proof"')
  vm('ssh', '--ps', 'Set-Content -Path "$env:USERPROFILE\\m42-form.html" -Value "<!doctype html><title>M42 form</title><h1>Order</h1><label>Name <input id=n></label> <button>Send</button>"')
  check('Notepad starts on the desktop', vm('run-in-session', 'notepad.exe').status === 0)
  await sleep(3000)
  check(
    'Edge starts on the desktop',
    vm('run-in-session', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '--no-first-run', '--no-default-browser-check', '--inprivate', 'file:///C:/Users/tcuser/m42-form.html').status === 0
  )
  await sleep(6000)
  check('Explorer opens Documents on the desktop', vm('run-in-session', 'explorer.exe', 'C:\\Users\\tcuser\\Documents').status === 0)
  await sleep(4000)
  check('the service starts on the desktop', vm('run-in-session', '%USERPROFILE%\\tc-serve.cmd').status === 0)
  await sleep(2000)

  const tunnel = spawn(
    'ssh',
    [
      '-N', '-L', `${LOCAL_PORT}:127.0.0.1:${GUEST_PORT}`,
      '-i', paths.key, '-p', String(rig.sshPort),
      '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${paths.knownHosts}`,
      `${STANDARD_USER}@127.0.0.1`
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  )
  await sleep(2500)
  const sock: Socket = await new Promise((ok, no) => {
    const s = connect(LOCAL_PORT, '127.0.0.1', () => ok(s))
    s.once('error', no)
  })
  const waiting = new Map<number, (f: Record<string, unknown>) => void>()
  const frames: string[] = []
  createInterface({ input: sock }).on('line', (line) => {
    frames.push(line)
    const f = JSON.parse(line) as Record<string, unknown>
    if (typeof f.id === 'number') waiting.get(f.id)?.(f)
  })
  let next = 1
  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = next++
    sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise((ok, no) => {
      const t = setTimeout(() => no(new Error(`${method}: no answer in 20 s`)), 20_000)
      waiting.set(id, (f) => (clearTimeout(t), ok(f)))
    })
  }
  const seen = new Set<string>()
  const ok = async <M extends ComputerMethod>(method: M, params: Record<string, unknown> = {}): Promise<ComputerResult<M>> => {
    const f = await call(method, params)
    seen.add(method)
    const parsed = resultFrameSchema(method).safeParse(f)
    check(`${method} answers its result schema`, parsed.success, parsed.success ? '' : JSON.stringify(f).slice(0, 300))
    return (f as { result: ComputerResult<M> }).result
  }
  const no = async (what: string, method: string, params: Record<string, unknown>, kind: string | number): Promise<void> => {
    const f = await call(method, params)
    seen.add(method)
    const parsed = RpcErrorResponseSchema.safeParse(f)
    const got = parsed.success ? (typeof kind === 'number' ? parsed.data.error.code : parsed.data.error.data?.kind) : JSON.stringify(f).slice(0, 200)
    check(what, got === kind, String(got))
  }
  const grammar = (name: string, o: Observation): void => {
    writeFileSync(join(out, `${name}.txt`), o.text + '\n')
    let round = ''
    try {
      round = formatObservation(parseObservation(o.text))
    } catch (e) {
      round = String(e)
    }
    check(`${name}: the text parses and formats back to itself (${o.stats.elements} elements, ${o.stats.readMs} ms)`, round === o.text, round === o.text ? '' : round.slice(0, 200))
  }

  // the refusals before initialize
  await no('a call before initialize is not_initialized', 'apps.list', {}, 'not_initialized')
  await no('an unknown method is -32601', 'no.such', {}, -32601)
  await no('bad params are -32602', 'state.get', { app: {} }, -32602)
  await no('another protocol is protocol_mismatch', 'initialize', { protocol: 2, client: { name: 'm42', version: '1' }, dataDir: 'C:\\Users\\tcuser\\AppData\\Local\\Temp\\m42' }, 'protocol_mismatch')

  const init = await ok('initialize', { protocol: 1, client: { name: 'm42-proof', version: '1' }, dataDir: 'C:\\Users\\tcuser\\AppData\\Local\\Temp\\m42' })
  console.log(`     ${init.os.version} ${init.os.arch}, epoch ${init.epoch}, ${init.displays.length} display(s)`)
  await ok('permissions.get')
  await ok('permissions.request', { which: 'accessibility' })
  await ok('clipboard.state')
  const apps = await ok('apps.list', { windows: true })
  writeFileSync(join(out, 'apps.list.json'), JSON.stringify(apps, null, 2) + '\n')
  const names = apps.apps.map((a) => `${a.name} (${a.bundleId})`)
  console.log(`     apps: ${names.join(', ')}`)
  for (const exe of ['notepad.exe', 'msedge.exe', 'explorer.exe']) check(`apps.list names ${exe}`, apps.apps.some((a) => a.bundleId === exe))
  await ok('session.open', { session: 'm42' })
  await no('a read in a session never opened is unknown_session', 'state.get', { session: 'nope', app: { app: 'notepad.exe' } }, 'unknown_session')
  await no('an app that is not running is app_not_found', 'state.get', { session: 'm42', app: { app: 'Calculator Plus' } }, 'app_not_found')
  const launched = await ok('apps.launch', { app: 'notepad.exe' })
  check('apps.launch of a running app answers its pid, launched false', launched.launched === false && launched.pid > 0)

  const before = desktopState()
  const activeBefore = apps.apps.find((a) => a.active)?.name ?? 'none'
  console.log(`     desktop before: pointer ${before.cursor}, active app ${activeBefore}`)

  const notepad = await ok('state.get', { session: 'm42', app: { app: 'notepad.exe' } })
  grammar('notepad', notepad)
  const edge = await ok('state.get', { session: 'm42', app: { app: 'msedge.exe' }, wait: { minMs: 0, quietMs: 300, maxMs: 3000, busyMaxMs: 3000 } })
  grammar('edge', edge)
  check('Edge: the page is read (its heading and input)', /heading|text "Order"/.test(edge.text) && /input "Name"|"Name"/.test(edge.text))
  const explorer = await ok('state.get', { session: 'm42', app: { app: 'explorer.exe' }, window: { title: 'Documents' }, geometry: true })
  grammar('explorer', explorer)
  check('Explorer: the scratch file is a row', explorer.text.includes('m42-scratch'))
  await no('a window that is not there is window_not_found', 'state.get', { session: 'm42', app: { app: 'notepad.exe' }, window: { title: 'No such window' } }, 'window_not_found')

  // set_value into Notepad's text area, through UIA, without the pointer or the focus
  const area = /\[(\d+)\] text area/.exec(notepad.text) ?? /\[(\d+)\] (?:input|document)/.exec(notepad.text)
  check("Notepad's text area has an index", !!area, notepad.text.split('\n').slice(0, 3).join(' / '))
  vm('shot', join(out, 'before-set-value.png'))
  const text = 'Typed by tc-computer through UI Automation.'
  const r = await ok('action.run', { session: 'm42', app: { app: 'notepad.exe' }, epoch: notepad.epoch, action: { action: 'set_value', element: Number(area?.[1]), value: text }, tiers: ['ax', 'process'] })
  check('set_value runs at the ax tier and changes the window', r.step.status === 'ok' && r.step.tier === 'ax' && r.step.effect === 'changed', JSON.stringify(r.step).slice(0, 300))
  check('the closing read shows the text', !!r.observation?.text.includes(text))
  if (r.observation) grammar('notepad-after-set-value', r.observation)
  await sleep(500)
  vm('shot', join(out, 'after-set-value.png'))
  const after = desktopState()
  const activeAfter = (await ok('apps.list', {})).apps.find((a) => a.active)?.name ?? 'none'
  console.log(`     desktop after: pointer ${after.cursor}, active app ${activeAfter}`)
  check('the pointer did not move', after.cursor === before.cursor, `${before.cursor} → ${after.cursor}`)
  check('Notepad did not come to the front', activeAfter !== 'Notepad' && activeBefore !== 'Notepad', `${activeBefore} → ${activeAfter}`)

  // the ax tier's other verbs, and what it refuses
  const sel = await ok('action.run', { session: 'm42', app: { app: 'notepad.exe' }, epoch: notepad.epoch, action: { action: 'select_text', element: Number(area?.[1]), text: 'UI Automation' }, tiers: ['ax'] })
  check('select_text selects in Notepad', sel.step.status === 'ok' && !!sel.observation?.text.match(/selection \d+\.\.\d+/), sel.observation?.text.split('\n').find((l) => l.includes('text area')))
  const key = await ok('action.run', { session: 'm42', app: { app: 'notepad.exe' }, epoch: notepad.epoch, action: { action: 'key', text: 'Return' }, tiers: ['ax', 'process'] })
  check('a key step is action_unsupported until milestone 43', key.step.status === 'failed' && key.step.error.kind === 'action_unsupported')
  const stale = await ok('action.run', { session: 'm42', app: { app: 'notepad.exe' }, epoch: notepad.epoch, action: { action: 'left_click', element: 99999 }, tiers: ['ax'] })
  check('an index never given is no_such_element', stale.step.status === 'failed' && stale.step.error.kind === 'no_such_element')
  await no('an old epoch is stale_element', 'action.run', { session: 'm42', app: { app: 'notepad.exe' }, epoch: 'old', action: { action: 'left_click', element: 1 }, tiers: ['ax'] }, 'stale_element')
  const input = /\[(\d+)\] input "Name"/.exec(edge.text)
  if (input) {
    const e = await ok('action.run', { session: 'm42', app: { app: 'msedge.exe' }, epoch: edge.epoch, action: { action: 'set_value', element: Number(input[1]), value: 'Ada' }, tiers: ['ax'] })
    await sleep(1000)
    const again = await ok('state.get', { session: 'm42', app: { app: 'msedge.exe' } })
    check("set_value fills Edge's input", e.step.status === 'ok' && again.text.includes('input "Name" = "Ada"'), again.text.split('\n').find((l) => l.includes('"Name"')))
    grammar('edge-after-set-value', again)
  } else check("Edge's input is in the read", false)
  const batch = await ok('action.batch', { session: 'm42', app: { app: 'notepad.exe' }, epoch: notepad.epoch, actions: [{ action: 'cursor_position' }, { action: 'wait', duration: 0.3 }], tiers: ['ax'], wait: { minMs: 0, quietMs: 200, maxMs: 1000, busyMaxMs: 1000 } })
  check('action.batch runs its steps', batch.steps.every((s) => s.status === 'ok'))
  const sub = await ok('state.get', { session: 'm42', app: { app: 'notepad.exe' }, epoch: notepad.epoch, element: Number(area?.[1]) })
  check('a subtree read', sub.kind === 'subtree')

  // the rest of the methods, each held to its schema
  await no('capture is not built yet: capture_failed', 'capture.screenshot', { session: 'm42', app: { app: 'notepad.exe' } }, 'capture_failed')
  await no('the stream is not built yet: capture_failed', 'capture.stream.start', { session: 'm42', app: { app: 'notepad.exe' }, stream: 's' }, 'capture_failed')
  await ok('capture.stream.stop', { stream: 's' })
  await ok('escape.watch', { on: true })
  await ok('input.probe', { session: 'm42', app: { app: 'notepad.exe' } })
  await ok('input.restoreSession', {})
  await ok('session.close', { session: 'm42' })
  await ok('shutdown')
  const all = Object.keys(COMPUTER_METHODS)
  check('every method of §3 was called', all.every((m) => seen.has(m)), all.filter((m) => !seen.has(m)).join(', '))

  writeFileSync(join(out, 'wire.jsonl'), frames.join('\n') + '\n')
  sock.destroy()
  tunnel.kill()
  const log = vm('ssh', 'type %USERPROFILE%\\tc-computer.log')
  writeFileSync(join(out, 'service.log'), log.stdout)
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
