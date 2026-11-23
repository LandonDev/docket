import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCollaborationClient, type CollaborationClient } from 'work-kit/collab'
import { createCollabSigner, generateCollabKeys, TEMPCODE_COLLAB_AUDIENCE, type CollabSigner } from 'work-kit/collab-server'
import type { GuestSource } from '@shared/contract-work-guests'
import type { WorkCtx } from '../modules'
import { servicePaths } from '../service/config'
import { startFakeConvex, type FakeConvex } from '../service/fakeConvex'
import { startWorkService, type RunningService } from '../service/serve'
import { GuestRuntime } from './links'
import { Page } from './proofPage'
import { ensureGuestTables } from './store'

/*
 * The live proof of milestone 31 (landed/M31.md): the real Work service on
 * the box's own listener, the built hosted page (M31_HOSTED, out/hosted) in
 * a headless Chromium driven over CDP, against a fake LifeOS. Opt-in:
 *
 *   M31_PROOF=1 M31_HOSTED=/tmp/m31-hosted M31_SHOTS=<dir> NODE_ENV=test bunx vitest run src/main/server/work/guests/live.proof.test.ts
 *
 * Every request carries a CF-Connecting-IP as the tunnel would.
 */

const ON = !!process.env.M31_PROOF
const HOSTED = process.env.M31_HOSTED ?? ''
const SHOTS = process.env.M31_SHOTS ?? ''
const CHROME = process.env.M31_CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-linux64/chrome-headless-shell`
const DOC = 'kdocproof'
const SHEET = 'ksheetproof'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
Page.shots = SHOTS

// ── the rig ─────────────────────────────────────────────────────────────

const box: { dir: string; convex: FakeConvex; service: RunningService; rt: GuestRuntime; signer: CollabSigner; chrome: ChildProcess; debugPort: number; base: string; clients: CollaborationClient[] } = {} as never

beforeAll(async () => {
  if (!ON) return
  box.dir = mkdtempSync(join(tmpdir(), 'm31-proof-'))
  box.convex = await startFakeConvex()
  box.convex.docs.set(DOC, { _id: DOC, sector: 'purdue', seq: 0, title: 'Spring LAN run of show', shared: false, markdown: '', plain: '' })
  box.convex.sheets.set(SHEET, { title: 'Nationals travel budget', sector: 'purdue', ops: [] })
  const keys = await generateCollabKeys('proof')
  box.signer = await createCollabSigner({ privateJwk: keys.privateJwk, iss: 'tempcode:env_box' })
  mkdirSync(join(box.dir, 'data'), { recursive: true })
  box.service = await startWorkService(
    {
      port: 0,
      socketPath: servicePaths(join(box.dir, 'data')).socketPath,
      secret: 's'.repeat(43),
      dataDir: join(box.dir, 'data', 'work-service'),
      hostedDir: HOSTED,
      host: 'env_box',
      lifeos: { here: true, url: box.convex.url },
      trusted: [{ by: 'host', iss: 'tempcode:env_box', aud: TEMPCODE_COLLAB_AUDIENCE, keys: [keys.publicJwk] }],
      links: []
    },
    { jwt: async () => 'owner-jwt', log: (l) => console.log(`[service] ${l}`) }
  )
  box.base = `http://127.0.0.1:${box.service.port}`
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('work.ownerName', 'Landon Hale')
  ensureGuestTables(db)
  const ctx = {
    db,
    host: 'env_box',
    log: (l: string) => console.log(l),
    push: () => {},
    service: { url: (r: string) => `${box.base}${r}`, token: async () => 'ok', internal: async () => ({ seen: {} }) },
    lifeos: {
      owner: () => ({
        query: async (fn: string, a: { id: string }) => (fn === 'docs:get' ? box.convex.docs.get(a.id) : box.convex.sheets.get(a.id) ? { sector: 'purdue', title: box.convex.sheets.get(a.id)!.title } : null),
        mutation: async () => null
      })
    }
  } as unknown as WorkCtx
  process.env.TEMP_CODE_WORK_PUBLIC_ORIGIN = box.base
  box.rt = new GuestRuntime(ctx, () => ({ tokenSigner: () => box.signer, setLinks: (l) => box.service.setLinks(l), setProject: (id, project) => box.service.setProject(id, project) }))
  box.clients = []
  const profile = join(box.dir, 'chrome')
  box.chrome = spawn(CHROME, ['--headless', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  box.debugPort = await new Promise<number>((resolve, reject) => {
    let err = ''
    box.chrome.stderr!.on('data', (c: Buffer) => {
      err += c.toString()
      const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err)
      if (m) resolve(Number(m[1]))
    })
    box.chrome.on('exit', () => reject(new Error(`chrome exited: ${err}`)))
  })
}, 60_000)

