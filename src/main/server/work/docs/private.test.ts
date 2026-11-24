import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { request } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCollaborationClient, type CollaborationClient } from 'work-kit/collab'
import { createCollabSigner, fileDocName, generateCollabKeys, TEMPCODE_COLLAB_AUDIENCE, type CollabSigner } from 'work-kit/collab-server'
import * as Y from 'yjs'
import type { ClientRequest } from '@shared/contract'
import type { DocOpen } from '@shared/contract-work-docs'
import type { ExportAnswer, ImportAnswer, PreviewAnswer } from '@shared/contract-work-formats'
import type { Caller, ToolCtx, WorkCtx } from '../modules'
import { formats } from '../formats/index'
import { closeFilesState } from '../files/handle'
import { ensureFilesTables } from '../files/tables'
import { autosaveWords } from '../files/word'
import { setCloudDir } from '../office/files/library'
import { servicePaths } from '../service/config'
import { startFakeConvex, type FakeConvex } from '../service/fakeConvex'
import { startWorkService, type RunningService } from '../service/serve'
import type { ServiceConfig } from '../service/wire'
import { docs } from './index'
import { stopDocs } from './state'
import { madeFromShared } from './target'
import { docTools } from './tools'

/** A conversion job as `ctx.convert` takes and answers it. */
// The Word file of another computer, as the autosave reads and writes it (files/copies.ts): what is written there is kept.
const wordFile = vi.hoisted(() => ({ sent: [] as Buffer[] }))
vi.mock('../files/copies', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../files/copies')>()),
  freshBytes: async () => ({ data: Buffer.from('word bytes'), version: `v${wordFile.sent.length}` }),
  deliver: async (_ctx: unknown, _r: unknown, data: Buffer) => {
    wordFile.sent.push(data)
    return { version: `v${wordFile.sent.length}` }
  }
}))

type Job = { from: string; to: string; input: string; shared?: boolean; output: string }

/*
 * Agent suggestions stay private (docs/agents/work-docs.md, the owner's ruling of 2026-11-23):
 * a pending agent suggestion reaches nobody but the owner, in the live document a second
 * client syncs, in a .tcdoc's bytes on disk, or in any exported file, until he accepts it;
 * then it is an ordinary edit. A person's tracked change from Word still goes out as one.
 */

const SECRET = 'p'.repeat(43)
const CORPUS = join(dirname(createRequire(import.meta.url).resolve('work-kit/formats/docx')), 'corpus')
const SUGGESTED = 'Zanzibar budget review'
const open: { dirs: string[]; services: RunningService[]; convex: FakeConvex[]; ctxs: WorkCtx[]; clients: CollaborationClient[] } = { dirs: [], services: [], convex: [], ctxs: [], clients: [] }

