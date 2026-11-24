/**
 * Create and edit a document on an isolated headless host from a paired desktop window.
 * Run from a built checkout through the box's heavy queue:
 *   EXPORT_PREVIEW_TOOLS=<installed work-tools dir> bun scripts/e2e-export-preview-remote.ts <picture dir>
 * Only the installed converter binaries are shared. Both apps have scratch profiles and work roots.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { freePort, killGroup } from './lib/devInstance'
import { attach, REPO, sleep, type Cdp } from './lib/packagedApp'
import type { FileDone, FilesOpened } from '../src/shared/work'
import type { ExportAnswer } from '../src/shared/contract-work-formats'

const title = 'Master plan'
const words = 'Confirm the venue and send the schedule.'
const tools = resolve(process.env.EXPORT_PREVIEW_TOOLS ?? '')
const output = process.argv[2]
if (!output || !process.env.EXPORT_PREVIEW_TOOLS || !existsSync(join(REPO, 'out', 'main', 'boot.js'))) {
  throw new Error('Set EXPORT_PREVIEW_TOOLS, pass a picture directory, and run from a built checkout')
}
const out = resolve(output)
mkdirSync(out, { recursive: true })
const root = mkdtempSync(join(tmpdir(), 'tc-export-preview-'))
const groups = new Set<number>()
let page: Cdp | undefined
let passed = false

async function launch(name: string, headless: boolean) {
  const home = join(root, name, 'home')
  const data = join(root, name, 'data')
  const work = join(root, name, 'work')
  const tmp = join(root, name, 'tmp')
  for (const path of [home, data, work, tmp]) mkdirSync(path, { recursive: true })
  if (headless) {
    const state = JSON.parse(readFileSync(join(tools, 'state.json'), 'utf8'))
    const installed = join(data, 'work-tools')
    mkdirSync(installed)
    const names = ['libreoffice', 'pdf-font']
    for (const tool of names) symlinkSync(join(tools, tool), join(installed, tool))
    writeFileSync(join(installed, 'state.json'), JSON.stringify({ ...state, tools: Object.fromEntries(names.map((tool) => [tool, state.tools[tool]])) }))
  }
  const remote = await freePort()
  const debug = await freePort()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^TEMP_CODE_|^ELECTRON_RUN_AS_NODE$/.test(key)))
  const log = openSync(join(root, name + '.log'), 'w')
  try {
    const proc = spawn('xvfb-run', ['-a', '-s', '-screen 0 1440x900x24 -nolisten tcp', 'dbus-run-session', '--', join(REPO, 'node_modules/.bin/electron'), '.'], {
      cwd: REPO,
      detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local/share'),
        XDG_CACHE_HOME: join(home, '.cache'),
        TMPDIR: tmp,
        NODE_ENV: 'production',
        AGENT_CLI_CREDENTIAL_STORE: 'file',
        WINVM_DIR: `${data}/no-vm`,
        TEMP_CODE_USER_DATA: data,
        TEMP_CODE_WORK_ROOT: work,
        TEMP_CODE_ALIAX_DATA_DIR: join(data, 'aliax'),
        TEMP_CODE_HEADLESS: headless ? '1' : '0',
        TEMP_CODE_REMOTE_PORT: String(remote),
        TEMP_CODE_DEBUG_PORT: String(debug),
        TEMP_CODE_CLAIM_SHIM: '0',
        TEMP_CODE_WARM_HARNESS: '0',
        TEMP_CODE_FAKE_PROVIDERS: 'http://127.0.0.1:9'
      }
    })
    if (!proc.pid) throw new Error(`Could not start ${name}`)
    groups.add(proc.pid)
  } finally {
    closeSync(log)
  }
  return { data, remote, debug }
}

async function waitFor<T>(name: string, read: () => T | Promise<T>, timeout = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeout
  do {
    const got = await read()
    if (got) return got
    await sleep(150)
  } while (Date.now() < end)
  throw new Error(`Timed out waiting for ${name}`)
}

async function local<T>(port: number, method: string, params: object = {}): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  try {
    return await new Promise<T>((ok, reject) => {
      const timer = setTimeout(() => reject(new Error(`No answer to ${method}`)), 30_000)
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'proof', method, params })))
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error(`Socket error on ${method}`))
      })
      ws.addEventListener('message', (ev) => {
        const answer = JSON.parse(String(ev.data))
        if (answer.id !== 'proof') return
        clearTimeout(timer)
        if (answer.ok) ok(answer.result)
        else reject(new Error(`${method}: ${answer.error}`))
      })
    })
  } finally {
    ws.close()
  }
}

async function click(cdp: Cdp, expression: string): Promise<void> {
  const at = await waitFor(expression, () => cdp.eval<{ x: number; y: number } | null>(`(() => {
    const el = (${expression})
    if (!el?.getClientRects().length) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`))
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, ...at, button: 'left', clickCount: 1 })
  }
}

async function stop(): Promise<void> {
  page?.close()
  for (const pgid of groups) killGroup(pgid, 'SIGTERM')
  await sleep(500)
  for (const pgid of groups) killGroup(pgid, 'SIGKILL')
  groups.clear()
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void stop().then(() => process.exit(1)))

try {
  const host = await launch('host', true)
  const client = await launch('client', false)
  const cdp = await attach(client.debug, 60_000)
  page = cdp
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  const clientPort = await waitFor('client socket', () => cdp.eval<number>('window.api.getServerPort()'))
  const hostPort = await waitFor('host socket', () => {
    const path = join(host.data, 'server.json')
    return existsSync(path) && (JSON.parse(readFileSync(path, 'utf8')) as { port: number }).port
  })
  await local(hostPort, 'work.set', { enabled: true })
  await local(clientPort, 'work.set', { enabled: true })
  const { environmentId } = await local<{ environmentId: string }>(hostPort, 'remote.status')
  const workspace = await local<{ id: string }>(hostPort, 'workspace.create', { kind: 'work', sector: 'purdue', name: 'Export preview proof' })
  const { token } = await local<{ token: string }>(hostPort, 'remote.keys.create', {
    name: 'Export preview proof', audience: 'client', caps: ['read', 'operate', 'approve', 'admin']
  })
  await local(clientPort, 'remote.environments.add', { url: `http://127.0.0.1:${host.remote}`, key: token, name: 'Proof host' })
  await cdp.eval('window.__monocode.loadSavedEnvironments()')
  const link = `window.__monocode.registry.linkOf(${JSON.stringify(environmentId)})`
  await waitFor('paired window connection', () => cdp.eval<boolean>(`window.__monocode.registry.has(${JSON.stringify(environmentId)}) && ${link}.connected`))
  const remote = <T>(method: string, params: object) => cdp.eval<T>(`${link}.request(${JSON.stringify(method)}, ${JSON.stringify(params)})`)
  const made = await remote<FileDone>('work.files.make', {
    workspaceId: workspace.id, at: { at: 'place', id: 'folder' }, kind: 'document', name: title, op: randomUUID()
  })
  const source = made.entries[0]?.ref
  if (!source || source.at !== 'file' || !source.path.endsWith('.tcdoc')) throw new Error('The host did not make a document')
  const opened = await remote<FilesOpened>('work.files.open', { workspaceId: workspace.id, ref: source })
  if (!opened.item || !opened.tabId) throw new Error('The host did not open the document')
  const wsLabel = JSON.stringify('Export preview proof')
  await click(cdp, `[...document.querySelectorAll('button, [role="button"]')].find(el => el.textContent.trim() === ${wsLabel})`)
  await click(cdp, `[...document.querySelectorAll('button, [role="tab"]')].find(el => el.textContent.trim() === 'Files')`)
  await click(cdp, `[...document.querySelectorAll('button, [role="tab"]')].find(el => el.textContent.trim() === ${JSON.stringify(opened.item.title)})`)
  await click(cdp, `document.querySelector('[data-editor-keys="document"] [contenteditable="true"]')`)
  // Hold one outgoing document update so Export opens while the last edit is still in transit.
  await cdp.eval(`(() => {
    const target = ${link}
    const request = target.request.bind(target)
    window.exportPreviewProof = { sent: false, formats: [], reads: 0, refusals: [] }
    const proof = window.exportPreviewProof
    target.request = async (method, params, opts) => {
      if (method === 'work.docs.send' && !proof.sent && params.frames.some((frame) => {
        const bytes = atob(frame)
        // Hocuspocus starts with a length-prefixed document name, then the message type and sync step.
        let at = 0, length = 0
        for (let shift = 0; at < bytes.length; shift += 7) {
          const byte = bytes.charCodeAt(at++)
          length += (byte & 127) * 2 ** shift
          if (byte < 128) break
        }
        const type = bytes.charCodeAt(at + length)
        return (type === 0 || type === 4) && bytes.charCodeAt(at + length + 1) === 2
      })) {
        proof.sent = true
        await new Promise(resolve => setTimeout(resolve, 1800))
      }
      if (method === 'work.formats.preview') proof.formats.push(params.format)
      if (method === 'work.formats.previewRead') proof.reads++
      try {
        return await request(method, params, opts)
      } catch (err) {
        if (method.startsWith('work.formats.')) proof.refusals.push([method, err.message])
        throw err
      }
    }
  })()`)
  await cdp.send('Input.insertText', { text: words })
  await waitFor('the edit in transit', () => cdp.eval<boolean>('window.exportPreviewProof.sent'))
  await cdp.eval(`window.dispatchEvent(new CustomEvent('work:command', { detail: { id: 'export' } }))`)
  await waitFor('Export Preview', () => cdp.eval('!!document.querySelector("[data-preview]")'))
  let failures = 0
  for (const [id, label] of [['docx', 'Word'], ['pdf', 'PDF'], ['print', 'Print'], ['md', 'Markdown'], ['html', 'Web page'], ['odt', 'OpenDocument'], ['rtf', 'Rich Text']]) {
    const format = JSON.stringify(label)
    if (await cdp.eval<boolean>(`!!document.querySelector('[data-preview-format="menu"]')`)) {
      await click(cdp, `document.querySelector('[data-preview-format="menu"] button')`)
      await click(cdp, `[...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')].find(el => el.textContent.trim().startsWith(${format}))`)
    } else {
      await click(cdp, `[...document.querySelectorAll('[data-preview-format] [role="tab"]')].find(el => el.textContent.trim() === ${format} && !el.closest('[inert]'))`)
    }
    const frame = `document.querySelector('[data-preview="${id}"]')`
    const ready = await waitFor(label, () => cdp.eval<string | false>(`(() => {
      const frame = ${frame}
      if (!frame) return false
      const failed = frame.querySelector('[data-preview-failed], [data-paged-page-failed]')
      if (failed) return failed.innerText
      const text = frame.querySelector('[data-preview-text], [data-pdf-text]')?.textContent
      if (text?.includes(${JSON.stringify(words)}) && (frame.querySelector('[data-preview-text]') || frame.querySelector('[data-paged-page] canvas'))) return 'drawn'
      if (frame.querySelector('iframe[srcdoc]')?.srcdoc.includes(${JSON.stringify(words)})) return 'drawn'
      return false
    })()`), 45_000).catch((err: Error) => err.message)
    await cdp.eval('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' }) as { data: string }
    writeFileSync(join(out, `${id}.png`), Buffer.from(image.data, 'base64'))
    if (ready !== 'drawn') failures++
    console.log(`${ready === 'drawn' ? 'PASS' : 'FAIL'} ${label}: ${ready}`)
  }
  const trace = await cdp.eval<{ formats: string[]; reads: number; refusals: [string, string][] }>('window.exportPreviewProof')
  for (const [method, reason] of trace.refusals) console.error(`${method}: ${reason}`)
  if (!['docx', 'pdf', 'odt', 'rtf'].every((format) => trace.formats.includes(format)) || trace.reads < 5) {
    throw new Error('The paired window did not draw and read its pages on the host')
  }
  console.log(`Paired host drew ${trace.formats.join(', ')} and answered ${trace.reads} range reads`)
  const docx = await remote<ExportAnswer>('work.formats.export', { source, format: 'docx' })
  if (!atob(docx.data).startsWith('PK')) throw new Error('The host did not export a Word file')
  console.log('The paired host also exported a Word file')
  if (failures) throw new Error(`${failures} previews failed`)
  passed = true
} catch (err) {
  console.error(`Instance logs: ${root}`)
  if (page) console.error(await page.eval<string>('document.body.innerText.slice(0, 2500)').catch(() => ''))
  throw err
} finally {
  await stop()
  if (passed) rmSync(root, { recursive: true, force: true })
}
