/**
 * The Windows computer service's proof in the rig (docs/computer-protocol.md
 * §29.6): tc-computer.exe, started on tcuser's desktop by the Task Scheduler
 * (run-in-session.sh), answers the wire over a loopback socket the SSH
 * tunnel carries to the box; every answer is held to the zod of §3 and every
 * observation goes through parseObservation and formatObservation.
 *
 * Milestone 42's part: apps, reads of Notepad, Edge and Explorer, and the ax
 * tier (set_value, select_text) with the pointer and the front window left
 * where they were. Milestone 43's part: clicks, typing, keys, scrolling and a
 * drag in Notepad and Edge at the process tier (pointer and front unmoved)
 * and at the session tier (put back by input.restoreSession), paste with the
 * person's clipboard given back, screenshots matched against QEMU's own
 * picture of the screen, zoom, the preview stream, Escape and a person's key
 * stopping a session step (both sent as hardware keys over QMP), and
 * apps.launch of an app that was not running.
 *
 * The video leg (§30, "The Windows service"): a window that redraws steadily
 * (a WinForms form a PowerShell draws, 60 times a second at most), the
 * door carrying the bytes pipe on its second connection, the host's own
 * ComputerConnection on the box reading the records and acking them; the
 * checks of §30's rules, then frames a second, bitrate and encode times
 * measured in `quality` and in `budget`, written down as measured.
 *
 *   bun scripts/e2e-computer-win.ts [--out DIR] [--legs wire,video]
 *
 * Needs the rig up (scripts/win-vm/up.sh) and the exe built
 * (bun scripts/build-tc-computer-win.ts). Writes each observation text, the
 * wire, the shots and QMP's screens into DIR (default .temp-code/plans/landed/M43).
 */
import type { Socket } from 'node:net'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
import { ComputerConnection } from '../src/main/server/computer/connection'
import { encodeAck, parseFrame } from '../src/shared/video/nsl1'
import { compareToScreen, desktopState, getClipboard, qmpKeys, qmpShot, readPng, repo, rigSpawn, setClipboard, sleep, doorTo, startService, tunnel, vm } from './lib/winComputerRig'

const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const out = resolve(arg('--out') ?? join(repo, '.temp-code/plans/landed/M43'))
const legs = new Set((arg('--legs') ?? 'wire,video').split(','))
mkdirSync(out, { recursive: true })
const GUEST_PORT = 47820
const LOCAL_PORT = 47821
const DATA = 'C:\\Users\\tcuser\\AppData\\Local\\Temp\\m43'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

