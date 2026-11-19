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
 *   bun scripts/e2e-computer-win.ts [--out DIR]
 *
 * Needs the rig up (scripts/win-vm/up.sh) and the exe built
 * (bun scripts/build-tc-computer-win.ts). Writes each observation text, the
 * wire, the shots and QMP's screens into DIR (default .temp-code/plans/landed/M43).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
import { compareToScreen, desktopState, getClipboard, qmpKeys, qmpShot, readPng, repo, setClipboard, sleep, socketTo, startService, tunnel, vm } from './lib/winComputerRig'

const out = resolve(process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(repo, '.temp-code/plans/landed/M43'))
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

async function main(): Promise<void> {
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
  check('the service starts on the desktop', await startService(GUEST_PORT))
  const ssh = await tunnel(LOCAL_PORT, GUEST_PORT)
  const sock = await socketTo(LOCAL_PORT)
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
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
