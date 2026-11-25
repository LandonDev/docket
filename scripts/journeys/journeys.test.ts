import { once } from 'node:events'
import { createConnection, createServer } from 'node:net'
import { createHash, createHmac, generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { finishWorkbookClose } from './J02-workbook-close'
import { waitForWordRevision } from './J04-library-word'
import { scrubFrame, soundAppOpened } from './J09-library-media'
import { guestAddress } from './J20-guest-link'
import { queuedAge } from './J32-held-mail'
import { earlySent } from './J33-mail-undo'
import { keptSchedule, scheduledWords } from './J34-mail-scheduled'
import { queuedChatWords } from './J39-messages'
import { toldOnce } from './J50-digest'
import { todayOpen } from './J51-today-review'
import { taskMatches } from './J40-task-today'
import { honestAdding } from './J41-agenda-clash'
import { ledgerHasReceipt } from './J45-receipt'
import { routineThreadMatches } from './J47-routine'
import { broken, expected, wearsDark, wearsLight } from './J59-light-windows'
import { changed, notOffered } from './lib/far'
import { headedResult } from './J60-browser-canvas'
import { ownedDisplay } from './lib/capture'
import { connectionMatches, withheldWords } from './J55-connections'
import { assertSandboxKeys } from './lib/lifeos'
import { FIRST_MAIL, SECOND_MAIL, seedDay, seedDeadline, seedLifeos } from './lib/lifeosSeed'
import { see } from './lib/lifeosJourney'
import { composeRow } from './lib/mailJourney'
import { wordBodyLayout } from './J05-document-export'
import { desktopDrop, rowDrop } from './lib/drop'
import { documentHas } from './lib/edit'
import { BROWSER_PROMPT, fakeMessage, mailReplyTool, seedFakeAccount, startFakeProvider } from './lib/fakeProvider'
import { pdfFacts } from './lib/preview'
import { letterPaper, printViewer } from './lib/print'
import { AppOpenProof } from './lib/appOpen'
import { closeSelectedFile, dummyLibrary, dummyPdf, fixtures, gioStub, holds, rowAt } from './lib/files'
import { holderFolder, selectFolderTab } from './lib/place'
import { explainsMissingContent, searchVerdict } from './lib/search'
import { cellValue, falseSaveLine } from './lib/sheet'
import { relay } from './lib/relay'
import { wordFixture } from './lib/wordAddin'
import * as threadProof from './lib/thread'
import { toolCall } from './lib/thread'
import { mainCheckout, step, walk, type Context } from './lib/record'
import { isolatedEnvironment, SHAPES, type Pair } from './lib/shape'
import { until, Window } from './lib/window'
import { appendCleanup, boxChromium, JOURNEYS, options, requireBuild, walkSetup } from './run'
import { updateJourneysTable } from './table'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '../..')

it('registers every journey once with its file id, a shape and an end check', async () => {
  const files = readdirSync(HERE).filter((file) => /^J\d{2}-.+\.ts$/.test(file))
  expect(files.length).toBeGreaterThan(0)
  const modules = await Promise.all(files.map((file) => import('./' + file) as Promise<{ default: typeof JOURNEYS[number] }>))
  expect(JOURNEYS.map((j) => j.id)).toEqual(files.map((file) => file.slice(0, 3)))
  for (const { default: journey } of modules) {
    expect(JOURNEYS.filter((j) => j === journey)).toHaveLength(1)
    expect(journey.shapes.length).toBeGreaterThan(0)
    expect(journey.shapes.every((shape) => SHAPES.includes(shape))).toBe(true)
    for (const shape of journey.shapes) {
      expect(journey.steps.filter((step) => !step.shapes || step.shapes.includes(shape)).at(-1)?.name).toMatch(/^end:/)
    }
  }
})