let failures = 0
const check = (what: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** The test page: a heading a button changes, a field, a box that reports a drag, and a tall body whose scroll goes into the title. */
const PAGE = `<!doctype html><title>M43 page</title>
<style>body{font:16px sans-serif;margin:16px}#drag{width:360px;height:120px;background:#dde;user-select:none}#tall{height:4000px}</style>
<h1 id=h>Order</h1><label>Name <input id=n></label> <button id=add onclick="document.getElementById('h').textContent='Added '+(++window.k||(window.k=1))">Add</button>
<div id=drag>drag here</div><div id=tall>end</div>
<script>
let d=null;const box=document.getElementById('drag')
box.onmousedown=e=>{d=e.clientX}
addEventListener('mouseup',e=>{if(d!==null){document.title='drag='+Math.round(e.clientX-d);d=null}})
addEventListener('scroll',()=>{document.title='y='+Math.round(scrollY)})
</script>`

/** What a connection is sent before the far end closes it (5 s at most). */
const untilClosed = (s: Socket): Promise<string> =>
  new Promise((ok) => {
    let got = ''
    const t = setTimeout(() => (s.destroy(), ok(got)), 5000)
    s.on('data', (b: Buffer) => (got += b.toString()))
    s.on('close', () => (clearTimeout(t), ok(got)))
    s.on('error', () => undefined)
  })

/** The door's rules (§29.1), with the proof's host connected: a wrong token, a second host, a non-loopback address. */
async function doorLeg(token: string): Promise<void> {
  const wrong = await untilClosed(await doorTo(LOCAL_PORT, 'f'.repeat(64)))
  check('the door closes a connection with the wrong token, saying nothing', wrong === '', JSON.stringify(wrong))
  const none = await untilClosed(await doorTo(LOCAL_PORT, ''))
  check('the door closes a connection with no token', none === '', JSON.stringify(none))
  const second = await untilClosed(await doorTo(LOCAL_PORT, token))
  check('the door refuses a second host while one is connected', second.includes('another host is connected'), second.trim())
  const wide = vm('ssh', '%USERPROFILE%\\tc-computer.exe serve --listen 0.0.0.0:47899 --token-file %USERPROFILE%\\tc-token')
  check('serve --listen refuses a non-loopback address', wide.status === 64 && wide.stderr.includes('loopback'), `${wide.status} ${wide.stderr.trim()}`)
}

async function wireLeg(): Promise<void> {
  vm('ssh', '--ps', 'Stop-Process -Name tc-computer,notepad,msedge,charmap -Force -ErrorAction SilentlyContinue')
  vm('ssh', '--ps', 'Set-Content -Path "$env:USERPROFILE\\Documents\\m42-scratch.txt" -Value "scratch file for the M42 proof"')
  writeFileSync(join(out, 'm43-page.html'), PAGE)
  vm('scp', join(out, 'm43-page.html'), 'guest:m43-page.html')
  check('Notepad starts on the desktop', vm('run-in-session', 'notepad.exe').status === 0)
  await sleep(3000)
  check('Edge starts on the desktop', vm('run-in-session', EDGE, '--no-first-run', '--no-default-browser-check', '--inprivate', '--window-size=1000,700', 'file:///C:/Users/tcuser/m43-page.html').status === 0)
  await sleep(6000)
  check('Explorer opens Documents on the desktop', vm('run-in-session', 'explorer.exe', 'C:\\Users\\tcuser\\Documents').status === 0)
  await sleep(4000)
  const token = await startService(GUEST_PORT)
  check('the service starts on the desktop as its door', token !== null)
  const ssh = await tunnel(LOCAL_PORT, GUEST_PORT)
  const sock = await doorTo(LOCAL_PORT, token ?? '')
  await doorLeg(token ?? '')
  const waiting = new Map<number, (f: Record<string, unknown>) => void>()
  const frames: string[] = []
  const notes: Record<string, unknown>[] = []
  createInterface({ input: sock }).on('line', (line) => {
    const f = JSON.parse(line) as Record<string, unknown>
    // frames carry their picture inline: keep the line short in the record
    frames.push(f.method === 'capture/frame' ? JSON.stringify({ ...f, params: { ...(f.params as object), data: '…' } }) : line)
    if (typeof f.id === 'number') waiting.get(f.id)?.(f)
    else notes.push(f)
  })
  let next = 1
  const call = (method: string, params: Record<string, unknown> = {}, ms = 30_000): Promise<Record<string, unknown>> => {
    const id = next++
    sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise((ok, no) => {
      const t = setTimeout(() => no(new Error(`${method}: no answer in ${ms / 1000} s`)), ms)
      waiting.set(id, (f) => (clearTimeout(t), ok(f)))
    })
  }
  const note = async (method: string, ms = 5000): Promise<Record<string, unknown> | null> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const i = notes.findIndex((n) => n.method === method)
      if (i >= 0) return notes.splice(i, 1)[0]
      await sleep(25)
    }
    return null
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
  const indexOf = (o: Observation | undefined, re: RegExp): number => Number(/\[(\d+)\]/.exec(o?.text.split('\n').find((l) => re.test(l)) ?? '')?.[1] ?? NaN)
  const line = (o: Observation | undefined, re: RegExp): string => o?.text.split('\n').find((l) => re.test(l))?.trim() ?? '(none)'
  const W = { minMs: 0, quietMs: 300, maxMs: 3000, busyMaxMs: 3000 }

  // ── milestone 42: the wire, the reader, the ax tier ──────────────────

  await no('a call before initialize is not_initialized', 'apps.list', {}, 'not_initialized')
  await no('an unknown method is -32601', 'no.such', {}, -32601)
  await no('bad params are -32602', 'state.get', { app: {} }, -32602)
  await no('another protocol is protocol_mismatch', 'initialize', { protocol: 2, client: { name: 'm43', version: '1' }, dataDir: DATA }, 'protocol_mismatch')

  const init = await ok('initialize', { protocol: 1, client: { name: 'm43-proof', version: '1' }, dataDir: DATA })
  console.log(`     ${init.os.version} ${init.os.arch}, epoch ${init.epoch}, ${init.displays.length} display(s)`)
  await ok('permissions.get')
  await ok('permissions.request', { which: 'accessibility' })
  const apps = await ok('apps.list', { windows: true })
  writeFileSync(join(out, 'apps.list.json'), JSON.stringify(apps, null, 2) + '\n')
  console.log(`     apps: ${apps.apps.map((a) => `${a.name} (${a.bundleId})`).join(', ')}`)
  for (const exe of ['notepad.exe', 'msedge.exe', 'explorer.exe']) check(`apps.list names ${exe}`, apps.apps.some((a) => a.bundleId === exe))
  await ok('session.open', { session: 'm43' })
  await no('a read in a session never opened is unknown_session', 'state.get', { session: 'nope', app: { app: 'notepad.exe' } }, 'unknown_session')
  await no('an app that is not running is app_not_found', 'state.get', { session: 'm43', app: { app: 'Calculator Plus' } }, 'app_not_found')
  const running = await ok('apps.launch', { app: 'notepad.exe' })
  check('apps.launch of a running app answers its pid, launched false', running.launched === false && running.pid > 0)

  // the front: the active app as the service reads it, taken after the desktop probe (its own PowerShell is in front while it reads)
  const active = async (): Promise<string> => (await ok('apps.list', {})).apps.find((a) => a.active)?.name ?? 'none'
  const before = desktopState()
  await sleep(500)
  const activeBefore = await active()
  console.log(`     desktop before: pointer ${before.cursor}, active app ${activeBefore}`)

  const notepad = await ok('state.get', { session: 'm43', app: { app: 'notepad.exe' }, screenshot: 'never' })
  grammar('notepad', notepad)
  const edge = await ok('state.get', { session: 'm43', app: { app: 'msedge.exe' }, wait: W, screenshot: 'never' })
  grammar('edge', edge)
  check('Edge: the page is read (its heading and input)', /text "Order"|heading/.test(edge.text) && /"Name"/.test(edge.text))
  const explorer = await ok('state.get', { session: 'm43', app: { app: 'explorer.exe' }, window: { title: 'Documents' }, geometry: true, screenshot: 'never' })
  grammar('explorer', explorer)
  check('Explorer: the scratch file is a row', explorer.text.includes('m42-scratch'))
  await no('a window that is not there is window_not_found', 'state.get', { session: 'm43', app: { app: 'notepad.exe' }, window: { title: 'No such window' } }, 'window_not_found')

  const area = indexOf(notepad, /\] text area/)
  check("Notepad's text area has an index", Number.isFinite(area), notepad.text.split('\n').slice(0, 3).join(' / '))
  const np = (action: Record<string, unknown>, tiers: string[], extra: Record<string, unknown> = {}) =>
    ok('action.run', { session: 'm43', app: { app: 'notepad.exe' }, epoch: init.epoch, action, tiers, wait: W, observe: { screenshot: 'never' }, ...extra })
  const sv = await np({ action: 'set_value', element: area, value: 'Typed by tc-computer through UI Automation.' }, ['ax', 'process'])
  check('set_value runs at the ax tier and changes the window', sv.step.status === 'ok' && sv.step.tier === 'ax' && sv.step.effect === 'changed', JSON.stringify(sv.step).slice(0, 300))
  const activeSetValue = await active()
  // recorded, not judged: the ax verbs are milestone 42's (M43.md says what this rig showed)
  console.log(`     the front app after set_value in Notepad: ${activeSetValue} (before: ${activeBefore})`)
  const sel = await np({ action: 'select_text', element: area, text: 'UI Automation' }, ['ax'])
  check('select_text selects in Notepad', sel.step.status === 'ok' && /selection \d+\.\.\d+/.test(sel.observation?.text ?? ''), line(sel.observation, /text area/))
  const never = await np({ action: 'left_click', element: 99999 }, ['ax'])
  check('an index never given is no_such_element', never.step.status === 'failed' && never.step.error.kind === 'no_such_element')
  await no('an old epoch is stale_element', 'action.run', { session: 'm43', app: { app: 'notepad.exe' }, epoch: 'old', action: { action: 'left_click', element: 1 }, tiers: ['ax'] }, 'stale_element')
  const activeNotepadAx = await active()
  console.log(`     the front app after select_text in Notepad: ${activeNotepadAx}`)
  const field = indexOf(edge, /input "Name"/)
  const ed = (action: Record<string, unknown>, tiers: string[], extra: Record<string, unknown> = {}) =>
    ok('action.run', { session: 'm43', app: { app: 'msedge.exe' }, epoch: init.epoch, action, tiers, wait: W, observe: { screenshot: 'never' }, ...extra })
  const fill = await ed({ action: 'set_value', element: field, value: 'Ada' }, ['ax'])
  check("set_value fills Edge's input", fill.step.status === 'ok' && /input "Name" = "Ada"/.test(fill.observation?.text ?? ''), line(fill.observation, /"Name"/))
  const activeEdgeAx = await active()
  console.log(`     the front app after set_value in Edge: ${activeEdgeAx}`)
  const sub = await ok('state.get', { session: 'm43', app: { app: 'notepad.exe' }, epoch: init.epoch, element: area })
  check('a subtree read', sub.kind === 'subtree')

  const activeMid = await active()
  const mid = desktopState()
  check('the ax tier did not move the pointer', mid.cursor === before.cursor, `${before.cursor} → ${mid.cursor} (front app ${activeMid})`)

  // ── milestone 43: the process tier, in the background ────────────────

  vm('shot', join(out, 'before-input.png'))
  await sleep(500)
  const activeProcess = await active()
  const end = await np({ action: 'key', text: 'End', element: area }, ['process'])
  check('key End at the process tier', end.step.status === 'ok' && end.step.tier === 'process', JSON.stringify(end.step).slice(0, 200))
  const typed = await np({ action: 'type', element: area, text: ' And by keys.\nA second line.' }, ['ax', 'process'])
  const typedLine = line(typed.observation, /text area/)
  check('type into Notepad by keys at the process tier, a line break as Return', typed.step.status === 'ok' && typed.step.tier === 'process' && typed.step.input?.via === 'keys' && typed.observation?.text.includes('A second line') === true && typed.step.effect === 'changed', `${JSON.stringify(typed.step).slice(0, 160)} · ${typedLine}`)
  const combo = await np({ action: 'key', text: 'ctrl+a' }, ['ax', 'process'])
  check('ctrl+a needs the session tier: a posted key carries no modifier', combo.step.status === 'failed' && combo.step.error.kind === 'needs_tier' && combo.step.error.needed === 'session')

  const add = indexOf(edge, /button "Add"/)
  const click = await ed({ action: 'left_click', coordinate: undefined, element: add }, ['process'])
  const added = /Added 1/.test(click.observation?.text ?? '')
  check('a click on Edge\'s "Add" button at the process tier', click.step.status === 'ok' && click.step.tier === 'process' && added, `${JSON.stringify(click.step).slice(0, 160)} · ${line(click.observation, /Added|"Order"/)}`)
  const scroll = await ed({ action: 'scroll', scroll_direction: 'down', scroll_amount: 5 }, ['process'])
  const scrolled = /window "y=\d*[1-9]/.test(scroll.observation?.text.split('\n')[0] ?? '') || /y=[1-9]/.test(scroll.observation?.window.title ?? '')
  check('a scroll of Edge\'s page at the process tier', scroll.step.status === 'ok' && scroll.step.tier === 'process' && scrolled, scroll.observation?.window.title ?? '')
  await ed({ action: 'scroll', scroll_direction: 'up', scroll_amount: 10 }, ['process'])
  const shot = await ok('capture.screenshot', { session: 'm43', app: { app: 'msedge.exe' }, format: 'png', maxEdge: 2576 })
  const sp = shot.scale
  const box = await ok('state.get', { session: 'm43', app: { app: 'msedge.exe' }, geometry: true, screenshot: 'never' })
  const dragLine = box.text.split('\n').find((l) => l.includes('"drag here"')) ?? ''
  const at = /@(\d+),(\d+) (\d+)×(\d+)/.exec(dragLine)
  if (at) {
    const [x, y, w, h] = at.slice(1).map(Number)
    const drag = await ed({ action: 'left_click_drag', start_coordinate: [x + 20, y + Math.floor(h / 2)], coordinate: [x + 20 + Math.round(150 * sp), y + Math.floor(h / 2)] }, ['process'])
    check('a drag in Edge at the process tier', drag.step.status === 'ok' && drag.step.tier === 'process' && /drag=1[45]\d/.test(drag.observation?.window.title ?? ''), `${drag.observation?.window.title} (w ${w})`)
  } else check("the drag box's place is in the read", false, dragLine)

  const activeQuiet = await active()
  const quiet = desktopState()
  check('the process tier moved neither the pointer nor the front app', quiet.cursor === before.cursor && activeQuiet === activeProcess, `${before.cursor} ${activeProcess} → ${quiet.cursor} ${activeQuiet}`)

  // paste: the person's copy is given back
  setClipboard('the person copied this')
  await sleep(5500)
  const paste = await np({ action: 'paste', element: area, text: ' Pasted **once**.', format: 'markdown' }, ['process'])
  // Notepad takes plain text: the markdown's source is what it shows
  check('paste into Notepad at the process tier', paste.step.status === 'ok' && paste.step.input?.via === 'paste' && /Pasted \*\*once\*\*\./.test(paste.observation?.text ?? ''), `${JSON.stringify(paste.step.input)} · ${line(paste.observation, /text area/).slice(-80)}`)
  check('the clipboard holds the person\'s copy again', paste.step.input?.clipboard === 'restored' && getClipboard() === 'the person copied this', getClipboard())

  // ── screenshots against QEMU's own picture ───────────────────────────

  const npShot = await ok('action.run', { session: 'm43', app: { app: 'notepad.exe' }, action: { action: 'screenshot' }, tiers: ['process'], observe: { mode: 'none', maxEdge: 2576 } })
  check('a screenshot step writes a shot and sets the space', npShot.step.status === 'ok' && !!npShot.step.shot && npShot.step.shot.scale === 1, JSON.stringify(npShot.step.shot ?? npShot.step).slice(0, 200))
  const zoom = await ok('action.run', { session: 'm43', app: { app: 'notepad.exe' }, action: { action: 'zoom', region: [0, 0, 200, 100] }, tiers: ['process'], observe: { mode: 'none' } })
  check('zoom writes the region at full resolution', zoom.step.status === 'ok' && zoom.step.shot?.width === 200 && zoom.step.shot?.height === 100, JSON.stringify(zoom.step.shot ?? zoom.step).slice(0, 200))

  // what the session tier will take: the pointer, then the front app
  const pointerBeforeSession = desktopState().cursor
  await sleep(500)
  const activeBeforeSession = await active()

  // each window in front in turn (session tier, so the PC's own screen shows it whole), then both pictures compared
  for (const [app, name] of [['notepad.exe', 'notepad'], ['msedge.exe', 'edge']] as const) {
    const raise = await ok('action.run', { session: 'm43', app: { app }, action: { action: 'mouse_move', coordinate: [5, 5] }, tiers: ['session'], observe: { mode: 'none' } })
    await sleep(800)
    const s = await ok('capture.screenshot', { session: 'm43', app: { app }, format: 'png', maxEdge: 2576 })
    const file = join(out, `${name}-shot.png`)
    vm('scp', `guest:${s.path.replace(/^C:\\Users\\tcuser\\/i, '').replace(/\\/g, '/')}`, file)
    const screen = join(out, `${name}-qmp.png`)
    await qmpShot(screen)
    try {
      const d = compareToScreen(readPng(readFileSync(file)), readPng(readFileSync(screen)), { x: s.window.frame.x, y: s.window.frame.y })
      check(`${name}: the shot matches QEMU's screen where the window is (scale ${s.scale}, ${s.width}×${s.height})`, raise.step.status === 'ok' && s.scale === 1 && d.mean < 4 && d.off < 0.02, `mean ${d.mean.toFixed(2)}, ${(d.off * 100).toFixed(2)}% off`)
    } catch (e) {
      check(`${name}: the shot and the screen compare`, false, String(e))
    }
  }

  // ── the session tier, then put back ──────────────────────────────────

  const sess = await np({ action: 'key', text: 'ctrl+End', element: area }, ['session'])
  const sessType = await np({ action: 'type', element: area, text: ' Session keys.' }, ['session'])
  check('ctrl+End and typing at the session tier', sess.step.status === 'ok' && sess.step.tier === 'session' && sessType.step.status === 'ok' && /Session keys\./.test(sessType.observation?.text ?? ''), `${JSON.stringify(sess.step).slice(-200)} · ${JSON.stringify(sessType.step).slice(-300)}`)
  const back = await ok('input.restoreSession', {})
  await sleep(800)
  const activeBack = await active()
  const restored = desktopState()
  check('input.restoreSession puts the pointer and the front app back', back.pointer === 'restored' && back.frontmost === 'restored' && restored.cursor === pointerBeforeSession && activeBack === activeBeforeSession, `${JSON.stringify(back)} · ${pointerBeforeSession} ${activeBeforeSession} → ${restored.cursor} ${activeBack}`)

  // the person's own key stops a session step; Escape is told while watched
  const holding = np({ action: 'hold_key', text: 'shift', duration: 2 }, ['session'])
  await sleep(700)
  await qmpKeys('a')
  const held = await holding
  check("a person's key stops a session step", held.step.status === 'failed' && held.step.error.kind === 'interrupted' && held.step.error.by === 'person', JSON.stringify(held.step).slice(0, 200))
  check('session/interrupted is sent', !!(await note('session/interrupted')))
  await ok('input.restoreSession', {})
  await ok('escape.watch', { on: true, leaseMs: 10_000 })
  await qmpKeys('esc')
  check('Escape while watched is escape/pressed', !!(await note('escape/pressed')))
  await ok('escape.watch', { on: false })

  // ── the stream ───────────────────────────────────────────────────────

  const st = await ok('capture.stream.start', { session: 'm43', app: { app: 'msedge.exe' }, stream: 'p1', fps: 4, maxEdge: 640 })
  const f1 = await note('capture/frame')
  check('the stream sends a frame of the size it answered', !!f1 && (f1.params as { width: number }).width === st.width, `${st.width}×${st.height}`)
  if (f1) writeFileSync(join(out, 'stream-frame.jpg'), Buffer.from((f1.params as { data: string }).data, 'base64'))
  sock.write(JSON.stringify({ jsonrpc: '2.0', method: 'capture.stream.ack', params: { stream: 'p1', seq: (f1?.params as { seq: number } | undefined)?.seq ?? 0 } }) + '\n')
  await ed({ action: 'left_click', element: add }, ['process'])
  const click2 = await note('capture/click')
  const f2 = await note('capture/frame')
  check('a click marks the stream and new pixels send a frame', !!click2 && !!f2, JSON.stringify(click2?.params ?? null))
  await ok('capture.stream.stop', { stream: 'p1' })
  // started with no bytes pipe, the service never named video: the two calls are unknown (the video leg has the pipe)
  await no('without a video pipe capture.video.start answers as an unknown method', 'capture.video.start', { session: 'm43', app: { app: 'msedge.exe' }, maxEdge: 1280, mode: 'quality' }, -32601)
  await no('and so does capture.video.stop', 'capture.video.stop', { stream: 1 }, -32601)
  check('stopping ends the stream', ((await note('capture/streamEnded'))?.params as { reason?: string } | undefined)?.reason === 'stopped')

  // ── launching ────────────────────────────────────────────────────────

  const launch = await ok('apps.launch', { app: 'charmap.exe' })
  check('apps.launch starts an app that was not running', launch.launched === true && launch.pid > 0 && !!launch.window, JSON.stringify(launch))
  await no('open refuses a program as an item', 'apps.launch', { app: 'notepad.exe', open: ['C:\\Windows\\System32\\cmd.exe'] }, 'open_refused')

  // ── the rest ─────────────────────────────────────────────────────────

  await ok('clipboard.state')
  await ok('input.probe', { session: 'm43', app: { app: 'notepad.exe' } })
  await ok('action.batch', { session: 'm43', app: { app: 'notepad.exe' }, epoch: init.epoch, actions: [{ action: 'cursor_position' }, { action: 'wait', duration: 0.3 }], tiers: ['ax'], wait: W })
  await ok('session.close', { session: 'm43' })
  await ok('shutdown')
  const all = Object.keys(COMPUTER_METHODS)
  check('every method of §3 was called', all.every((m) => seen.has(m)), all.filter((m) => !seen.has(m)).join(', '))
  vm('shot', join(out, 'after.png'))

  writeFileSync(join(out, 'wire.jsonl'), frames.join('\n') + '\n')
  sock.destroy()
  ssh.kill()
  vm('ssh', '--ps', 'Stop-Process -Name charmap -Force -ErrorAction SilentlyContinue')
  writeFileSync(join(out, 'service.log'), vm('ssh', 'type %USERPROFILE%\\tc-computer.log').stdout)
}