afterAll(async () => {
  if (!ON) return
  box.chrome?.kill('SIGKILL')
  await Promise.all(box.clients.map((c) => c.destroy()))
  await box.service?.stop()
  await box.convex?.close()
  await sleep(500)
  rmSync(box.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

const source = (table: 'docs' | 'sheets', id: string): GuestSource => ({ at: 'lifeos', table, id })
const link = (role: 'view' | 'comment' | 'edit', table: 'docs' | 'sheets' = 'docs', name = 'Dana Lee') =>
  box.rt.create({ source: source(table, table === 'docs' ? DOC : SHEET), title: table === 'docs' ? 'Spring LAN run of show' : 'Nationals travel budget', name, role, expiresAt: Date.now() + 29 * 24 * 3600_000, bySession: null })
const owner = async (): Promise<CollaborationClient> => {
  const token = (await box.signer.sign({ doc: DOC, role: 'edit', principal: 'owner' }, 600)).token
  const c = createCollaborationClient({ documentName: DOC, token, url: `ws://127.0.0.1:${box.service.port}/w/doc/${DOC}`, offline: false })
  box.clients.push(c)
  await until(() => c.provider.isSynced)
  return c
}
const until = async (ok: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(50)
  }
}
const plain = async (): Promise<string> => (await box.service.collab.read(DOC)).plain
const EDITOR = "document.querySelector('.ProseMirror')"

describe.skipIf(!ON)('the guest page, live on the box listener', () => {
  it('an edit link edits a document live with the owner, both ways', async () => {
    await box.service.collab.writeMarkdown(DOC, 'owner', '# Morning\n\nCheck-in opens at the north doors.\n\nDoors open at 9:00, not before.')
    const made = await link('edit')
    const me = await owner()
    for (const scheme of ['light', 'dark'] as const) {
      const page = await Page.open(box.debugPort)
      await page.go(made.url, scheme)
      await page.until('the editor', `!!${EDITOR} && ${EDITOR}.isContentEditable && ${EDITOR}.innerText.includes('north doors')`)
      if (scheme === 'light') {
        await page.eval(`(() => { const p = [...${EDITOR}.querySelectorAll('p')].find((x) => x.innerText.includes('north doors')); const r = document.createRange(); r.selectNodeContents(p); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); ${EDITOR}.focus(); return true })()`)
        await page.type(' Bring a badge.')
        await until(() => me.document.getXmlFragment('document-store').toString().includes('Bring a badge'), 10_000).catch(async () => {
          expect(await plain()).toContain('Bring a badge')
        })
        expect(await plain()).toContain('Bring a badge')
        await box.service.collab.writeMarkdown(DOC, 'owner', '# Morning\n\nCheck-in opens at the north doors. Bring a badge.\n\nDoors open at 9:00, not before. The owner wrote this.')
        await page.until('the owner\'s words', `${EDITOR}.innerText.includes('The owner wrote this')`)
      }
      await page.eval(`document.querySelector('header').innerText`).then((t) => expect(t).toMatch(/Spring LAN run of show[\s\S]*Landon Hale[\s\S]*Can edit[\s\S]*until/))
      // No way out of the item: the page links nowhere but itself, and never to the full editor.
      expect(await page.eval<string[]>(`[...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))`)).toEqual([])
      expect(await page.eval<string>('document.documentElement.outerHTML')).not.toContain('/w/full')
      await page.shot(`01-edit-doc.${scheme}`)
      page.close()
    }
  }, 90_000)

  it('a view link reads, and what it types goes nowhere', async () => {
    const made = await link('view', 'docs', 'Sam Ortiz')
    const before = await plain()
    for (const scheme of ['light', 'dark'] as const) {
      const page = await Page.open(box.debugPort)
      await page.go(made.url, scheme)
      await page.until('the text', `!!${EDITOR} && ${EDITOR}.innerText.includes('north doors')`)
      expect(await page.eval<boolean>(`${EDITOR}.isContentEditable`)).toBe(false)
      await page.eval(`(${EDITOR}.focus(), true)`)
      await page.type('VIEWER WAS HERE')
      await sleep(600)
      expect(await page.eval<string>(`document.querySelector('header').innerText`)).toMatch(/Can view/)
      await page.shot(`02-view-doc.${scheme}`)
      page.close()
    }
    expect(await plain()).toBe(before)
  }, 60_000)

  it('a comment link comments on selected words, and the service marks them', async () => {
    if (!(await plain()).includes('north doors')) await box.service.collab.writeMarkdown(DOC, 'owner', '# Morning\n\nCheck-in opens at the north doors.')
    const made = await link('comment', 'docs', 'Maya Chen')
    const page = await Page.open(box.debugPort)
    await page.go(made.url)
    await page.until('the text', `!!${EDITOR} && ${EDITOR}.innerText.includes('north doors')`)
    // Select "north doors" as a person would: a drag across the words.
    const r = await page.eval<{ x0: number; x1: number; y: number }>(`(() => { const w = document.createTreeWalker(${EDITOR}, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf('north doors'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 11); const b = r.getBoundingClientRect(); return { x0: b.left + 1, x1: b.right - 1, y: b.top + b.height / 2 } } } return null })()`)
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x0, y: r.y, button: 'left', clickCount: 1 })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (r.x0 + r.x1) / 2, y: r.y, button: 'left', buttons: 1 })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x1, y: r.y, button: 'left', buttons: 1 })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x1, y: r.y, button: 'left', clickCount: 1 })
    await sleep(300)
    await page.until('the Comment button', `[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Comment')`)
    await page.shot('03-comment-bar.light')
    await page.eval(`([...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Comment').click(), true)`)
    await page.until('the field', `!!document.querySelector('textarea')`)
    await page.type('Which doors are north? Put up a sign.')
    await page.shot('04-comment-field.light')
    await page.eval(`([...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Comment' && b.type === 'submit').click(), true)`)
    await until(() => box.convex.threads.some((t) => t.author?.startsWith('guest:') && t.quote === 'north doors'), 10_000)
    const t = box.convex.threads.find((x) => x.quote === 'north doors')!
    expect(JSON.parse(t.body)[0].content[0].text).toBe('Which doors are north? Put up a sign.')
    await page.until('the thread shown', `document.body.innerText.includes('Which doors are north')`)
    await page.shot('05-commented.light')
    page.close()
  }, 60_000)

  it('revoked with the page open, the page shows the end; an expired or wrong secret opens nothing', async () => {
    const made = await link('edit', 'docs', 'Tom Reyes')
    const page = await Page.open(box.debugPort)
    await page.go(made.url)
    await page.until('the editor', `!!${EDITOR} && ${EDITOR}.isContentEditable`)
    const at = Date.now()
    await box.rt.revoke(made.link.id)
    await page.until('the end', `document.body.innerText.includes('This link no longer opens anything')`, 10_000)
    console.log(`[proof] revoked → the page said so in ${Date.now() - at} ms`)
    await page.shot('06-revoked.light')
    const wrong = made.url.replace(/#k=.*/, '#k=' + 'A'.repeat(43))
    const fresh = await link('view', 'docs', 'Jess Park')
    await page.go(fresh.url.replace(/#k=.*/, '#k=' + 'A'.repeat(43)))
    await page.until('refused', `document.body.innerText.includes('This link no longer opens anything')`)
    await page.go(wrong, 'dark')
    await page.until('refused', `document.body.innerText.includes('This link no longer opens anything')`)
    await page.shot('07-wrong-secret.dark')
    page.close()
  }, 60_000)

  it('an edit link edits a sheet live with the owner; a view link on it writes nothing', async () => {
    const made = await link('edit', 'sheets')
    const page = await Page.open(box.debugPort)
    await page.go(made.url)
    await page.until('the grid', `!!document.querySelector('canvas')`, 30_000)
    await sleep(2500)
    await page.shot('08a-sheet-open.light')
    // The owner on the same sheet's socket.
    const token = (await box.signer.sign({ sheet: SHEET, role: 'edit', principal: 'owner' }, 600)).token
    const ws = new WebSocket(`ws://127.0.0.1:${box.service.port}/w/sheet/${SHEET}`)
    const heard: { t: string; by?: string; mutations?: unknown; rev?: number; snapshot?: { id?: string; sheetOrder?: string[] } }[] = []
    ws.onmessage = (e) => heard.push(JSON.parse(String(e.data)))
    await new Promise((r) => (ws.onopen = r))
    ws.send(JSON.stringify({ t: 'hello', token }))
    await until(() => heard.some((m) => m.t === 'state'))
    const raw = heard.find((m) => m.t === 'state')!
    const state = { ...raw, snapshot: typeof raw.snapshot === 'string' ? (JSON.parse(raw.snapshot) as { id?: string; sheetOrder?: string[] }) : raw.snapshot }
    // The guest types into a cell (B3), as a person: click, type, Enter.
    const box1 = await page.eval<{ x: number; y: number; w: number; h: number }>(`(() => { const c = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0].getBoundingClientRect(); return { x: c.x, y: c.y, w: c.width, h: c.height } })()`)
    await page.click(box1.x + 46 + 88 + 40, box1.y + 20 + 24 * 2 + 10)
    for (const ch of '412') await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Digit${ch}`, text: ch, windowsVirtualKeyCode: ch.charCodeAt(0) }).then(() => page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Digit${ch}`, windowsVirtualKeyCode: ch.charCodeAt(0) }))
    await sleep(200)
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await sleep(800)
    await page.shot('08b-sheet-typed.light')
    await until(() => heard.some((m) => m.t === 'ops' && m.by === `guest:${made.link.id}` && JSON.stringify(m.mutations).includes('412')), 15_000).catch((err) => {
      console.log('[proof] heard', JSON.stringify(heard.filter((m) => m.t !== 'state')).slice(0, 800), page.logs.slice(-5).join(' | '))
      throw err
    })
    console.log('[proof] the owner heard the guest\'s cell')
    // The owner writes a cell; the guest's grid takes it (seen in the shot).
    const unit = state.snapshot!.id!
    const sub = state.snapshot!.sheetOrder![0]!
    const rev = Math.max(...heard.filter((m) => typeof m.rev === 'number').map((m) => m.rev!))
    ws.send(JSON.stringify({ t: 'ops', id: 1, baseRev: rev, mutations: [{ id: 'sheet.mutation.set-range-values', params: { unitId: unit, subUnitId: sub, cellValue: { 0: { 0: { v: 'From the owner' } } } } }] }))
    await until(() => heard.some((m) => m.t === 'ack'))
    await sleep(800)
    await page.shot('08-edit-sheet.light')
    const ops = box.convex.sheets.get(SHEET)!.ops.length
    // A view link on the same sheet: the grid is read only, and an op sent by hand is refused.
    const view = await link('view', 'sheets', 'Priya Shah')
    const opened = (await (await fetch(`${box.base}/g/${view.link.id}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: new URL(view.url).hash.slice(3) }) })).json()) as { token: string }
    const vs = new WebSocket(`ws://127.0.0.1:${box.service.port}/g/ws/${view.link.id}`)
    const vheard: { t: string; reason?: string; rev?: number }[] = []
    vs.onmessage = (e) => vheard.push(JSON.parse(String(e.data)))
    await new Promise((r) => (vs.onopen = r))
    vs.send(JSON.stringify({ t: 'hello', token: opened.token }))
    await until(() => vheard.some((m) => m.t === 'state'))
    vs.send(JSON.stringify({ t: 'ops', id: 9, baseRev: vheard[0]!.rev, mutations: [{ id: 'sheet.mutation.set-range-values', params: { unitId: unit, subUnitId: sub, cellValue: { 0: { 0: { v: 'viewer' } } } } }] }))
    await until(() => vheard.some((m) => m.t === 'refused'))
    expect(vheard.find((m) => m.t === 'refused')!.reason).toMatch(/view, not edit/)
    expect(box.convex.sheets.get(SHEET)!.ops.length).toBe(ops)
    // Revoked: the guest's sheet socket closes within the route's second.
    const closed = new Promise<number>((r) => (vs.onclose = (e) => r(e.code)))
    const at = Date.now()
    await box.rt.revoke(view.link.id)
    expect(await closed).toBe(4403)
    console.log(`[proof] a revoked sheet socket closed in ${Date.now() - at} ms`)
    expect(Date.now() - at).toBeLessThan(1500)
    ws.close()
    page.close()
  }, 120_000)

  it("the owner's hosted editor opens once from a ticket", async () => {
    const { url } = await box.rt.ticket(source('docs', DOC), 'Spring LAN run of show', { kind: 'local', caps: [] })
    const page = await Page.open(box.debugPort)
    await page.go(url, 'dark')
    await page.until('the editor', `!!${EDITOR} && ${EDITOR}.isContentEditable`)
    expect(await page.eval<string>('location.hash')).toBe('')
    await page.shot('09-owner-open.dark')
    const again = await Page.open(box.debugPort)
    await again.go(url)
    await again.until('used', `document.body.innerText.includes('already been opened')`)
    await again.shot('10-ticket-used.light')
    page.close()
    again.close()
  }, 60_000)
})