afterEach(async () => {
  setCloudDir(() => join(homedir(), 'Library', 'CloudStorage'))
  await Promise.all(open.clients.splice(0).map((c) => c.destroy()))
  for (const ctx of open.ctxs.splice(0)) {
    stopDocs(ctx)
    closeFilesState(ctx.db)
  }
  wordFile.sent.length = 0
  await Promise.all(open.services.splice(0).map((s) => s.stop().catch(() => {})))
  await Promise.all(open.convex.splice(0).map((c) => c.close()))
  for (const d of open.dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const until = async (what: string, ok: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function post(socketPath: string, path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { error?: string }
        if ((res.statusCode ?? 500) >= 400) reject(new Error(parsed.error ?? `HTTP ${res.statusCode}`))
        else resolve(parsed)
      })
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

const md = (...lines: string[]) => lines.join('\n\n')
const BEFORE = md('# Week 1', 'Meet the team at 9:00 AM', '# Week 2', 'Shadow the front desk')
const AFTER = md('# Week 1', 'Meet the team at 9:00 AM', `${SUGGESTED} with finance`, '# Week 2', 'Shadow the front desk')

/** Every entry of a zip, as text: what anyone who opens the file can read. */
const zipText = (path: string): Record<string, string> => Object.fromEntries(Object.entries(unzipSync(new Uint8Array(readFileSync(path)))).map(([k, v]) => [k, Buffer.from(v).toString('latin1')]))
const docxXml = (data: string | Uint8Array): string => strFromU8(unzipSync(typeof data === 'string' ? new Uint8Array(Buffer.from(data, 'base64')) : data)['word/document.xml']!)

async function rig(o: { ownerSaid?: string[]; routineRunId?: string } = {}) {
  // His messages in the thread; a test adds one once it knows the document's path.
  const said = [...(o.ownerSaid ?? [])]
  const dir = mkdtempSync(join(tmpdir(), 'doc-private-'))
  open.dirs.push(dir)
  const convex = await startFakeConvex()
  open.convex.push(convex)
  mkdirSync(join(dir, 'data'), { recursive: true })
  // A OneDrive library on this host: whatever lies under it others can open (files/policy.ts sharedOf).
  const cloud = join(dir, 'CloudStorage')
  const library = join(cloud, 'OneDrive-SharedLibraries-Purdue', 'RecWell - Documents')
  mkdirSync(library, { recursive: true })
  setCloudDir(() => cloud)
  const work = join(dir, 'Work')
  mkdirSync(work, { recursive: true })
  const keys = await generateCollabKeys('k')
  const signer: CollabSigner = await createCollabSigner({ privateJwk: keys.privateJwk, iss: 'tempcode:env_box' })
  const config: ServiceConfig = {
    port: 0,
    socketPath: servicePaths(join(dir, 'data')).socketPath,
    secret: SECRET,
    dataDir: join(dir, 'data', 'work-service'),
    hostedDir: join(dir, 'hosted'),
    host: 'env_box',
    lifeos: { here: true, url: convex.url },
    trusted: [{ by: 'host', iss: 'tempcode:env_box', aud: TEMPCODE_COLLAB_AUDIENCE, keys: [keys.publicJwk] }],
    links: []
  }
  const service = await startWorkService(config, { jwt: async () => 'owner-jwt', log: () => {} })
  open.services.push(service)
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, kind TEXT, sector TEXT)')
  db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run('t1', 'Northside PT kickoff')
  docs.ensure(db)
  const converted: Job[] = []
  const docxIn: Uint8Array[] = []
  const ctx = {
    db,
    host: 'env_box',
    dataDir: join(dir, 'data'),
    log: () => {},
    push: () => {},
    reaches: (by: Caller) => by.kind !== 'remote',
    canvas: {
      paneOf: (id: string) => id,
      get: (id: string) => (id === 'i0' ? { id: 'i0', sessionId: 't1', kind: 'document', source: null } : null),
      replace: () => ({ id: 'i9' }),
      onReplaced: () => () => {},
      forSession: () => []
    },
    threads: { ownerSaid: (_: string, quote: string, about?: readonly string[]) => said.some((words) => words.includes(quote) && (!about || about.some((name) => words.toLowerCase().includes(name.toLowerCase())))) },
    lifeos: { connected: () => false, owner: () => ({ query: async () => null, mutation: async () => null }) },
    service: { internal: (route: string, body: unknown) => post(config.socketPath, route, body), url: (route: string) => `ws://127.0.0.1:${service.port}${route}` },
    // LibreOffice stands in: every Word file handed to it is kept, and it hands back bytes of its own.
    async convert(job: Omit<Job, 'output'>) {
      if (job.from === 'docx') docxIn.push(new Uint8Array(readFileSync(job.input)))
      const output = `${job.input}.${job.to}`
      writeFileSync(output, job.to === 'pdf' ? '%PDF-1.7\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n' : `converted ${job.to}`)
      converted.push({ ...job, output })
      return { output, ranOn: 'env_box', warnings: [] }
    }
  } as unknown as WorkCtx
  open.ctxs.push(ctx)
  const toolCtx = { ...ctx, sessionId: 't1', signal: new AbortController().signal, scope: { shared: () => false, routineRunId: o.routineRunId ?? null, sector: null } } as unknown as ToolCtx
  const tool = async (name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean }> => {
    // A rewrite is written over the text the agent read: these tests read just before, as an agent does.
    if (name === 'doc_write' && !('revision' in args)) {
      const { item, doc, file } = args as { item?: string; doc?: string; file?: string }
      const read = await tool('doc_read', { ...(item ? { item } : {}), ...(doc ? { doc } : {}), ...(file ? { file } : {}) })
      args = { ...args, revision: /Revision (r[0-9a-f]+)/.exec(read.text)?.[1] }
    }
    const t = docTools.find((x) => x.name === name)!
    const got = await t.run(t.input.parse(args), toolCtx)
    return { text: (got.content[0] as { text: string }).text, error: got.isError === true }
  }
  const ask = async <T,>(module: 'docs' | 'formats', method: string, params: unknown): Promise<T> => {
    const done = await (module === 'docs' ? docs : formats).handle!({ id: '1', method, params } as ClientRequest, ctx, { kind: 'local', caps: [] })
    if (!done.handled) throw new Error('not handled')
    return done.result as T
  }
  const call = <T,>(route: string, body: unknown) => post(config.socketPath, route, body) as Promise<T>
  /** A .tcdoc with the week's plan, at `path`, stored on disk. */
  const make = async (path: string) => {
    await service.collab.writeMarkdown(fileDocName(path), 'owner', BEFORE, { path })
    await service.collab.flush()
    return { at: 'file', host: 'env_box', path } as const
  }
  const text = async (path: string) => (await service.collab.read(fileDocName(path), { path })).markdown
  const branches = async (path: string) => (await call<{ branches: { id: string; authors: string[]; diff: { rows: unknown[] } }[] }>('/internal/history/branches', { file: path, fence: { sectors: 'all' } })).branches
  /** A second window's client on the live document, as the owner: what it syncs is the shared state. */
  const second = async (path: string) => {
    const name = fileDocName(path)
    const token = (await signer.sign({ doc: name, role: 'edit', principal: 'owner', file: { path } }, 300)).token
    const client = createCollaborationClient({ documentName: name, token, url: `ws://127.0.0.1:${service.port}/w/doc/${name}`, offline: false })
    open.clients.push(client)
    await until('the second client synced', () => client.provider.isSynced)
    return client
  }
  const privateDir = join(config.dataDir, 'private-branches')
  return { dir, work, library, db, ctx, tool, ask, call, make, text, branches, second, service, converted, docxIn, privateDir, said }
}

const stateText = (c: CollaborationClient) => Buffer.from(Y.encodeStateAsUpdate(c.document)).toString('latin1')

describe('a .tcdoc others can open', () => {
  it('is shared to the window and the tools: an agent\'s own idea there waits as a suggestion instead of going into the synced file', async () => {
    const r = await rig()
    const source = await r.make(join(r.library, 'Run of show.tcdoc'))
    expect(await r.ask<DocOpen>('docs', 'work.docs.open', { source })).toMatchObject({ shared: true, mode: 'suggests' })
    const said = await r.tool('doc_write', { file: source.path, markdown: AFTER, because: 'own' })
    expect(said.error).toBe(false)
    expect(said.text).toMatch(/others share this document/)
    expect(await r.text(source.path)).not.toContain(SUGGESTED)
  })

  it('holds nothing of a pending agent suggestion in its bytes, a second client syncs none of it, and the owner still sees and accepts it as an ordinary edit', async () => {
    const r = await rig()
    const { path } = await r.make(join(r.library, 'Run of show.tcdoc'))
    await r.tool('doc_suggest', { file: path, markdown: AFTER })
    await r.service.collab.flush()
    // The file: no branch of the agent's, none of its words, in any entry.
    const entries = zipText(path)
    expect(JSON.parse(entries['branches/index.json'] ?? '[]')).toEqual([])
    expect(Object.keys(entries).filter((k) => k.startsWith('branches/') && k !== 'branches/index.json')).toEqual([])
    for (const [name, body] of Object.entries(entries)) expect(body, name).not.toContain(SUGGESTED)
    // Another window on the live document syncs nothing of it.
    const other = await r.second(path)
    expect(stateText(other)).toContain('Shadow the front desk')
    expect(stateText(other)).not.toContain(SUGGESTED)
    // The owner's own window: the suggestion, kept on this host.
    const [b] = await r.branches(path)
    expect(b).toMatchObject({ authors: ['agent:env_box:t1'] })
    expect(b!.diff.rows.length).toBe(1)
    expect(readdirSync(r.privateDir)).toHaveLength(1)
    // Accept: an ordinary edit in the file, and nothing left aside.
    await r.call('/internal/history/decide', { file: path, branchId: b!.id, which: 'all', accept: true, fence: { sectors: 'all' } })
    expect(await r.text(path)).toContain(SUGGESTED)
    await r.service.collab.flush()
    expect(Object.values(zipText(path)).some((body) => body.includes(SUGGESTED))).toBe(true)
    await until('the second client has the accepted words', () => stateText(other).includes(SUGGESTED))
    expect(await r.branches(path)).toEqual([])
    expect(readdirSync(r.privateDir)).toEqual([])
  })

  it('a rejected suggestion leaves nothing anywhere', async () => {
    const r = await rig()
    const { path } = await r.make(join(r.library, 'Run of show.tcdoc'))
    await r.tool('doc_suggest', { file: path, markdown: AFTER })
    const [b] = await r.branches(path)
    await r.call('/internal/history/decide', { file: path, branchId: b!.id, which: 'all', accept: false, fence: { sectors: 'all' } })
    await r.service.collab.flush()
    expect(await r.text(path)).not.toContain(SUGGESTED)
    for (const body of Object.values(zipText(path))) expect(body).not.toContain(SUGGESTED)
    expect(readdirSync(r.privateDir)).toEqual([])
  })

  it('asked in his own words, the change is written at once', async () => {
    const r = await rig()
    const { path } = await r.make(join(r.library, 'Run of show.tcdoc'))
    r.said.push(`About this selection: “Week 1”, Run of show (${path})\n\nAdd a line: ${SUGGESTED} with finance`)
    const said = await r.tool('doc_write', { file: path, markdown: AFTER, because: 'asked', quote: `${SUGGESTED} with finance` })
    expect(said).toEqual({ text: 'Wrote 1 section.', error: false })
    expect(await r.text(path)).toContain(SUGGESTED)
    expect(await r.branches(path)).toEqual([])
  })

  it('a routine writes at once only where nobody else reads: on his own document it writes, here it suggests', async () => {
    const r = await rig({ routineRunId: 'run1' })
    const mine = await r.make(join(r.work, 'Mine.tcdoc'))
    expect((await r.tool('doc_write', { file: mine.path, markdown: AFTER, because: 'routine' })).text).toBe('Wrote 1 section.')
    expect(await r.text(mine.path)).toContain(SUGGESTED)
    const shared = await r.make(join(r.library, 'Run of show.tcdoc'))
    const said = await r.tool('doc_write', { file: shared.path, markdown: AFTER, because: 'routine' })
    expect(said.text).toMatch(/A routine writes to what others share only under a grant/)
    expect(await r.text(shared.path)).not.toContain(SUGGESTED)
    expect(await r.branches(shared.path)).toHaveLength(1)
  })
})

describe("the document kept for a Word file of another computer", () => {
  /** A Teams Word file opened in a Files tab: its document in the workspace's own folder, the record naming it (files/word.ts), saved by itself. */
  async function kept(r: Awaited<ReturnType<typeof rig>>) {
    ensureFilesTables(r.db)
    r.db.prepare(`INSERT INTO workspaces (id, name, path, kind, sector) VALUES ('ws1', 'RecWell', ?, 'work', 'purdue')`).run(r.work)
    const source = await r.make(join(r.work, 'Plan.tcdoc'))
    r.db
      .prepare(`INSERT INTO work_files_word (workspace_id, host, path, vm, name, version, sha, doc, doc_at, saved_at, saved_doc_at, at, auto) VALUES ('ws1', 'env_mac', '/Teams/General/Plan.docx', 0, 'Plan.docx', 'v0', 'sha', ?, ?, NULL, NULL, ?, 1)`)
      .run(source.path, Math.round(statSync(source.path).mtimeMs), Date.now())
    return source
  }
  /** The autosave, run as if the document had been still for its pause: it sees the live revision, then a pause later saves. */
  let clock = Date.now()
  const autosave = async (r: Awaited<ReturnType<typeof rig>>) => {
    await r.service.collab.flush()
    clock += 60_000
    await autosaveWords(r.ctx, clock)
    await autosaveWords(r.ctx, clock + 10_000)
  }
  const sentText = (): string[] => wordFile.sent.map((data) => docxXml(new Uint8Array(data)))

  it('is shared to the window and the tools, though it lies in his own folder', async () => {
    const r = await rig()
    const source = await kept(r)
    expect(await r.ask<DocOpen>('docs', 'work.docs.open', { source })).toMatchObject({ shared: true, mode: 'suggests' })
    expect((await r.tool('doc_comment', { file: source.path, quote: 'Shadow the front desk', body: 'Why?' })).error).toBe(true)
    // By its real path: a link to the folder names the same document; another document there is his own.
    symlinkSync(r.work, join(r.dir, 'Work link'))
    expect(madeFromShared(r.ctx, { at: 'file', host: 'env_box', path: join(r.dir, 'Work link', 'Plan.tcdoc') })).toBe(true)
    expect(madeFromShared(r.ctx, { at: 'file', host: 'env_box', path: join(r.work, 'Mine.tcdoc') })).toBe(false)
  })

  it("an agent's own write and format wait as suggestions, the autosave carries none of them, and only his accept reaches the Word file", async () => {
    const r = await rig()
    const source = await kept(r)
    const wrote = await r.tool('doc_write', { file: source.path, markdown: AFTER, because: 'own' })
    expect(wrote.text).toMatch(/others share this document/)
    const formatted = await r.tool('doc_format', { file: source.path, on: { quote: 'Shadow the front desk' }, run: { bold: true }, because: 'own' })
    expect(formatted.text).toMatch(/^Suggested formatting/)
    expect(await r.text(source.path)).not.toContain(SUGGESTED)
    await autosave(r)
    // His own edit goes by itself; what the agent suggested stays out of it.
    await r.service.collab.writeMarkdown(fileDocName(source.path), 'owner', md(BEFORE, 'Bring the keys'), { path: source.path })
    await autosave(r)
    expect(sentText().some((xml) => xml.includes('Bring the keys'))).toBe(true)
    for (const xml of sentText()) expect(xml).not.toContain(SUGGESTED)
    // His accept is his own edit: the next autosave carries it.
    const b = (await r.branches(source.path)).find((x) => x.diff.rows.length && x.authors[0] === 'agent:env_box:t1')!
    await r.call('/internal/history/decide', { file: source.path, branchId: b.id, which: 'all', accept: true, fence: { sectors: 'all' } })
    await autosave(r)
    expect(sentText().at(-1)).toContain(SUGGESTED)
  })
})

describe("a document's live revision", () => {
  it('moves with a deletion alone, as with any edit, and stands still while nothing changes', async () => {
    const r = await rig()
    const { path } = await r.make(join(r.work, 'Plan.tcdoc'))
    const rev = async () => (await r.call<{ rev: string }>('/internal/docs/rev', { file: path, shared: false, fence: { sectors: 'all' } })).rev
    const at = await rev()
    expect(await rev()).toBe(at)
    const other = await r.second(path)
    // The last letter of a line taken out, nothing typed: no client's clock moves, only the delete set.
    const [first] = [...other.document.getXmlFragment('document-store').createTreeWalker((n) => n instanceof Y.XmlText)] as Y.XmlText[]
    first!.delete(first!.length - 1, 1)
    const deadline = Date.now() + 3000
    let after = await rev()
    while (after === at && Date.now() < deadline) after = (await new Promise((r2) => setTimeout(r2, 20)), await rev())
    expect(after).not.toBe(at)
  })
})

describe("a document's file before its tab closes", () => {
  it('holds what a window just typed once the host is asked to store it, though the service stores on a pause', async () => {
    const r = await rig()
    const { path } = await r.make(join(r.work, 'Plan.tcdoc'))
    const before = statSync(path).mtimeMs
    const other = await r.second(path)
    // His keystrokes in that window: words into the first line's text.
    const [first] = [...other.document.getXmlFragment('document-store').createTreeWalker((n) => n instanceof Y.XmlText)] as Y.XmlText[]
    first!.insert(0, 'Bring the keys ')
    // The service stores a second after the last change: the file does not have it yet.
    expect(Object.values(zipText(path)).some((body) => body.includes('Bring the keys'))).toBe(false)
    await r.call('/internal/docs/stored', { name: fileDocName(path), fence: { sectors: 'all' } })
    expect(statSync(path).mtimeMs).toBeGreaterThan(before)
    expect(await r.text(path)).toContain('Bring the keys')
    // A bot key is never let in.
    await expect(r.call('/internal/docs/stored', { name: fileDocName(path), fence: { sectors: 'all', botId: 'b1' } })).rejects.toThrow(/main's/)
  })

  it('says a store that failed: the close is never told the file holds what it does not', async () => {
    const r = await rig()
    const folder = join(r.work, 'Locked')
    mkdirSync(folder)
    const { path } = await r.make(join(folder, 'Plan.tcdoc'))
    const other = await r.second(path)
    const [first] = [...other.document.getXmlFragment('document-store').createTreeWalker((n) => n instanceof Y.XmlText)] as Y.XmlText[]
    // The folder takes no new file: the store's write fails.
    chmodSync(folder, 0o500)
    try {
      first!.insert(0, 'Bring the keys ')
      await expect(r.call('/internal/docs/stored', { name: fileDocName(path), fence: { sectors: 'all' } })).rejects.toThrow(/not stored/)
    } finally {
      chmodSync(folder, 0o700)
    }
    // Once it can, the same ask stores it and says so.
    await r.call('/internal/docs/stored', { name: fileDocName(path), fence: { sectors: 'all' } })
    expect(Object.values(zipText(path)).some((body) => body.includes('Bring the keys'))).toBe(true)
  })
})

describe('an exported file', () => {
  it('carries no pending agent suggestion in Word, OpenDocument, Rich Text, Markdown or the preview, and says how many stayed out', async () => {
    const r = await rig()
    const source = await r.make(join(r.work, 'Plan.tcdoc'))
    await r.tool('doc_suggest', { file: source.path, markdown: AFTER })
    expect(await r.branches(source.path)).toHaveLength(1)

    const word = await r.ask<ExportAnswer>('formats', 'work.formats.export', { source, format: 'docx' })
    const xml = docxXml(word.data)
    expect(xml).toContain('Shadow the front desk')
    expect(xml).not.toContain(SUGGESTED)
    expect(xml).not.toMatch(/<w:(ins|del)\b/)
    expect(word.heldSuggestions).toBe(1)

    for (const format of ['odt', 'rtf'] as const) {
      const before = r.docxIn.length
      const out = await r.ask<ExportAnswer>('formats', 'work.formats.export', { source, format })
      expect(out.heldSuggestions, format).toBe(1)
      const handed = r.docxIn.slice(before)
      expect(handed, format).toHaveLength(1)
      expect(docxXml(handed[0]!), format).not.toContain(SUGGESTED)
      expect(docxXml(handed[0]!), format).not.toMatch(/<w:(ins|del)\b/)
    }

    const text = await r.ask<ExportAnswer>('formats', 'work.formats.export', { source, format: 'md' })
    expect(Buffer.from(text.data, 'base64').toString('utf8')).not.toContain(SUGGESTED)

    const before = r.docxIn.length
    const preview = await r.ask<PreviewAnswer>('formats', 'work.formats.preview', { source, format: 'docx' })
    expect(preview.heldSuggestions).toBe(1)
    expect(r.docxIn.slice(before).map((d) => docxXml(d).includes(SUGGESTED))).toEqual([false])
    // Drawn again from the render the host keeps: still counted.
    expect((await r.ask<PreviewAnswer>('formats', 'work.formats.preview', { source, format: 'docx' })).heldSuggestions).toBe(1)

    // Accepted, it is the document's own words and goes out as such.
    const [b] = await r.branches(source.path)
    await r.call('/internal/history/decide', { file: source.path, branchId: b!.id, which: 'all', accept: true, fence: { sectors: 'all' } })
    const after = await r.ask<ExportAnswer>('formats', 'work.formats.export', { source, format: 'docx' })
    expect(docxXml(after.data)).toContain(SUGGESTED)
    expect(after.heldSuggestions).toBeUndefined()
  })

  it("a person's tracked change from an imported Word file still goes as a tracked change; the agent's beside it stays out", async () => {
    const r = await rig()
    const original = join(r.work, 'review.docx')
    copyFileSync(join(CORPUS, 'review.docx'), original)
    const got = await r.ask<ImportAnswer>('formats', 'work.formats.import', { from: { at: 'source', source: { at: 'file', host: 'env_box', path: original } } })
    const path = (got.source as { path: string }).path
    const live = await r.text(path)
    await r.tool('doc_suggest', { file: path, markdown: `${live}\n\n${SUGGESTED}` })
    expect((await r.branches(path)).map((b) => b.authors[0]).sort()).toEqual(['agent:env_box:t1', 'external:Ada Reviewer', 'external:Ben Editor'])
    const out = await r.ask<ExportAnswer>('formats', 'work.formats.export', { source: got.source, format: 'docx' })
    const xml = docxXml(out.data)
    expect(xml).not.toContain(SUGGESTED)
    expect(xml).toMatch(/<w:(ins|del)\b[^>]*w:author="Ada Reviewer"/)
    expect(xml).toMatch(/<w:(ins|del)\b[^>]*w:author="Ben Editor"/)
    expect(xml).not.toMatch(/w:author="(Northside PT kickoff|Agent|An agent)"/)
    expect(out.heldSuggestions).toBe(1)
    // The people's branches stay in the file; the agent's is kept aside.
    await r.service.collab.flush()
    const index = JSON.parse(zipText(path)['branches/index.json'] ?? '[]') as { authors: string[] }[]
    expect(index.map((b) => b.authors[0]).sort()).toEqual(['external:Ada Reviewer', 'external:Ben Editor'])
    expect(existsSync(r.privateDir)).toBe(true)
  })
})