async function main(): Promise<void> {
  if (legs.has('wire')) await wireLeg()
  if (legs.has('video')) await videoLeg()
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
  process.exit(failures ? 1 : 0)
}

// ── the video leg ──────────────────────────────────────────────────────

/**
 * A window that redraws steadily: a bar that moves and a counter, on a 10 ms timer (the least a window timer
 * takes, with the system's timer at 1 ms); it closes when a file appears and writes how many times it drew.
 */
const VIDEO_WINDOW = `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace TcVideo -Name Winmm -MemberDefinition '[DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint p);'
[void][TcVideo.Winmm]::timeBeginPeriod(1)
$clock = [Diagnostics.Stopwatch]::StartNew()
$f = New-Object System.Windows.Forms.Form
$f.Text = 'tc video proof'
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(160, 60)
$f.ClientSize = New-Object System.Drawing.Size(960, 600)
$f.BackColor = [System.Drawing.Color]::White
[System.Windows.Forms.Control].GetProperty('DoubleBuffered', [Reflection.BindingFlags]'NonPublic,Instance').SetValue($f, $true, $null)
$font = New-Object System.Drawing.Font('Segoe UI', 40)
$script:n = 0
$f.Add_Paint({ param($s, $e)
  $x = ($script:n * 9) % 900
  $e.Graphics.FillRectangle([System.Drawing.Brushes]::SteelBlue, $x, 220, 60, 260)
  $e.Graphics.DrawString("frame $($script:n)", $font, [System.Drawing.Brushes]::Black, 24, 24) })
$t = New-Object System.Windows.Forms.Timer
$t.Interval = 10
$t.Add_Tick({
  $script:n++
  if ($script:n % 50 -eq 0) { Set-Content -Path "$env:USERPROFILE\\tc-video-drawn.txt" -Value "$($script:n) $($clock.ElapsedMilliseconds)" }
  if ($script:n % 20 -eq 0 -and (Test-Path "$env:USERPROFILE\\tc-video-close")) { $f.Close() } else { $f.Invalidate() } })
$t.Start()
[System.Windows.Forms.Application]::Run($f)
`