it('never spreads the launch shell environment before filtering it', () => {
  const source = readFileSync(join(HERE, 'lib/shape.ts'), 'utf8')
  expect(source).not.toMatch(/\.\.\.\s*(?:\(\s*)?process\.env/)
  expect(source.match(/process\.env\b/g)).toHaveLength(1)
  expect(source).toMatch(/const inherited = isolatedEnvironment\(process\.env\)[\s\S]+\.\.\.inherited/)
  expect(isolatedEnvironment({
    PATH: '/bin', LANG: 'C', LC_ALL: 'C',
    TEMP_CODE_USER_DATA: '/real', CLAUDE_CONFIG_DIR: '/real', ANTHROPIC_API_KEY: 'real',
    OPENAI_API_KEY: 'real', CODEX_HOME: '/real', ELECTRON_RUN_AS_NODE: '1', GITHUB_TOKEN: 'real'
  })).toEqual({ PATH: '/bin', LANG: 'C', LC_ALL: 'C' })
})

it('filters by id, shape and tier and only adds desk when asked or needed', () => {
  const picks = options(['--only', 'J05,J10', '--shape', 'A,B1', '--tier', '1'])
  expect(picks.jobs.map(({ spec, shape }) => [spec.id, shape])).toEqual([['J05', 'A'], ['J10', 'A'], ['J10', 'B1']])
  expect(walkSetup(picks.jobs[0]!, picks.desk).desk).toBe(false)
  expect(options(['--only', 'J10', '--shape', 'B1', '--list', '--keep', '--desk'])).toMatchObject({ list: true, keep: true, desk: true })
  expect(() => options(['--only', 'J05', '--shape', 'B1'])).toThrow('No journeys match')
  expect(() => options(['--shape', 'wrong'])).toThrow('Unknown shape')
  expect(() => options(['--only', 'J00'])).toThrow('Unknown journey')
  expect(() => options(['--tier', '0'])).toThrow('positive integer')
})

it('plans a sandbox and launch options for each walk without borrowing settings from neighboring walks', () => {
  const selected = options(['--only', 'J02,J20,J22,J55,J60', '--no-table'])
  const plan = Object.fromEntries(selected.jobs.map(job => [job.spec.id + ' ' + job.shape, walkSetup(job, selected.desk)]))
  expect(selected.noTable).toBe(true)
  expect(plan['J02 B1']).toMatchObject({ sandbox: false, desk: false, launch: { guests: false, browser: false } })
  expect(plan['J02 B2']).toMatchObject({ sandbox: false, desk: true })
  expect(plan['J20 S']).toMatchObject({ sandbox: true, seededMail: true, launch: { guests: true, hosted: false } })
  expect(plan['J22 A']).toMatchObject({ sandbox: false, launch: { hosted: true, guests: false } })
  expect(plan['J55 K']).toMatchObject({ sandbox: true, seededMail: false })
  expect(plan['J60 A']).toMatchObject({ sandbox: false, launch: { fake: true, browser: true } })
  for (const job of options(['--only', 'J35,J50', '--shape', 'A']).jobs) expect(walkSetup(job).sandbox).toBe(true)
})

it('keeps cleanup proof from each walk and checks a reused port once in the run summary', () => {
  const first = { revoked: ['first'], remainingPids: [], portsChecked: [1200, 1300], remainingPorts: [], errors: [] }
  appendCleanup(first, { revoked: ['second'], remainingPids: [99], portsChecked: [1190, 1200], remainingPorts: [1190], errors: ['listener still up'] })
  expect(first).toEqual({ revoked: ['first', 'second'], remainingPids: [99], portsChecked: [1190, 1200, 1300], remainingPorts: [1190], errors: ['listener still up'] })
})

it('reads tracked source and points deployment, applications, and tool traffic at the sandbox', () => {
  const source = readFileSync(join(HERE, 'lib/lifeos.ts'), 'utf8')
  const launcher = readFileSync(join(HERE, 'lib/shape.ts'), 'utf8')
  const tools = readFileSync(join(HERE, 'lib/lifeosMcp.ts'), 'utf8')
  for (const code of [source, launcher, tools]) {
    expect(code).not.toMatch(/lifeos(?:-mcp)?\.landonhale\.com|lifeos-deploy|\bsudo\b/)
  }
  expect(source).toMatch(/dirname\(dirname\(walk\)\) !== runs/)
  expect(source).toMatch(/git\(repo, \['archive', '--output', tar, rev, '--', \.\.\.files\]\)/)
  expect(source).toMatch(/await list\(\)[\s\S]+assertSandboxKeys\(names,[\s\S]+await mintDevice\(\)[\s\S]+await seedLifeos\(/)
  expect(source).toMatch(/CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey/)
  expect(source).toMatch(/'--interface', '127\.0\.0\.1'/)
  expect(source).toMatch(/'--convex-http-proxy', OFFLINE/)
  expect(source).toMatch(/ports\.some[\s\S]+A sandbox listener remains/)
  expect(tools).toMatch(/target\.origin !== url[\s\S]+redirect: 'error'/)
  expect(launcher).toMatch(/TEMP_CODE_LIFEOS_URL: options\.sandbox\?\.url \?\? OFFLINE/)
  expect(launcher).toMatch(/TEMP_CODE_LIFEOS_MCP_URL: options\.sandbox\?\.mcpUrl \?\? OFFLINE/)
  expect(launcher).toMatch(/this\.rpc\(this\.box, 'work\.lifeos\.setToken', \{ token: this\.sandbox\.deviceToken/)
  expect(launcher).toMatch(/TEMP_CODE_WARM_HARNESS: '0'/)
  expect(launcher).toMatch(/\(!this\.sandbox \|\| options\.localTools\) && existsSync/)
  expect(launcher).toMatch(/for \(const dir of \[.*join\(data, 'no-vm'\)/)
})

it('uses the sandbox for both guest walks and keeps its configured guest origin', () => {
  expect(options(['--only', 'J20']).jobs.map(({ shape }) => shape)).toEqual(['S', 'U'])
  expect(walkSetup(options(['--only', 'J20', '--shape', 'U']).jobs[0]!).sandbox).toBe(true)
  const outside = new URL('http://192.0.2.8:4000/g/link123#k=fake')
  const loopback = new URL('http://127.0.0.1:4000/g/link123#k=fake')
  expect(guestAddress(outside, outside.origin, 'link123')).toBe(true)
  expect(guestAddress(loopback, loopback.origin, 'link123')).toBe(true)
  expect(guestAddress(loopback, outside.origin, 'link123')).toBe(false)
  expect(guestAddress(outside, outside.origin, 'another')).toBe(false)
})

it('accepts only the fresh matching JWT pair and omits its values from the audit line', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const { crv, kty, x, y } = publicKey.export({ format: 'jwk' })
  const kid = createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest('base64url')
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const jwks = 'data:text/plain;charset=utf-8;base64,' + Buffer
    .from(JSON.stringify({ keys: [{ crv, kty, x, y, kid, alg: 'ES256', use: 'sig' }] })).toString('base64')
  const names = ['JWT_PRIVATE_KEY', 'JWKS']
  expect(assertSandboxKeys(names, pem, jwks, kid)).toBe('Sandbox environment verified before seed: JWKS, JWT_PRIVATE_KEY (fresh pair; values omitted)')
  expect(() => assertSandboxKeys(['GOOGLE_CLIENT_SECRET', ...names], pem, jwks, kid)).toThrow('Unexpected sandbox environment keys')
  expect(() => assertSandboxKeys(['JWKS'], pem, jwks, kid)).toThrow('Unexpected sandbox environment keys')
  expect(() => assertSandboxKeys(names, pem, jwks, 'stale')).toThrow('fresh JWT pair')
  expect(() => assertSandboxKeys(names, 'bad PEM', jwks, kid)).toThrow('fresh JWT pair')
})

it('seeds twenty invented mail threads and a chat with stored bytes through LifeOS functions', async () => {
  const internal = vi.fn(async (fn: string) => fn === 'chats:fileStored' ? true : 'seed-id')
  const mutate = vi.fn(async () => 'seed-id')
  const query = vi.fn(async (fn: string) => fn === 'chats:list'
    ? { page: [{ _id: 'chat-id', name: 'Spring LAN' }] }
    : { page: [{ _id: 'message-id', files: [{ _id: 'chat-file-id', name: 'Spring LAN notes.txt' }] }] })
  const upload = vi.fn(async () => 'seed-storage')
  const now = new Date('2026-03-08T02:00:00Z')
  await seedLifeos({ internal, mutate, query, upload } as unknown as Parameters<typeof seedLifeos>[0], now)
  const rows = internal.mock.calls as unknown as [string, Record<string, unknown>][]
  const threadBatches = rows.filter(([fn]) => fn === 'mail:upsertThreads')
    .flatMap(([, args]) => args.threads as { subject: string; labels: string[]; lastMessageAt: number }[])
  expect(threadBatches).toHaveLength(20)
  expect(threadBatches.map(({ subject }) => subject)).toEqual(expect.arrayContaining([FIRST_MAIL, SECOND_MAIL]))
  expect(threadBatches.find(({ labels }) => labels.includes('SENT'))?.lastMessageAt).toBeLessThan(now.getTime() - 7 * 86_400_000)
  const addresses = JSON.stringify(rows).match(/@[\w.]+/g)
  expect(addresses?.length).toBeGreaterThan(0)
  expect(addresses?.every((address) => /^@example\.(com|org)$/.test(address))).toBe(true)
  expect(rows.filter(([fn]) => fn === 'mail:upsertAccount')).toHaveLength(2)
  expect(rows).toContainEqual(['chats:fileStored', { id: 'chat-file-id', storageId: 'seed-storage', contentType: 'text/plain', size: 31 }])
  expect(mutate).toHaveBeenCalledWith('chats:requestFiles', { messageId: 'message-id' })
  expect(mutate).toHaveBeenCalledWith('tasks:complete', { id: 'seed-id' })
  expect(mutate).toHaveBeenCalledWith('tasks:setWaitingOn', expect.objectContaining({ id: 'seed-id' }))
  expect(upload).toHaveBeenCalledTimes(2)
  expect(new Date(seedDay(now, 0, 9)).toISOString()).toBe('2026-03-07T14:00:00.000Z')
  expect(new Date(seedDay(now, 1, 9)).toISOString()).toBe('2026-03-08T13:00:00.000Z')
})

it('checks the same Purdue task and due time through completion and Undo', () => {
  const row = { _id: 'task', title: 'Check the doors', sector: 'purdue', status: 'todo', dueAt: 10 }
  expect(taskMatches(row, 'todo', 10)).toBe(true)
  expect(taskMatches({ ...row, status: 'done' }, 'done', 10, 'task')).toBe(true)
  expect(taskMatches(row, 'todo', 10, 'task')).toBe(true)
  expect(taskMatches({ ...row, _id: 'replacement' }, 'todo', 10, 'task')).toBe(false)
  expect(taskMatches(row, 'todo', 11, 'task')).toBe(false)
})

it('reads the backend’s compose row and detects false journey wording', async () => {
  const row = { _id: 'x', status: 'queued', message: { text: 'Practice reply' } }
  const query = vi.fn(async () => ({ row, quote: '', urls: {} }))
  const context = { pair: { sandbox: { query } } } as unknown as Context
  expect(await composeRow(context, row._id)).toBe(row)
  expect(query).toHaveBeenCalledWith('compose:get', { id: 'x' })
  expect(earlySent('Sent', 'queued')).toBe(true)
  expect(earlySent('Sending to Dana Lee', 'queued')).toBe(false)
  expect(queuedAge('Queued in LifeOS for <1m')).toBe(true)
  expect(queuedAge('Queued in LifeOS')).toBe(false)
  expect(scheduledWords('Scheduled for 9:00 AM Eastern · 8:00 AM CentralUndo')).toBe(true)
  expect(scheduledWords('Scheduled for 8:00 AM Central\nSending')).toBe(false)
  const eightCentral = Date.parse('2026-11-24T14:00:00Z')
  expect(scheduledWords('Scheduled for 9:00 AM Eastern · 8:00 AM Central', eightCentral)).toBe(true)
  expect(scheduledWords('Scheduled for 9:00 AM Eastern · 7:00 AM Central', eightCentral)).toBe(false)
  expect(honestAdding(['Adding Sort the spare adapters'], 'queued')).toBe(true)
  expect(honestAdding(['Added Sort the spare adapters'], 'queued')).toBe(false)
  expect(withheldWords('This computer cannot read LifeOS through the box')).toBe(true)
  expect(withheldWords('This computer cannot read LifeOS through the box\nLifeOS did not answer')).toBe(false)
})

it('keeps an owner’s cancelled reply as the same draft with its original time and zone', () => {
  const queued = { _id: 'reply', status: 'queued', scheduled: true, sendAt: 900, sendZone: 'America/Chicago', message: { subject: 'Room', text: 'Noon' } }
  const draft = { _id: 'reply', status: 'draft', suggestedSend: { at: 900, zone: 'America/Chicago' }, message: queued.message }
  expect(keptSchedule(queued, draft)).toBe(true)
  expect(keptSchedule(queued, { ...draft, _id: 'new' })).toBe(false)
  expect(keptSchedule(queued, { ...draft, suggestedSend: { at: 901, zone: 'America/Chicago' } })).toBe(false)
  expect(keptSchedule(queued, { ...draft, sendAt: 900 })).toBe(false)
})

it('checks the Messages reply wording and the identity of a Today row', () => {
  expect(queuedChatWords('Sending')).toBe(true)
  expect(queuedChatWords('Queued in LifeOS')).toBe(true)
  expect(queuedChatWords('Sent')).toBe(false)
  expect(queuedChatWords('Sending but already sent')).toBe(false)
  expect(todayOpen('event:local')).toBe('[data-today-row="event:local"] [data-row-open]')
})

it('seeds a calendar deadline and counts a single emitted telling', async () => {
  const write = vi.fn(async () => 'calendar-source')
  const retire = await seedDeadline(write as unknown as Parameters<typeof seedDeadline>[0], 'Practice reminder', 100_000)
  expect(write).toHaveBeenCalledWith('events:syncFeed', expect.objectContaining({
    sourceId: 'calendar-source',
    events: [expect.objectContaining({ title: 'Practice reminder', startsAt: 100_000 })],
    provider: [expect.objectContaining({ attendees: [expect.objectContaining({ address: 'dana@example.com' })] })]
  }))
  await retire()
  expect(write).toHaveBeenLastCalledWith('events:syncFeed', expect.objectContaining({ sourceId: 'calendar-source', events: [], provider: [] }))
  const row = { kind: 'prep.starting', title: 'Practice reminder', toldAt: 90_000 } as Parameters<typeof toldOnce>[0][number]
  const match = (item: typeof row) => item.title === row.title
  expect(toldOnce([row], 'prep.starting', match)).toBe(true)
  expect(toldOnce([row, row], 'prep.starting', match)).toBe(false)
  expect(toldOnce([{ ...row, toldAt: null }], 'prep.starting', match)).toBe(false)
})

it('refuses a missing or stale build and checks the worktree sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'journeys-build-'))
  try {
    expect(() => requireBuild(root)).toThrow('heavy bunx electron-vite build')
    const files = ['src/nested/code.ts', 'out/main/boot.js', 'out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']
    for (const file of files) {
      const path = join(root, file)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '')
      utimesSync(path, 100, file.startsWith('src/') ? 100 : 200)
    }
    expect(() => requireBuild(root)).not.toThrow()
    utimesSync(join(root, files[0]!), 100, 300)
    expect(() => requireBuild(root)).toThrow('older than src/')
    expect(existsSync(join(mainCheckout(REPO), '.git'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps each Fix and rows outside the run when it updates the table', () => {
  const before = [
    '# Record', '', '## Journeys', '', '| Journey | Shape | Result | Fix |', '| --- | --- | --- | --- |',
    '| J10 | B1 | PASS | link \\| note |', '| J11 | A | PASS | old |', '', '## Walls', '| untouched |'
  ].join('\n')
  const after = updateJourneysTable(before, { journeys: [
    { id: 'J10', shape: 'B1', title: '', steps: [{ name: 'end: open | send', error: 'No row' }] },
    { id: 'J05', shape: 'A', title: '', steps: [{ name: 'end: export' }] }
  ] })
  expect(after).toContain('| J05 | A | PASS |  |\n| J10 | B1 | FAIL · end: open &#124; send | link \\| note |')
  expect(after).toContain('| J11 | A | PASS | old |\n\n## Walls\n| untouched |')
  expect(updateJourneysTable(before, { journeys: [{ id: 'J40', shape: 'S', title: '', steps: [], notRun: 'no sandbox' }] }))
    .toContain('| J40 | S | not run: no sandbox |')
})

it('records a failed step with evidence and skips the rest of that walk', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'journeys-walk-'))
  try {
    const hostErrors: string[] = ['old']
    const pair = {
      abort: new AbortController(),
      hostErrors,
      page: { shot: vi.fn(async (file: string) => writeFileSync(file, 'picture')), toasts: async () => ['Toast'], saveLine: async () => 'Saved' }
    } as unknown as Pair
    const next = vi.fn()
    const wrongShape = vi.fn()
    const result = await walk({
      id: 'J00', title: 'test', tier: 1, shapes: ['A'], steps: [
        step('Another shape', wrongShape, ['S']),
        step('Try it', () => { hostErrors.push('Host refused'); throw new Error('No row') }),
        step('end: next step', next)
      ]
    }, { pair, shape: 'A', folder, workspace: { id: 'a', name: 'a', path: folder } }, new Promise<never>(() => undefined))
    expect(result.steps).toEqual([{
      name: 'Try it', error: 'No row', picture: 'J00-A/01-try-it.png',
      toasts: ['Toast'], saveLine: 'Saved', hostErrors: ['Host refused']
    }])
    expect(readFileSync(join(folder, '01-try-it.png'), 'utf8')).toBe('picture')
    expect(next).not.toHaveBeenCalled()
    expect(wrongShape).not.toHaveBeenCalled()
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

it('seeds dummy bytes and bins only files in the run folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'journeys-fixtures-'))
  const outside = mkdtempSync(join(tmpdir(), 'journeys-outside-'))
  try {
    const l1 = dummyLibrary(join(root, 'home'), 'Test')
    expect(l1).toContain('OneDrive-SharedLibraries-Dummy U/Test - Documents/General')
    const { pdf, deck, sheet } = fixtures(REPO, l1, 'Practice')
    expect(existsSync(deck) && existsSync(sheet)).toBe(true)
    expect(readFileSync(pdf, 'utf8')).toContain('/Count 3')
    const bytes = dummyPdf()
    expect(bytes.slice(Number(bytes.match(/startxref\n(\d+)/)?.[1]), -1)).toMatch(/^xref/)
    const text = join(l1, 'Note.txt')
    writeFileSync(text, '<w:t>Help</w:t><w:t>ful</w:t>')
    expect(holds(text, 'Helpful')).toBe(true)
    const gio = join(gioStub(root), 'gio')
    execFileSync(gio, ['trash', '--', text])
    expect(existsSync(text)).toBe(false)
    const trash = readdirSync(root).find((file) => file.startsWith('trash.'))!
    expect(existsSync(join(root, trash, 'Note.txt'))).toBe(true)
    const unsafe = join(outside, 'outside.txt')
    writeFileSync(unsafe, 'outside')
    expect(() => execFileSync(gio, ['trash', unsafe])).toThrow()
    expect(existsSync(unsafe)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

it('bounds a poll and stops it when the run aborts', async () => {
  await expect(until('the stopper', 1, () => false)).rejects.toThrow('Timed out waiting for the stopper')
  const check = vi.fn()
  await expect(until('the window', 100, check, AbortSignal.abort(new Error('Child exited')))).rejects.toThrow('Child exited')
  expect(check).not.toHaveBeenCalled()
})

it('attaches to the app page, retries a dead handshake and rejects a closed socket', async () => {
  const sockets: DebugSocket[] = []
  class DebugSocket {
    static OPEN = 1
    readyState = 0
    onopen?: () => void
    onclose?: () => void
    onerror?: () => void
    onmessage?: (event: { data: string }) => void

    constructor(readonly url: string) {
      sockets.push(this)
      queueMicrotask(() => {
        if (sockets.length === 1) return this.onerror?.()
        this.readyState = DebugSocket.OPEN
        this.onopen?.()
      })
    }

    send(text: string): void {
      const { id, method } = JSON.parse(text) as { id: number; method: string }
      if (method === 'Runtime.evaluate') this.onmessage?.({ data: JSON.stringify({ id, result: { result: { value: 'ready' } } }) })
    }

    close(): void {
      this.readyState = 3
      this.onclose?.()
    }
  }
  const fetch = vi.fn(async () => Response.json([
    { type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://unused' },
    { type: 'page', url: 'file:///out/index.html', webSocketDebuggerUrl: 'ws://app' },
    { type: 'page', url: 'http://127.0.0.1:3000/w/full/practice/', webSocketDebuggerUrl: 'ws://full' }
  ]))
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('WebSocket', DebugSocket)
  try {
    const { attach } = await import('../e2e-work-lib')
    const cdp = await attach(12345, 1500)
    expect(sockets.map((socket) => socket.url)).toEqual(['ws://app', 'ws://app'])
    expect(sockets[0]?.readyState).toBe(3)
    await expect(cdp.eval('window.api')).resolves.toBe('ready')
    const pending = cdp.send('Page.captureScreenshot')
    cdp.close()
    await expect(pending).rejects.toThrow('debug socket closed')
    const extra = await attach(12345, 1500, undefined, (url) => url.includes('/w/full/'))
    expect(sockets.at(-1)?.url).toBe('ws://full')
    extra.close()
  } finally {
    vi.unstubAllGlobals()
  }
})

it('requires a body font and space between paragraphs in the Word styles', () => {
  const old = '<w:docDefaults><w:rPrDefault/><w:pPrDefault/></w:docDefaults><w:style w:styleId="Heading1"><w:rFonts w:ascii="Calibri"/><w:spacing w:after="160"/></w:style>'
  const fixed = '<w:docDefaults><w:rFonts w:ascii="Calibri"/><w:spacing w:after="176"/></w:docDefaults>'
  expect(wordBodyLayout(old)).toEqual({ font: false, spacing: false })
  expect(wordBodyLayout(fixed)).toEqual({ font: true, spacing: true })
  expect(wordBodyLayout(fixed.replace('w:after="176"', 'w:line="384"'))).toEqual({ font: true, spacing: false })
})


it('routes the three shapes to separate holder folders', () => {
  const base = { pair: { l1: '/run/win/General', l2: '/run/desk/General' }, workspace: { path: '/run/box/work', name: 'Practice' } }
  expect(holderFolder({ ...base, shape: 'A' } as Context)).toBe('/run/box/work')
  expect(holderFolder({ ...base, shape: 'B1' } as Context)).toBe('/run/win/General/Practice')
  expect(holderFolder({ ...base, shape: 'B2' } as Context)).toBe('/run/desk/General/Practice')
  expect(() => holderFolder({ ...base, pair: { l1: base.pair.l1 }, shape: 'B2' } as Context)).toThrow('No library for B2')
})

it('reads a named sheet cell in shared, inline and numeric form', () => {
  const cells = '<c t="s" r="A1"><v>1</v></c><c r="B1" t="inlineStr"><is><t>Second</t></is></c><c r="A2"><v>42</v></c><c r="A3"/>'
  const strings = '<si><t>Other</t></si><si><r><t xml:space="preserve">Blue </t></r><r><t>team</t></r></si>'
  expect(cellValue(cells, strings, 'A1')).toBe('Blue team')
  expect(cellValue(cells, strings, 'B1')).toBe('Second')
  expect(cellValue(cells, strings, 'A2')).toBe('42')
  expect(cellValue(cells, strings, 'A3')).toBeUndefined()
  expect(cellValue(cells, strings, 'A10')).toBeUndefined()
})

it('only accepts a saved claim after Enter when the holder has the cell', () => {
  expect(falseSaveLine('On This Mac', false, false)).toBe(false)
  expect(falseSaveLine('Saving to This Mac…', true, false)).toBe(false)
  expect(falseSaveLine('Saved to This Mac. OneDrive uploads it', true, false)).toBe(true)
  expect(falseSaveLine('Saved to This Mac 4:24 AM', true, true)).toBe(false)
  // The line read before the edit, kept through its pause, names that earlier save: not a claim about this edit.
  expect(falseSaveLine('On This Mac', true, false, 'On This Mac')).toBe(false)
  expect(falseSaveLine('Saved to This Mac 4:24 AM', true, false, 'Saved to This Mac 4:20 AM')).toBe(true)
})

it('requires a search scope line about the omitted content', () => {
  expect(explainsMissingContent(['Nothing found', 'LifeOS is signed out on This Mac.'])).toBe(false)
  expect(explainsMissingContent(['Names only for Teams files.'])).toBe(true)
  expect(explainsMissingContent(['The contents of this library were not searched.'])).toBe(true)
})

it('J18: a name opens, or on a far computer is named as not searched; words on another computer are a note', () => {
  const r = (surface: 'Files' | 'Work', query: 'name' | 'content', over: { opened?: boolean; found?: boolean; lines?: string[] } = {}) => ({ surface, query, found: false, opened: false, lines: [], ...over })
  const far = ['Folders on Purdue laptop were not searched.']
  expect(searchVerdict('B1', [r('Files', 'name', { opened: true, found: true }), r('Work', 'name', { opened: true, found: true }), r('Files', 'content')])).toEqual({ failures: [], notes: [expect.stringMatching(/^Files by content: not found/)] })
  expect(searchVerdict('B1', [r('Files', 'name', { lines: far })]).failures).toHaveLength(1)
  expect(searchVerdict('B2', [r('Files', 'name', { lines: far }), r('Work', 'name', { lines: ['Nothing found'] })]).failures).toEqual(['Work by name: no open file (Nothing found)'])
  expect(searchVerdict('A', [r('Files', 'content')]).failures).toHaveLength(1)
})

it('tracks a native open answer for the file and the socket that asked', () => {
  const proof = new AppOpenProof()
  proof.watch('/run/Practice.txt')
  const open = (path: string) => ({ id: '1', method: 'work.office.filesOpen', params: { source: { path } } })
  proof.frame('a', true, open('/run/Other.txt'))
  proof.frame('a', false, { id: '1', ok: true, result: { opened: true } })
  expect(proof.answer).toBeUndefined()
  proof.frame('a', true, open('/run/Practice.txt'))
  proof.frame('b', false, { id: '1', ok: true, result: { opened: true } })
  expect(proof.answer).toBeUndefined()
  proof.frame('a', false, { id: '1', ok: false, error: 'No app' })
  expect(proof.answer).toEqual({ opened: false, error: 'No app' })
  proof.watch('/run/Practice.txt')
  proof.frame('a', true, open('/run/Practice.txt'))
  proof.frame('a', false, { id: '1', ok: true, result: { opened: true } })
  expect(proof.answer).toEqual({ opened: true })
})

it('drives the context menu and selection with mouse events', async () => {
  const send = vi.fn(async (_method: string, _params?: unknown) => undefined)
  const page = Object.assign(Object.create(Window.prototype) as Window, {
    cdp: { send }, signal: new AbortController().signal
  })
  await page.click({ x: 4, y: 5 }, 1, 'right')
  expect(send.mock.calls).toContainEqual(['Input.dispatchMouseEvent', { type: 'mousePressed', x: 4, y: 5, button: 'right', clickCount: 1 }])
  await page.click({ x: 4, y: 5 }, 1, 'left', 8)
  expect(send.mock.calls).toContainEqual(['Input.dispatchMouseEvent', { type: 'mousePressed', x: 4, y: 5, button: 'left', modifiers: 8, clickCount: 1 }])
  send.mockClear()
  await page.drag({ x: 9, y: 10 }, { x: 17, y: 10 })
  expect(send.mock.calls).toContainEqual(['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 13, y: 10, buttons: 1 }])
  expect(send.mock.calls.at(-1)).toEqual(['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 17, y: 10, button: 'left', clickCount: 1 }])
  await page.hover({ x: 3, y: 2 })
  expect(send.mock.calls.at(-1)).toEqual(['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 3, y: 2 }])
})

it('reloads and returns only once the new page runs, never on the old page', async () => {
  // The old page answers a check until the reload lands: its marker goes with it.
  const window: { __journeyOldPage?: boolean } = {}
  let reloaded = false
  const send = vi.fn(async (method: string) => {
    if (method === 'Page.reload') setTimeout(() => { delete window.__journeyOldPage; reloaded = true }, 300)
  })
  const evaluate = vi.fn(async (expression: string) => new Function('window', 'document', 'return ' + expression)(window, { readyState: 'complete' }))
  const page = Object.assign(Object.create(Window.prototype) as Window, {
    cdp: { send, eval: evaluate }, signal: new AbortController().signal
  })
  await page.reload()
  expect(send.mock.calls).toEqual([['Page.reload']])
  expect(reloaded).toBe(true)
})

it('reads only the bytes of the named anchor download', async () => {
  const evaluate = vi.fn(async (_expression: string) => [66, 108, 117, 101])
  const page = Object.assign(Object.create(Window.prototype) as Window, {
    cdp: { eval: evaluate }, signal: new AbortController().signal
  })
  await expect(page.downloaded('Practice.txt')).resolves.toEqual(Buffer.from('Blue'))
  expect(evaluate.mock.calls[0]?.[0]).toContain('window.__journeyDownloads.get("Practice.txt")')
})


it('keeps a new toast with the same words as an older toast', async () => {
  const old = { textContent: 'Did not open' }
  const fresh = { textContent: 'Did not open' }
  let nodes = [old]
  const namespace = {}
  const page = Object.assign(Object.create(Window.prototype) as Window, {
    cdp: { eval: async (expression: string) => new Function('window', 'document', 'return ' + expression)(namespace, { querySelectorAll: () => nodes }) }
  })
  await page.watchToasts()
  nodes = [old, fresh]
  await expect(page.toasts(true)).resolves.toEqual(['Did not open'])
  await expect(page.toasts()).resolves.toEqual(['Did not open', 'Did not open'])
})

it('selects the current folder tab while the dock has folded the sidebar', async () => {
  const clickOn = vi.fn()
  await selectFolderTab({ pair: { page: { clickOn } }, workspace: { name: 'Practice' } } as unknown as Context)
  expect(clickOn).toHaveBeenCalledWith('[data-files-tab][data-tab-kind="page"]', 'Practice')
})

it('reads document words across their rendered editor regions', async () => {
  const doc = { querySelectorAll: () => [{ innerText: 'Practice on Tuesday' }, { innerText: 'Bring a notebook' }] }
  const page = { eval: (expression: string) => Promise.resolve(new Function('document', 'return ' + expression)(doc)) } as Window
  await expect(documentHas(page, 'Tuesday', 'notebook')).resolves.toBe(true)
  await expect(documentHas(page, 'Thursday')).resolves.toBe(false)
})

it('counts PDF streams and pages and checks Letter in either orientation', async () => {
  const bytes = Buffer.from(dummyPdf())
  const facts = await pdfFacts(bytes)
  expect(facts).toEqual({ size: bytes.length, streams: 3, pages: Array(3).fill({ width: 612, height: 792 }) })
  expect(letterPaper(facts.pages)).toBe(true)
  expect(letterPaper([{ width: 792, height: 612 }])).toBe(true)
  expect(letterPaper([{ width: 595, height: 842 }])).toBe(false)
  expect(letterPaper([])).toBe(false)
  await expect(pdfFacts(Buffer.from('Not a PDF'))).rejects.toThrow('no PDF header')
})

it('records only local Electron print files in the viewer stand-in', () => {
  const root = mkdtempSync(join(tmpdir(), 'journeys-print-'))
  try {
    const bin = join(root, 'bin')
    const temp = join(root, 'short', 'win')
    const printed = join(temp, 'TempCode-print', 'practice', 'Print.pdf')
    mkdirSync(bin)
    mkdirSync(dirname(printed), { recursive: true })
    writeFileSync(printed, dummyPdf())
    printViewer(bin)
    const viewer = join(bin, 'xdg-open')
    const outside = join(root, 'Print.pdf')
    writeFileSync(outside, dummyPdf())
    const options = { env: { PATH: process.env.PATH, TMPDIR: temp } }
    expect(() => execFileSync(viewer, [outside], options)).toThrow()
    execFileSync(viewer, [printed], options)
    expect(readFileSync(join(root, 'print-viewer.log'), 'utf8')).toBe(printed + '\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('serves a fixed fake provider stream with one text block and no tool calls', () => {
  const events = fakeMessage('dummy-model').trim().split('\n\n').map((block) => JSON.parse(block.split('\ndata: ')[1]!))
  expect(events.map((event) => event.type)).toEqual([
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'
  ])
  expect(events[0].message.model).toBe('dummy-model')
  expect(events[2].delta).toEqual({ type: 'text_delta', text: 'I have the practice list.' })
})

it('scripts only the mail prompt and offers only an id returned by its real draft tool', () => {
  const fixture = { prompt: 'Please draft a reply', threadId: 'mail1', body: 'The room is ready.' }
  const tools = [{ name: 'mcp__app__lifeos__draft_mail' }, { name: 'mcp__work__mail_offer' }]
  const prompt = { role: 'user', content: fixture.prompt }
  const search = mailReplyTool({ messages: [prompt], tools: [{ name: 'ToolSearch' }] }, fixture)
  expect(search).toMatchObject({ name: 'ToolSearch', input: { query: 'select:' + tools.map(({ name }) => name).join(',') } })
  const draft = mailReplyTool({ messages: [prompt], tools }, fixture)
  expect(draft).toMatchObject({ name: tools[0]!.name, input: { thread_id: 'mail1', body: fixture.body } })
  expect(fakeMessage('dummy', draft, 'msg_journey_2')).toContain('"id":"msg_journey_2"')
  expect(fakeMessage('dummy', draft)).toContain('"stop_reason":"tool_use"')
  const result = (id: string, content: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ text: content }] }] })
  expect(mailReplyTool({ messages: [prompt, result(search!.id, 'No match')], tools: [{ name: 'ToolSearch' }] }, fixture)).toBeUndefined()
  const drafted = result(draft!.id, '{"id":"draft123"}')
  const offer = mailReplyTool({ messages: [prompt, drafted], tools }, fixture)
  expect(offer).toMatchObject({ name: tools[1]!.name, input: { draft: { draftId: 'draft123' } } })
  expect(mailReplyTool({ messages: [prompt, drafted, result(offer!.id, 'OK')], tools }, fixture)).toBeUndefined()
  expect(mailReplyTool({ messages: [prompt, result(draft!.id, 'Refused')], tools }, fixture)).toBeUndefined()
  expect(mailReplyTool({ messages: [{ ...prompt, content: 'Another prompt' }], tools }, fixture)).toBeUndefined()
})

it('carries one transfer through the row drag and dispatches the desktop File bytes', async () => {
  class Transfer {
    files: File[] = []
    items = { add: (file: File) => this.files.push(file) }
  }
  class Event {
    constructor(readonly type: string, readonly init: { dataTransfer: Transfer }) {}
  }
  const caught: Event[] = []
  const target = { dispatchEvent: (event: Event) => caught.push(event), closest: () => target }
  const doc = { querySelector: () => target, elementFromPoint: () => target }
  const page = {
    eval: (expression: string) => Promise.resolve(
      new Function('document', 'DataTransfer', 'DragEvent', 'return ' + expression)(doc, Transfer, Event)
    )
  } as Window
  await rowDrop(page, { x: 1, y: 3 }, { x: 4, y: 5 })
  expect(caught.map(({ type }) => type)).toEqual(['dragstart', 'dragenter', 'dragover', 'drop', 'dragend'])
  expect(new Set(caught.map(({ init }) => init.dataTransfer)).size).toBe(1)
  caught.length = 0
  await desktopDrop(page, '.folder', 'Practice.txt', 'text/plain', Buffer.from('Blue'))
  expect(caught.map(({ type }) => type)).toEqual(['dragenter', 'dragover', 'drop'])
  const file = caught[2]?.init.dataTransfer.files[0]
  expect(file?.name).toBe('Practice.txt')
  await expect(file?.text()).resolves.toBe('Blue')
})

it('closes the selected file by id even if its title changed on import', async () => {
  const evalInPage = vi.fn().mockResolvedValueOnce('imported-doc').mockResolvedValueOnce(true)
  const clickOn = vi.fn()
  const page = {
    eval: evalInPage, clickOn,
    until: async (_label: string, _ms: number, test: () => Promise<unknown>) => { expect(await test()).toBeTruthy() }
  } as unknown as Window
  await closeSelectedFile(page)
  expect(clickOn).toHaveBeenCalledWith('[data-menu-id="imported-doc"] [data-files-tab-close]')
  expect(evalInPage.mock.calls[1]?.[0]).toContain('imported-doc')
})

it('puts the fake profile and its sealed credential in the run vault', () => {
  const root = mkdtempSync(join(tmpdir(), 'journeys-provider-'))
  try {
    seedFakeAccount(root)
    expect(JSON.parse(readFileSync(join(root, 'profiles.json'), 'utf8'))).toMatchObject({
      'claude-code': [{ email: 'practice@example.test', accountId: 'journey-practice' }]
    })
    const credential = readFileSync(join(root, 'secrets', 'claude-code__practice%40example.test.bin'))
    expect(credential.includes(Buffer.from('JOURNEY-LOOPBACK'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('runs K and U without desk and can keep the shared table untouched', () => {
  const picks = options(['--only', 'J20,J54', '--shape', 'K,U', '--no-table'])
  expect(picks.jobs.map(({ spec, shape }) => [spec.id, shape])).toEqual([['J20', 'U'], ['J54', 'K']])
  expect(walkSetup(picks.jobs[0]!, picks.desk).desk).toBe(false)
  expect(picks.noTable).toBe(true)
  const context = { workspace: { path: '/tmp/dummy' } } as Context
  for (const shape of ['K', 'U'] as const) expect(holderFolder({ ...context, shape })).toBe('/tmp/dummy')
})

it('signs the Work call as the named thread using both bridge tokens', () => {
  const seed = 'fe'.repeat(32)
  const sign = (input: string) => createHmac('sha256', Buffer.from(seed, 'hex')).update(input).digest('base64url')
  expect(toolCall('thread-test', seed, 5, 'files_places', {})).toEqual({
    sessionId: 'thread-test', appToken: sign('app-bridge:thread-test'), token: sign('thread-test'), call: 5, tool: 'files_places', args: {}
  })
})

it('cuts only the relayed link and reconnects to the same live host', async () => {
  const host = createServer((socket) => socket.on('data', (data) => socket.write(data)))
  host.listen(0, '127.0.0.1')
  await once(host, 'listening')
  const port = (host.address() as { port: number }).port
  const hop = await relay('127.0.0.1', port)
  const sockets = [hop.port, port].map((port) => createConnection(port, '127.0.0.1'))
  const echo = async (socket: typeof sockets[number], text: string) => {
    const got = once(socket, 'data')
    socket.write(text)
    expect(String((await got)[0])).toBe(text)
  }
  try {
    await echo(sockets[0]!, 'first')
    const closed = once(sockets[0]!, 'close')
    hop.cut(true)
    await closed
    const refused = createConnection(hop.port, '127.0.0.1')
    await once(refused, 'close')
    await echo(sockets[1]!, 'still up')
    hop.cut(false)
    const restored = createConnection(hop.port, '127.0.0.1')
    sockets.push(restored)
    await echo(restored, 'again')
  } finally {
    for (const socket of sockets) socket.destroy()
    await hop.stop()
    await new Promise<void>((resolve) => host.close(() => resolve()))
  }
})

it('lets the dummy add-in write only its one approved change to its Word fixture', () => {
  const folder = mkdtempSync(join(tmpdir(), 'journeys-word-'))
  try {
    const file = join(folder, 'dummy.docx')
    const before = readFileSync(join(REPO, 'resources/work-templates/any/Meeting notes.docx'))
    writeFileSync(file, before)
    const fixture = wordFixture(file, '{{Meeting}}', 'Practice time')
    expect(fixture.paragraphs()).toContain('{{Meeting}}')
    expect(() => fixture.edit({ tracked: true, edit: { find: '{{Meeting}}', replace: 'Practice time' } })).toThrow('plain Word edit')
    expect(readFileSync(file)).toEqual(before)
    expect(fixture.edit({ tracked: false, edit: { find: '{{Meeting}}', replace: 'Practice time' } })).toBe(1)
    expect(fixture.paragraphs()).toContain('Practice time')
    expect(fixture.paragraphs()).not.toContain('{{Meeting}}')
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

it('registers the last nine walks and gives documents, Capture and guest pages a sandbox', () => {
  const tier = options(['--tier', '3'])
  expect(tier.jobs.map(({ spec, shape }) => spec.id + ' ' + shape)).toEqual([
    'J43 A', 'J45 A', 'J46 A', 'J47 A', 'J48 A', 'J49 A', 'J59 A', 'J59 U', 'J60 A'
  ])
  for (const job of options(['--only', 'J48,J49,J59']).jobs) expect(walkSetup(job).sandbox).toBe(true)
  for (const job of options(['--only', 'J43,J45,J46,J47,J60']).jobs) expect(walkSetup(job).sandbox).toBe(false)
})

it('requires the receipt Ref, vendor and numeric amount together in the ledger', () => {
  const row = { 0: null, 1: { v: 'Practice Cafe' }, 5: { v: 12.5 }, 9: { v: 'm123' } }
  const ops = (cellValue: unknown) => JSON.stringify([{ mutations: [{ params: { cellValue } }] }])
  expect(ledgerHasReceipt(ops({ 1: row }), 'm123', 'Practice Cafe', 12.5)).toBe(true)
  expect(ledgerHasReceipt(ops({ 1: row, 2: { 5: { v: 7 } } }), 'm123', 'Practice Cafe', 7)).toBe(false)
  expect(ledgerHasReceipt(ops({ 1: row }), 'm456', 'Practice Cafe', 12.5)).toBe(false)
})

it('compares all four defaults and the workspace and scope of the routine’s own thread', () => {
  const defaults = { provider: 'claude', permission: 'auto', model: 'claude-haiku-5-5', reasoning: 'high' }
  const row = { ...defaults, id: 's', workspace_id: 'w', scope: 'work' }
  expect(routineThreadMatches(row, 'w', defaults)).toBe(true)
  for (const key of Object.keys(defaults)) {
    expect(routineThreadMatches({ ...row, [key]: 'different' }, 'w', defaults)).toBe(false)
  }
  expect(routineThreadMatches({ ...row, scope: 'code' }, 'w', defaults)).toBe(false)
  expect(routineThreadMatches(row, 'wrong', defaults)).toBe(false)
})

it('checks the audience window dark and every other surface light, and lets U leave Capture and the Full editor unwalked', () => {
  const black = { marker: null, className: 'ready bg-(--matte)', backgrounds: ['rgb(0, 0, 0)'], rgba: [0, 0, 0, 255] }
  expect(wearsDark(black)).toBe(true)
  expect(wearsDark({ ...black, className: 'theme-light' })).toBe(false)
  expect(wearsDark({ ...black, rgba: [250, 250, 250, 255] })).toBe(false)
  expect(expected('slideshow', 'A')).toBe('dark')
  expect(expected('presenter', 'A')).toBe('light')
  expect(expected('capture', 'U')).toBe('not walked')
  expect(expected('capture', 'A')).toBe('light')
  const row = (surface: string, result: 'PASS' | 'FAIL' | 'not walked') => ({ surface, result, picture: surface + '.png' })
  expect(broken([row('slideshow', 'PASS'), row('capture', 'not walked'), row('full-editor', 'not walked'), row('print', 'PASS')], 'U')).toEqual([])
  expect(broken([row('capture', 'not walked')], 'A').map((r) => r.surface)).toEqual(['capture'])
  expect(broken([row('capture', 'FAIL')], 'U').map((r) => r.surface)).toEqual(['capture'])
})

it('names the far library’s holder changes and refuses a verb it should not offer', () => {
  expect(changed({ a: '1', b: '2' }, { a: '1', b: '2' })).toEqual([])
  expect(changed({ a: '1', b: '2' }, { a: '1', b: '3', c: '4' })).toEqual(['b', 'c'])
  expect(changed({ a: '1' }, {})).toEqual(['a'])
  const item = (label: string, enabled = true) => ({ label, enabled, words: label })
  expect(() => notOffered([item('Open'), item('Download')], 'Delete', 'The row menu')).not.toThrow()
  expect(() => notOffered([item('Open'), item('Rename…')], 'Rename', 'The tab menu')).toThrow('The tab menu offers Rename in the far library')
  // Listed but disabled is not offered.
  expect(() => notOffered([item('Delete', false)], 'Delete', 'The row menu')).not.toThrow()
})

it('only sends the global shortcut to the X server owned by this isolated win', () => {
  const display = ['TEMP_CODE_USER_DATA=/run/win-data', 'DISPLAY=:42', 'XAUTHORITY=/run/win-tmp/xvfb-run.abcd/Xauthority']
  expect(ownedDisplay(display, '/run/win-data', '/run/win-tmp')).toEqual({ DISPLAY: ':42', XAUTHORITY: '/run/win-tmp/xvfb-run.abcd/Xauthority' })
  expect(ownedDisplay(display, '/other/win-data', '/run/win-tmp')).toBeNull()
  expect(ownedDisplay(display, '/run/win-data', '/other/win-tmp')).toBeNull()
  expect(ownedDisplay(display.map(entry => entry === 'DISPLAY=:42' ? 'DISPLAY=desk:0' : entry), '/run/win-data', '/run/win-tmp')).toBeNull()
})

it('requires both a light marker and light painted pixels on the measured surface', () => {
  const light = { marker: 'light', className: '', backgrounds: ['rgb(250, 250, 250)'], rgba: [250, 250, 250, 255] }
  expect(wearsLight(light)).toBe(true)
  expect(wearsLight({ ...light, marker: null, className: 'foo theme-light' })).toBe(true)
  expect(wearsLight({ ...light, marker: null })).toBe(false)
  expect(wearsLight({ ...light, rgba: [22, 22, 22, 255] })).toBe(false)
  expect(wearsLight({ ...light, rgba: [250, 250, 250, 0] })).toBe(false)
})

it('finds a full local Chromium and requires a headed start for the Browser walk', () => {
  const cache = mkdtempSync(join(tmpdir(), 'journeys-chromium-'))
  try {
    const make = (path: string) => {
      const file = join(cache, path)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '')
      return file
    }
    expect(boxChromium(join(cache, 'absent'))).toBeUndefined()
    make('chromium_headless_shell-5000/chrome-linux/chrome')
    make('chromium-999/chrome-linux/chrome')
    const newest = make('chromium-1000/chrome-linux64/chrome')
    expect(boxChromium(cache)).toBe(newest)
    expect(headedResult('box browser: started headed on :97 (pid 10)', true)).toBeNull()
    expect(headedResult('box browser: started headless (pid 10)', false)).toMatch(/no headed browser tools/)
    expect(headedResult('box browser: its display did not start (Xorg stopped); it runs headless', true)).toContain('Xorg stopped')
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
})

it('takes a picture at a successful Tier 3 step', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'journeys-picture-'))
  try {
    const shot = vi.fn(async (file: string) => writeFileSync(file, 'picture'))
    const pair = { abort: new AbortController(), hostErrors: [], page: { shot } } as unknown as Pair
    const result = await walk({
      id: 'J00', title: 'test', tier: 3, shapes: ['A'], steps: [step('end: done', () => {})]
    }, { pair, shape: 'A', folder, workspace: { id: 'a', name: 'a', path: folder } }, new Promise<never>(() => undefined))
    expect(result.steps).toEqual([{ name: 'end: done', picture: 'J00-A/01-end-done.png' }])
    expect(shot).toHaveBeenCalledExactlyOnceWith(join(folder, '01-end-done.png'))
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

it('holds the dummy Browser turn while letting other fake model calls finish', async () => {
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  let serve!: (request: Request) => Promise<Response>
  vi.stubGlobal('Bun', {
    serve: ({ fetch }: { fetch: typeof serve }) => { serve = fetch }
  })
  try {
    const got = vi.fn()
    startFakeProvider(got, hold)
    const request = (text: string) => new Request('http://127.0.0.1/v1/messages', {
      method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: text }] })
    })
    const finished = vi.fn()
    const browser = serve(request(BROWSER_PROMPT)).then(finished)
    expect((await serve(request('Another dummy chat'))).ok).toBe(true)
    expect(got).toHaveBeenCalledTimes(2)
    expect(finished).not.toHaveBeenCalled()
    release()
    await browser
    expect(finished).toHaveBeenCalledOnce()
  } finally {
    release()
    vi.unstubAllGlobals()
  }
})

it('presses Keep trying on a pending workbook close and still waits for the tab to go', async () => {
  const tabClosed = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const clickOn = vi.fn()
  const page = {
    tabClosed, clickOn, eval: vi.fn().mockResolvedValue(true), centre: vi.fn().mockResolvedValue({ x: 5, y: 9 }),
    until: async (_label: string, _ms: number, test: () => Promise<unknown>) => { expect(await test()).toBeTruthy() }
  } as unknown as Window
  await finishWorkbookClose(page, 'Practice.xlsx')
  expect(clickOn).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'Keep trying')
  expect(tabClosed).toHaveBeenCalledTimes(2)
  clickOn.mockClear()
  tabClosed.mockResolvedValue(true)
  await finishWorkbookClose(page, 'Already closed.xlsx')
  expect(clickOn).not.toHaveBeenCalled()
})

it('requires the native refusal and the matching toast for the library recording on Linux', () => {
  const error = 'A file opens in its app on a Mac or a Windows PC.'
  const refusal = { opened: false, error }
  expect(soundAppOpened('linux', undefined, [])).toBe(false)
  expect(soundAppOpened('linux', refusal, [error])).toBe(false)
  expect(soundAppOpened('linux', refusal, ['Practice sound.wav did not open' + error])).toBe(true)
  expect(() => soundAppOpened('linux', { opened: false, error: 'File not found' }, [])).toThrow('File not found')
  expect(soundAppOpened('win32', { opened: true }, [])).toBe(true)
  expect(() => soundAppOpened('darwin', refusal, [])).toThrow(error)
})

it('checks the Connections status and detail independently of the status word', () => {
  const row = { id: 'lifeos.signin', pillar: 'lifeos', group: 'LifeOS', title: 'LifeOS', state: 'working', line: 'Signed in' } as const
  const seen = { title: 'LifeOS on box', state: 'done', detail: 'Signed in', words: 'LifeOS on box Ready Signed in' }
  expect(connectionMatches(row, seen)).toBe(true)
  expect(connectionMatches(row, { ...seen, words: 'Ready', detail: 'Needs a key' })).toBe(false)
  expect(connectionMatches(row, { ...seen, state: 'waiting' })).toBe(false)
  // A down LifeOS row is worded by the window, its computer named: its state is checked, not the host's line.
  const pairing = { ...row, state: 'needs-you', lifeos: 'pairing', line: 'The LifeOS sign-in waits for your approval' } as const
  expect(connectionMatches(pairing, { ...seen, title: 'LifeOS', state: 'waiting', detail: 'The LifeOS sign-in on box waits for your approval' })).toBe(true)
  expect(connectionMatches(pairing, { ...seen, title: 'LifeOS', state: 'failed', detail: 'The LifeOS sign-in on box waits for your approval' })).toBe(false)
})

it('rechecks the hit after hovering before it clicks a moving control', async () => {
  const before = { x: 50, y: 60 }
  const after = { x: 80, y: 90 }
  const page = Object.assign(Object.create(Window.prototype) as Window, {
    centre: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
    hover: vi.fn(),
    click: vi.fn(),
    until: (label: string, ms: number, check: () => Promise<unknown>) => until(label, ms, check)
  })
  await page.clickOn('button', 'Open')
  expect(page.hover.mock.calls).toEqual([[before], [after]])
  expect(page.click).toHaveBeenCalledExactlyOnceWith(after)
})

it('looks for the chip in every rendered composer and ignores inactive seats', async () => {
  const shell = (innerText: string, inactive = false) => ({
    getClientRects: () => ({ length: 1 }), closest: () => inactive, innerText
  })
  const contents = { ...shell('Attachment'), getClientRects: () => [], querySelectorAll: () => [shell('Attachment')] }
  const document = { querySelectorAll: vi.fn().mockReturnValue([shell('Ask'), shell('Spring LAN tables'), shell('Old room', true), contents]) }
  const getComputedStyle = () => ({ display: 'contents' })
  const page = {
    eval: (expression: string) => Promise.resolve(
      new Function('document', 'getComputedStyle', 'return ' + expression)(document, getComputedStyle)),
    until: async (label: string, _ms: number, check: () => Promise<unknown>) => {
      if (!await check()) throw new Error(label)
    }
  } as Window
  await expect(see(page, '[data-composer]', 'Spring LAN tables')).resolves.toBeUndefined()
  await expect(see(page, '[data-composer]', 'Old room')).rejects.toThrow('Old room')
  await expect(see(page, '[data-canvas-seat]', 'Attachment')).resolves.toBeUndefined()
})

it('scrolls a Files row into view and only returns a point that hits that row', async () => {
  const scrollIntoView = vi.fn()
  const row = {
    querySelectorAll: () => [{ childElementCount: 0, textContent: 'Roster.xlsx' }],
    getBoundingClientRect: () => ({ x: 8, y: 40, width: 200, height: 20 }),
    contains: (hit: unknown) => hit === row,
    scrollIntoView
  }
  const document = {
    querySelectorAll: () => [row],
    elementFromPoint: vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(row)
  }
  const page = {
    eval: (expression: string) => Promise.resolve(new Function('document', 'return ' + expression)(document))
  } as Window
  expect(await rowAt(page, 'Roster.xlsx')).toBeNull()
  expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'nearest' })
  expect(await rowAt(page, 'Roster.xlsx')).toEqual({ x: 20, y: 50 })
})

it('waits for the host to record the Word baseline before exercising close', async () => {
  const library = mkdtempSync(join(tmpdir(), 'journey-word-ready-'))
  const rows = vi.spyOn(threadProof, 'hostRows')
    .mockResolvedValueOnce([{ base_rev: null }])
    .mockResolvedValueOnce([{ base_rev: 'observed' }])
  const page = {
    until: async (_label: string, _ms: number, check: () => Promise<unknown>) => {
      expect(await check()).toBeNull()
      expect(await check()).toBe('observed')
    }
  }
  const context = { pair: { l1: library, page }, shape: 'B1', workspace: { id: 'job', name: 'Practice' } } as unknown as Context
  try {
    await waitForWordRevision(context, 'Read only visit.docx')
    expect(rows).toHaveBeenCalledTimes(2)
    expect(rows).toHaveBeenLastCalledWith(context.pair, expect.stringContaining('SELECT base_rev'), 'job', join(library, 'Practice', 'Read only visit.docx'))
  } finally {
    rows.mockRestore()
    rmSync(library, { recursive: true, force: true })
  }
})

it('waits for the scrubbed frame and then the next frame before recording the note anchor', async () => {
  const frames = [0, 48, 48, 49]
  const key = vi.fn(() => expect(frames).toEqual([48, 49]))
  const page = {
    clickOn: vi.fn(), key, eval: vi.fn(() => frames.shift()),
    until: async (_label: string, _ms: number, check: () => Promise<boolean>) => {
      expect(await check()).toBe(false)
      expect(await check()).toBe(true)
    }
  } as unknown as Window
  await expect(scrubFrame(page)).resolves.toBe(49)
  expect(key).toHaveBeenCalledExactlyOnceWith('ArrowRight')
})
