/**
 * Save As from a paired window into a dummy Teams library on its headless host.
 * Run from a built checkout through the box's heavy queue:
 *   SAVE_AS_TOOLS=<installed work-tools dir> bun scripts/e2e-save-as-remote.ts <picture dir>
 * The two apps use scratch homes, profiles, VM roots and ports.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { freePort, killGroup } from './lib/devInstance'
import { attach, REPO, sleep, type Cdp } from './lib/packagedApp'
import type { FileDone, FilesOpened } from '../src/shared/work'
import type { FilesPlaces } from '../src/shared/contract-work-files'
import type { ExportAnswer } from '../src/shared/contract-work-formats'

const title = 'Match day plan'
const workspaceName = 'Save As proof'
const libraryName = 'Esports'
const channelName = 'General'
const folderName = 'Runbooks'
const tools = resolve(process.env.SAVE_AS_TOOLS ?? '')
const output = process.argv[2]
if (!output || !process.env.SAVE_AS_TOOLS || !existsSync(join(REPO, 'out', 'main', 'boot.js'))) {
  throw new Error('Set SAVE_AS_TOOLS, pass a picture directory, and run from a built checkout')
}
const out = resolve(output)
mkdirSync(out, { recursive: true })
const root = mkdtempSync(join(tmpdir(), 'tc-save-as-'))
const groups = new Set<number>()
let page: Cdp | undefined
let passed = false
let step = 'start the isolated pair'
let inspect: (() => Promise<unknown>) | undefined

async function launch(name: string, headless: boolean) {
  const home = join(root, name, 'home')
  const data = join(root, name, 'data')
  const work = join(root, name)
  const tmp = join(root, name, 'tmp')
  for (const path of [home, data, work, tmp]) mkdirSync(path, { recursive: true })
  const library = join(
    home,
    'Library',
    'CloudStorage',
    'OneDrive-SharedLibraries-proof.edu',
    libraryName + ' - Documents'
  )
  const folder = join(library, channelName, folderName)
  if (headless) {
    mkdirSync(folder, { recursive: true })
    const state = JSON.parse(readFileSync(join(tools, 'state.json'), 'utf8'))
    const installed = join(data, 'work-tools')
    mkdirSync(installed)
    const names = ['libreoffice', 'pdf-tools']
    for (const name of names) {
      const tool = state.tools[name]
      if (!tool?.ok || !existsSync(join(tools, tool.dir, tool.bin)))
        throw new Error(`Missing ${name} under SAVE_AS_TOOLS`)
    }
    const directories = new Set<string>(names.map((name) => state.tools[name].dir.split('/')[0]))
    for (const dir of directories) symlinkSync(join(tools, dir), join(installed, dir))
    writeFileSync(
      join(installed, 'state.json'),
      JSON.stringify({
        ...state,
        tools: Object.fromEntries(names.map((tool) => [tool, state.tools[tool]]))
      })
    )
  }
  const remote = await freePort()
  const debug = await freePort()
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^TEMP_CODE_|^ELECTRON_RUN_AS_NODE$/.test(key))
  )
  const log = openSync(join(root, name + '.log'), 'w')
  try {
    const proc = spawn(
      'xvfb-run',
      [
        '-a',
        '-s',
        '-screen 0 1440x900x24 -nolisten tcp',
        'dbus-run-session',
        '--',
        join(REPO, 'node_modules/.bin/electron'),
        '.'
      ],
      {
        cwd: REPO,
        detached: true,
        stdio: ['ignore', log, log],
        env: {
          ...env,
          WINVM_DIR: join(work, 'no-vm'),
          HOME: home,
          XDG_CONFIG_HOME: join(home, '.config'),
          XDG_DATA_HOME: join(home, '.local/share'),
          XDG_CACHE_HOME: join(home, '.cache'),
          TMPDIR: tmp,
          NODE_ENV: 'production',
          AGENT_CLI_CREDENTIAL_STORE: 'file',
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
      }
    )
    if (!proc.pid) throw new Error(`Could not start ${name}`)
    groups.add(proc.pid)
  } finally {
    closeSync(log)
  }
  return { data, remote, debug, folder }
}

async function waitFor<T>(
  name: string,
  read: () => T | Promise<T>,
  timeout = 30_000
): Promise<NonNullable<T>> {
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
  const at = await waitFor(expression, () =>
    cdp.eval<{ x: number; y: number } | null>(`(() => {
    const el = (${expression})
    if (!el?.getClientRects().length || el.disabled) return null
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  )
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
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.once(sig, () => void stop().then(() => process.exit(1)))

const sheet = '[data-save-as]'
const editor = '[data-editor-keys="document"] [contenteditable="true"]'
const button = (label: string, within = 'document'): string =>
  `[...${within}.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)})`
const option = (label: string): string =>
  `[...document.querySelectorAll('${sheet} [role="option"]')].find(el => el.textContent.trim() === ${JSON.stringify(label)})`

async function shot(cdp: Cdp, name: string): Promise<void> {
  await cdp.eval(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
  )
  await cdp.eval(`Promise.race([
    Promise.allSettled(document.getAnimations()
      .filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map(animation => animation.finished)),
    new Promise(resolve => setTimeout(resolve, 500))
  ])`)
  const image = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  writeFileSync(join(out, name + '.png'), Buffer.from(image.data, 'base64'))
}

async function typeLines(cdp: Cdp, lines: string[], append = false): Promise<void> {
  await click(cdp, `document.querySelector(${JSON.stringify(editor)})`)
  if (append) {
    await cdp.eval(`(() => {
      const selection = window.getSelection()
      selection.selectAllChildren(document.activeElement)
      selection.collapseToEnd()
    })()`)
  }
  for (const [index, line] of lines.entries()) {
    if (append || index > 0) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13
      })
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13
      })
    }
    await cdp.send('Input.insertText', { text: line })
  }
}

function wordText(path: string): string {
  if (!existsSync(path)) return ''
  const read = Bun.spawnSync(['unzip', '-p', path, 'word/document.xml'])
  return read.exitCode === 0 ? read.stdout.toString() : ''
}

function pdfHash(path: string): string | null {
  if (!existsSync(path)) return null
  const pdf = readFileSync(path)
  if (pdf.subarray(0, 5).toString() !== '%PDF-')
    throw new Error('Saved PDF does not start with %PDF-')
  return createHash('sha256').update(pdf).digest('hex')
}

try {
  const host = await launch('host', true)
  const client = await launch('client', false)
  const cdp = await attach(client.debug, 60_000)
  page = cdp
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  const theme = (light: boolean) =>
    cdp.eval(`(() => {
    document.documentElement.classList.toggle('theme-light', ${light})
    window.dispatchEvent(new CustomEvent('monocode:schemechange', { detail: ${JSON.stringify(light ? 'light' : 'dark')} }))
  })()`)
  await theme(false)
  const clientPort = await waitFor('client socket', () =>
    cdp.eval<number>('window.api.getServerPort()')
  )
  const hostPort = await waitFor('host socket', () => {
    const path = join(host.data, 'server.json')
    return existsSync(path) && (JSON.parse(readFileSync(path, 'utf8')) as { port: number }).port
  })
  await local(hostPort, 'work.set', { enabled: true })
  await local(clientPort, 'work.set', { enabled: true })
  const { environmentId } = await local<{ environmentId: string }>(hostPort, 'remote.status')
  const workspace = await local<{ id: string }>(hostPort, 'workspace.create', {
    kind: 'work',
    sector: 'purdue',
    name: workspaceName
  })
  const { token } = await local<{ token: string }>(hostPort, 'remote.keys.create', {
    name: workspaceName,
    audience: 'client',
    caps: ['read', 'operate', 'approve']
  })
  await local(clientPort, 'remote.environments.add', {
    url: `http://127.0.0.1:${host.remote}`,
    key: token,
    name: 'Proof host'
  })
  await cdp.eval('window.__monocode.loadSavedEnvironments()')
  const link = `window.__monocode.registry.linkOf(${JSON.stringify(environmentId)})`
  await waitFor('paired window with the minted key', () =>
    cdp.eval<boolean>(`(() => {
    if (!window.__monocode.registry.has(${JSON.stringify(environmentId)})) return false
    const hello = ${link}.transport?.hello
    return !!hello?.key && hello.caps.slice().sort().join(',') === 'approve,operate,read'
  })()`)
  )
  const remote = <T>(method: string, params: object) =>
    cdp.eval<T>(`${link}.request(${JSON.stringify(method)}, ${JSON.stringify(params)})`)
  await cdp.eval(`(() => {
    const target = ${link}
    const request = target.request.bind(target)
    window.saveAsProofErrors = []
    target.request = async (method, params, opts) => {
      try {
        return await request(method, params, opts)
      } catch (error) {
        if (['work.files.saveAs', 'work.files.list', 'work.files.links', 'work.files.preview'].includes(method)) {
          window.saveAsProofErrors.push(method + ': ' + error.message)
        }
        throw error
      }
    }
  })()`)

  step = 'find the dummy Teams library'
  const places = await remote<FilesPlaces>('work.files.places', { workspaceId: workspace.id })
  const channel = places.places.find(
    (place) =>
      place.kind === 'teams' &&
      place.group === libraryName &&
      place.name === channelName &&
      place.env === environmentId &&
      !place.vm
  )
  if (
    !channel ||
    !channel.shared ||
    channel.root.at !== 'file' ||
    channel.root.path !== resolve(host.folder, '..')
  ) {
    throw new Error(
      'The headless host did not recognize Esports / General as its own shared Teams place'
    )
  }
  console.log('PASS 1: the headless host lists Esports / General as a shared Teams place')

  step = 'create and edit the document'
  const made = await remote<FileDone>('work.files.make', {
    workspaceId: workspace.id,
    at: { at: 'place', id: 'folder' },
    kind: 'document',
    name: title,
    op: randomUUID()
  })
  const source = made.entries[0]?.ref
  if (!source || source.at !== 'file' || !source.path.endsWith('.tcdoc'))
    throw new Error('The host did not make a document')
  const opened = await remote<FilesOpened>('work.files.open', {
    workspaceId: workspace.id,
    ref: source
  })
  if (!opened.item || !opened.tabId) throw new Error('The host did not open the document')
  inspect = () => remote('work.files.links', { workspaceId: workspace.id, source })
  await click(
    cdp,
    `[...document.querySelectorAll('button, [role="button"]')].find(el => el.textContent.trim() === ${JSON.stringify(workspaceName)})`
  )
  await click(
    cdp,
    `[...document.querySelectorAll('button, [role="tab"]')].find(el => el.textContent.trim() === 'Files')`
  )
  await click(
    cdp,
    `[...document.querySelectorAll('button, [role="tab"]')].find(el => el.textContent.trim() === ${JSON.stringify(opened.item.title)})`
  )
  const lines = [
    'Open the arena at noon.',
    'Check the broadcast audio.',
    'Meet the teams at the main desk.'
  ]
  await typeLines(cdp, lines)
  await waitFor('the live text on the host', async () => {
    const file = await remote<ExportAnswer>('work.formats.export', { source, format: 'md' })
    const text = atob(file.data)
    return lines.every((line) => text.includes(line))
  })

  const showSheet = async () => {
    await click(cdp, 'document.querySelector("[data-doc-save-as]")')
    await waitFor('Save As sheet', () => cdp.eval(`!!document.querySelector('${sheet}')`))
  }
  const pickFormat = async (format: 'docx' | 'pdf', label: string) => {
    if (await cdp.eval<boolean>(`!!document.querySelector('[data-save-as-format="${format}"]')`))
      return
    await click(cdp, 'document.querySelector("[data-save-as-format]")')
    await click(
      cdp,
      `[...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')].find(el => el.textContent.trim().startsWith(${JSON.stringify(label)}))`
    )
    await waitFor(label + ' format', () =>
      cdp.eval(`!!document.querySelector('[data-save-as-format="${format}"]')`)
    )
  }
  const folderSelected = () =>
    waitFor('Runbooks folder selected and ready', () =>
      cdp.eval<boolean>(`(() => {
    const sheet = document.querySelector('${sheet}')
    return !!sheet?.innerText.includes('in ${folderName}, kept up to date') &&
      !sheet.querySelector('[role="listbox"] [aria-busy]') && !sheet.innerText.includes('This folder did not load.')
  })()`)
    )
  const firstPageReady = () =>
    waitFor(
      'the sheet’s first page',
      () =>
        cdp.eval<boolean>(`(() => {
    const image = document.querySelector('${sheet} img')
    return !!image?.complete && image.naturalWidth > 0
  })()`),
      15_000
    )
  const save = () => click(cdp, `document.querySelector('${sheet} [data-dialog-confirm]')`)
  const closed = () =>
    waitFor(
      'Save As sheet to close',
      async () => {
        const refused = await cdp.eval<string | undefined>(
          'window.saveAsProofErrors.find(error => error.startsWith("work.files.saveAs:"))'
        )
        if (refused) throw new Error(refused)
        return cdp.eval<boolean>(`!document.querySelector('${sheet}')`)
      },
      15_000
    )

  step = 'save Word to the Teams folder'
  await showSheet()
  await pickFormat('docx', 'Word')
  await click(cdp, option(`${libraryName}, ${channelName}`))
  await waitFor('Runbooks in the Teams channel', () => cdp.eval(`!!(${option(folderName)})`))
  await firstPageReady()
  await shot(cdp, 'sheet-teams-folder')
  await click(cdp, option(folderName))
  await folderSelected()
  await shot(cdp, 'sheet-dark')
  await save()
  await closed()
  const word = join(host.folder, title + '.docx')
  const first = wordText(word)
  if (!lines.every((line) => first.includes(line)))
    throw new Error(`${title}.docx did not contain the typed lines on the host`)
  console.log(
    'PASS 2: Save wrote the Word file and all three lines to Esports / General / Runbooks'
  )

  step = 'capture the saved header'
  await waitFor('Saved to Runbooks in the header', () =>
    cdp.eval<boolean>(
      `document.querySelector('[data-doc-link="saved"]')?.textContent.includes('Saved to ${folderName}')`
    )
  )
  await shot(cdp, 'saved-header')
  console.log('PASS 3: the header says Saved to Runbooks')

  step = 'wait for the linked Word file to update'
  await typeLines(cdp, ['Scoreboard checked.'], true)
  await sleep(6_000)
  await waitFor(
    'Scoreboard in the linked Word file',
    () => wordText(word).includes('Scoreboard'),
    5_000
  )
  console.log('PASS 4: the existing Word file contains Scoreboard after the edit')

  step = 'keep both files on a name clash'
  await showSheet()
  await folderSelected()
  await firstPageReady()
  await save()
  const clash = await waitFor(
    'the Replace confirmation',
    () => cdp.eval<string | undefined>('document.querySelector("[role=alertdialog]")?.innerText'),
    15_000
  )
  if (!clash.includes(`Replace ${title}.docx in ${folderName}?`))
    throw new Error(`Unexpected Replace confirmation: ${clash}`)
  await shot(cdp, 'clash')
  const beforeKeep = readFileSync(word)
  await click(cdp, button('Keep Both', 'document.querySelector("[role=alertdialog]")'))
  await closed()
  const second = join(host.folder, title + ' 2.docx')
  if (!wordText(second).includes('Scoreboard') || !readFileSync(word).equals(beforeKeep)) {
    throw new Error('Keep Both did not save the numbered file while preserving the original')
  }
  console.log('PASS 5: Keep Both wrote Match day plan 2.docx and preserved the first file')

  step = 'save PDF and wait for its linked update'
  await showSheet()
  await pickFormat('pdf', 'PDF')
  await folderSelected()
  await save()
  await closed()
  const pdf = join(host.folder, title + '.pdf')
  const beforePdf = pdfHash(pdf)
  if (!beforePdf) throw new Error('Save did not create the PDF on the host')
  await typeLines(cdp, ['Overtime begins after the break.'], true)
  await sleep(6_000)
  await waitFor(
    'linked PDF bytes to change',
    () => {
      const after = pdfHash(pdf)
      return after && after !== beforePdf
    },
    5_000
  )
  console.log('PASS 6: Save wrote a PDF and the linked PDF bytes changed after another edit')

  step = 'capture the light Save As sheet'
  await theme(true)
  await showSheet()
  await pickFormat('docx', 'Word')
  await folderSelected()
  await firstPageReady()
  await shot(cdp, 'sheet-light')
  console.log('PASS 7: captured the Word sheet with Runbooks selected in the light theme')
  passed = true
} catch (error) {
  console.error(`Failed to ${step}. Instance logs: ${root}`)
  if (page) {
    console.error(
      await page.eval<string>('JSON.stringify(window.saveAsProofErrors ?? [])').catch(() => '')
    )
    console.error(await page.eval<string>('document.body.innerText.slice(-2500)').catch(() => ''))
  }
  if (inspect) console.error('Links:', await inspect().catch(() => null))
  throw error
} finally {
  await stop()
  if (passed) rmSync(root, { recursive: true, force: true })
}