/** The NAL unit types of an Annex B access unit. */
function nalTypes(au: Uint8Array): number[] {
  const types: number[] = []
  for (let i = 0; i + 3 < au.length; i++) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      types.push(au[i + 3] & 0x1f)
      i += 3
    }
  }
  return types
}

interface Got {
  stream: number
  generation: number
  sequence: number
  keyframe: boolean
  width: number
  height: number
  bytes: number
  types: number[]
  at: number
}

async function videoLeg(): Promise<void> {
  const [GUEST, LOCAL] = [47830, 47831]
  const guestData = 'C:\\Users\\tcuser\\AppData\\Local\\Temp\\video-proof'
  vm('ssh', '--ps', 'Stop-Process -Name tc-computer -Force -ErrorAction SilentlyContinue; Remove-Item "$env:USERPROFILE\\tc-video-close","$env:USERPROFILE\\tc-video-drawn.txt" -ErrorAction SilentlyContinue')
  writeFileSync(join(out, 'tc-video-window.ps1'), VIDEO_WINDOW)
  vm('scp', join(out, 'tc-video-window.ps1'), 'guest:tc-video-window.ps1')
  const drawn = vm('run-in-session', 'powershell.exe', '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Users\\tcuser\\tc-video-window.ps1')
  check('a window that redraws starts on the desktop', drawn.status === 0, drawn.stderr.trim())
  await sleep(5000)
  const token = await startService(GUEST)
  check('the service starts on the desktop as its door', token !== null)
  const tunnels = [await tunnel(LOCAL, GUEST)]
  const hostDir = join(tmpdir(), `tc-video-proof-${process.pid}`)
  mkdirSync(hostDir, { recursive: true })
  const hostLog: string[] = []
  const conn = await ComputerConnection.start({
    bin: 'tc-computer.exe',
    dataDir: hostDir,
    spawn: rigSpawn(LOCAL, token ?? '', guestData, hostDir, true),
    videoPipe: 'named',
    videoPipeName: join(hostDir, 'video.sock'),
    log: (l) => hostLog.push(l)
  })
  check('the service names video and the host has its pipe', conn.video, JSON.stringify(conn.init.features))

  const got: Got[] = []
  const acking = new Set<number>()
  conn.onBytes((stream, message) => {
    const f = parseFrame(message)
    got.push({ stream, generation: f.generation, sequence: f.sequence, keyframe: f.keyframe, width: f.width, height: f.height, bytes: f.data.byteLength, types: f.keyframe ? nalTypes(f.data) : [], at: performance.now() })
    if (acking.has(stream)) conn.sendBytes(stream, encodeAck(f.generation, f.sequence))
  })
  const ended: { stream: number; reason: string }[] = []
  conn.onNotification((n) => {
    if (n.method === 'capture/videoEnded') ended.push(n.params as { stream: number; reason: string })
  })
  const target = { session: 'video', app: { app: 'powershell.exe' }, window: { title: 'tc video proof' } }
  await conn.request('session.open', { session: 'video' })
  const of = (stream: number): Got[] => got.filter((g) => g.stream === stream)
  /** From now on every frame of the stream is acked as it comes, and those that came already are acked now. */
  const ackFrom = (stream: number): void => {
    acking.add(stream)
    for (const g of of(stream)) conn.sendBytes(stream, encodeAck(g.generation, g.sequence))
  }

  /** One stream for 10 s with every frame acked: frames a second, bitrate, and §30's checks. */
  const measure = async (mode: 'quality' | 'budget', maxEdge: number, firstHeld: boolean) => {
    const start = await conn.request('capture.video.start', { ...target, maxEdge, mode })
    const { stream } = start
    if (firstHeld) {
      // no ack yet: the flow's window is one frame until the first ack comes back
      await sleep(1000)
      const before = of(stream).length
      check(`${mode}: before any ack one frame comes, no more`, before === 1, `${before} in 1 s`)
    }
    ackFrom(stream)
    const drawn = (): [number, number] => (vm('ssh', 'type %USERPROFILE%\\tc-video-drawn.txt').stdout.trim().split(/\s+/).map(Number) as [number, number])
    const d0 = drawn()
    const from = performance.now()
    await sleep(10_000)
    const d1 = drawn()
    const window = of(stream).filter((g) => g.at >= from && g.at < from + 10_000)
    await conn.request('capture.video.stop', { stream })
    // records the service queued before it answered may still be on their way (the relay and a second tunnel)
    const answered = of(stream).length
    await sleep(500)
    const all = of(stream)
    const settled = of(stream).length
    await sleep(1500)
    check(`${mode}: a stopped stream sends nothing more`, of(stream).length === settled, `${settled - answered} still in flight at the answer, ${of(stream).length - settled} after`)
    check(`${mode}: a stop says nothing`, !ended.some((e) => e.stream === stream))
    const first = all[0]
    check(`${mode}: the first frame is a keyframe with an SPS and a PPS`, !!first?.keyframe && first.types.includes(7) && first.types.includes(8), JSON.stringify(first?.types))
    const gens = [...new Set(all.map((g) => g.generation))]
    const runs = gens.every((gen) => all.filter((g) => g.generation === gen).every((g, i) => g.sequence === i + 1))
    check(`${mode}: sequences run 1, 2, 3 … with no gap`, runs && gens.every((gen) => all.find((g) => g.generation === gen)?.keyframe), `generations ${gens.join(',')}, ${all.length} frames`)
    check(`${mode}: every frame is the size start answered`, all.every((g) => g.width === start.width && g.height === start.height), `${start.width}×${start.height}`)
    check(`${mode}: more than 8 frames come once acks reach the service`, all.length > 8, `${all.length}`)
    const bytes = window.reduce((n, g) => n + g.bytes, 0)
    const drawsPerSecond = (d1[0] - d0[0]) / ((d1[1] - d0[1]) / 1000)
    return { mode, stream, width: start.width, height: start.height, frames: window.length, fps: window.length / 10, drawsPerSecond, mbps: (bytes * 8) / 10 / 1e6, keyframes: all.filter((g) => g.keyframe).length }
  }

  const quality = await measure('quality', 3840, true)
  const budget = await measure('budget', 1280, false)

  // the window closes: its stream ends on its own
  const last = await conn.request('capture.video.start', { ...target, maxEdge: 640, mode: 'quality' })
  ackFrom(last.stream)
  await sleep(1000)
  vm('ssh', '--ps', 'Set-Content -Path "$env:USERPROFILE\\tc-video-close" -Value 1')
  const until = Date.now() + 8000
  while (Date.now() < until && !ended.some((e) => e.stream === last.stream)) await sleep(50)
  check('a closed window ends its stream with window-closed', ended.find((e) => e.stream === last.stream)?.reason === 'window-closed', JSON.stringify(ended))

  await conn.request('session.close', { session: 'video' })
  await conn.shutdown()
  for (const t of tunnels) t.kill()
  await sleep(500)
  const log = vm('ssh', 'type %USERPROFILE%\\tc-computer.log').stdout
  writeFileSync(join(out, 'video-service.log'), log)
  writeFileSync(join(out, 'video-host.log'), hostLog.join('\n') + '\n')
  const stats = (stream: number): Record<string, string> => {
    const line = log.split(/\r?\n/).find((l) => l.startsWith(`video ${stream}: frames=`)) ?? ''
    return Object.fromEntries([...line.matchAll(/(\w+)=((?:[^ =]| (?!\w+=))+)/g)].map((m) => [m[1], m[2].trim()]))
  }
  const rows = [quality, budget].map((r) => ({ ...r, service: stats(r.stream) }))
  console.log('\nmeasured in the rig (no GPU), 10 s each, every frame acked at once:')
  console.log('| mode | picture | frames a second | the window drew a second | bitrate | keyframes | encode p50 | encode p95 | capture | encoder |')
  console.log('|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    console.log(`| ${r.mode} | ${r.width}×${r.height} | ${r.fps.toFixed(1)} | ${r.drawsPerSecond.toFixed(1)} | ${r.mbps.toFixed(2)} Mbit/s | ${r.keyframes} | ${r.service.encode_p50_ms ?? '?'} ms | ${r.service.encode_p95_ms ?? '?'} ms | ${r.service.capture ?? '?'} | ${r.service.encoder ?? '?'} |`)
  }
  writeFileSync(join(out, 'video.json'), JSON.stringify({ rows, ended }, null, 2) + '\n')
  rmSync(hostDir, { recursive: true, force: true })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
