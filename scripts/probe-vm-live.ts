/**
 * An agent's office tools on a live file, run by TempCode's own tool routing in this process against the STANDING
 * Windows VM's real helper (plan g6gWATXhCtN4 M7; docs/agents/work-office-live.md "Agents in a live file"). A dummy
 * only: "TempCode proof live <stamp>.docx" written into his own OneDrive's synced folder in the VM, named by its web
 * address (`liveAddress` from the mount's `UrlNamespace`), then, through the same `addinTools` a box thread gets with
 * no add-in on the file:
 *
 *  1. `office_doc_read` by the address: Word in the VM opens it by its address (`ms-word:ofe|u|…`) and the read
 *     returns its text, matched by Word's `FullName` through `cloudKey`.
 *  2. `office_doc_edit` with `because: "own"`: a held `office.edit` naming the VM, and Word's text unchanged.
 *  3. The press (`office.edit`'s execute, as the Outbox runs it): `editDocument` in Word in the VM; a read by the
 *     address then holds the line, and OneDrive's synced copy in the VM catches up with it (Word saved it to the cloud).
 *  4. The dummy goes to the VM's Recycle Bin, and OneDrive takes it to his OneDrive's recycle bin.
 *
 * Not here: the plan's Chromium copy of the live page (it needs his Microsoft cookies copied from the box browser's
 * profile); step 3's synced copy stands for the cloud. Word keeps the deleted file's window open: the helper has no
 * verb that closes a document.
 *
 * The helper is reached through a forward of its own (`--socket`, made by the caller as the admin over the standing
 * machine's SSH: `ssh -N -L <sock>:127.0.0.1:47801 tcadmin@127.0.0.1 -p 22230`) with the box's token, so the box's
 * live service is not asked anything and the machine is never woken from here: run it only while the standing VM is
 * awake and answers SSH. Nothing signs in; Word in the VM must already be signed in for an edit.
 *
 *   bun scripts/proof-bun.ts scripts/probe-vm-live.ts --socket /tmp/tc-vm-probe.sock [--token-file <file>]
 */
import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { strFromU8, unzipSync } from 'fflate'
import type { TeamsLibrary } from '../src/shared/contract-work-office'
import type { HeldItem, WorkToolResult } from '../src/shared/work'
import type { ActCtx, ToolCtx, WorkCtx } from '../src/main/server/work/modules'
import { ensureSuggestionTables } from '../src/main/server/work/sheets/suggestions'
import { ensureExcelTables } from '../src/main/server/work/office/excel'
import { withAddin } from '../src/main/server/work/office/addin/carrier'
import { addinTools } from '../src/main/server/work/office/addin/index'
import { officeActs, OfficeEditSchema } from '../src/main/server/work/office/held'
import { liveAddress, sameCloudFile } from '../src/main/server/work/office/live/address'
import { BEHIND } from '../src/main/server/work/office/live/agents'
import type { HelperProcess } from '../src/main/server/work/office/com/carrier'
import { setVmHelperStart, stopVmOffice, vmHereOf } from '../src/main/server/work/office/vm/office'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const SOCKET = arg('--socket') ?? '/tmp/tc-vm-probe.sock'
const TOKEN = readFileSync(arg('--token-file') ?? '/srv/agents/temp-code-data/winvm/token', 'utf8').trim()
const REPO = join(import.meta.dir, '..')
let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One call to the helper, as office/vm/link.ts makes one: the token, its `ready`, one request, its answer. */
function helper(verb: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const s = connect(SOCKET)
    let buf = ''
    const timer = setTimeout(() => (s.destroy(), reject(new Error(`no answer to ${verb}`))), 120_000)
    s.on('connect', () => s.write(`${TOKEN}\n`))
    s.on('data', (d) => {
      buf += d
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const f = JSON.parse(line) as { event?: string; id?: number; ok?: boolean; value?: unknown; error?: { message?: string } }
        if (f.event === 'ready') s.write(JSON.stringify({ id: 1, verb, args }) + '\n')
        else if (f.id === 1) {
          clearTimeout(timer)
          s.destroy()
          if (f.ok) resolve(f.value)
          else reject(new Error(f.error?.message ?? 'the helper failed'))
        }
      }
    })
    s.on('error', (err) => (clearTimeout(timer), reject(err)))
  })
}

/** The carrier's helper over the same forward: one socket for its whole life, as vm/office.ts `start` makes it. */
setVmHelperStart(async () => {
  const s = connect(SOCKET)
  await new Promise<void>((resolve, reject) => (s.once('connect', resolve), s.once('error', reject)))
  s.write(`${TOKEN}\n`)
  return {
    stdin: s,
    stdout: s,
    kill: () => (s.destroy(), true),
    once: ((event: 'close' | 'error', fn: (arg: never) => void) => (event === 'close' ? s.once('close', () => (fn as (code: number | null) => void)(null)) : s.once('error', fn as (err: Error) => void))) as HelperProcess['once']
  }
})

const db = new DatabaseSync(':memory:')
ensureSuggestionTables(db)
ensureExcelTables(db)
const held: { kind: string; payload: unknown }[] = []
const ctx = {
  db,
  host: 'env_box',
  dataDir: '/nonexistent',
  log: (line: string) => console.log(`      log: ${line}`),
  held: { create: (act: { kind: string; payload: unknown }) => (held.push(act), { state: 'held', summary: `held ${act.kind}` } as HeldItem) },
  threads: { ownerSaid: () => false },
  // no desktop: the VM is the one place a live file's tool may go
  settings: { workspace: () => ({ mayUseDesktop: [] }) },
  peer: () => ({ call: async () => Promise.reject(new Error('the probe asks no other host')) }),
  scope: { workspaceId: 'probe' },
  sessionId: 'probe'
} as unknown as ToolCtx
const vm = vmHereOf(ctx as unknown as WorkCtx)
const box = withAddin(null, () => null)
const tools = addinTools(() => null, { offered: () => true, awake: async () => {}, here: () => vm }, { hub: () => null, synced: async () => null })
const tool = (name: string, args: unknown): Promise<WorkToolResult> => tools.find((t) => t.name === name)!.run(args, ctx)
const text = (r: WorkToolResult): string => r.content.map((c) => ('text' in c ? c.text : '')).join('')

/** The words of the synced copy in the VM, from its own bytes. */
async function syncedWords(path: string): Promise<string> {
  const got = (await helper('files.read', { path })) as { data: string }
  const xml = strFromU8(unzipSync(Buffer.from(got.data, 'base64'), { filter: (f) => f.name === 'word/document.xml' })['word/document.xml']!)
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join(' ')
}

const stamp = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${Math.random().toString(36).slice(2, 6)}`
const name = `TempCode proof live ${stamp}.docx`
const line = `TempCode proof live line ${stamp}`
let guest: string | null = null
try {
  const status = (await helper('guest.status')) as { mounts: { path: string; type: string; web: string | null }[] }
  const mine = status.mounts.find((m) => m.type === 'mine' && m.web)
  if (!mine) throw new Error('no OneDrive of his own in the VM with a web namespace')
  const library: TeamsLibrary = { id: 'env_box~mine', host: 'env_box', vm: true, path: mine.path, team: 'OneDrive', library: null, tenant: null, kind: 'mine', channels: [], web: mine.web, found: true }

  // The dummy, written where OneDrive uploads it; its address as a live tab names it.
  const blank = readFileSync(join(REPO, 'resources/work-files/blank/blank.docx'))
  await helper('files.write', { dir: mine.path, name, data: blank.toString('base64'), op: `probe-live-make-${stamp}` })
  guest = `${mine.path}\\${name}`
  const address = liveAddress(library, guest)
  if (!check('the dummy has a live address', address.ok, JSON.stringify(address))) throw new Error('no address')
  const url = (address as { url: string }).url

  // 1. Read by the address. OneDrive may take a while to upload a new file: a few tries.
  let read: WorkToolResult | null = null
  for (let i = 0; i < 6; i++) {
    read = await tool('office_doc_read', { document: url })
    if (!read.isError) break
    console.log(`      not yet: ${text(read)}`)
    await sleep(20_000)
  }
  const docs = await vm.carrier.documents()
  const open = docs.find((d) => /^https:/i.test(d.key) && sameCloudFile(d.key, url))
  check('Word in the VM opens the dummy by its address, keyed by its URL', !!open, JSON.stringify(docs.map((d) => d.key)))
  check('office_doc_read by the address answers its text live', !!read && !read.isError && !text(read).startsWith(BEHIND), read ? text(read).slice(0, 200) : '')

  // 2. An agent's own idea: held, Word untouched.
  const edit = await tool('office_doc_edit', { document: url, insert: line, at: 'end', because: 'own' })
  const payload = held[0] && OfficeEditSchema.safeParse(held[0].payload)
  check('office_doc_edit holds the change for his press, naming the VM and the URL Word has open', !!payload?.success && payload.data.vm === true && payload.data.key === open?.key, `${text(edit)} ${JSON.stringify(held[0]?.payload)}`)
  check('nothing reached Word before the press', !(await vm.carrier.readDocument(open!.key)).join('\n').includes(line))

  // 3. The press, as the Outbox runs it.
  const act = officeActs({ carrier: () => box, vm: async () => vm.carrier }).find((a) => a.kind === 'office.edit')!
  const done = await act.execute(payload!.data!, { host: 'env_box' } as ActCtx)
  check('the press runs editDocument in Word in the VM', /^Changed /.test((done as { summary: string }).summary), JSON.stringify(done))
  const after = await tool('office_doc_read', { document: url })
  check('a read by the address holds the line', text(after).includes(line), text(after).slice(0, 200))
  let synced = ''
  for (let i = 0; i < 12 && !synced.includes(line); i++) {
    await sleep(10_000)
    synced = await syncedWords(guest).catch((err) => `(${err})`)
  }
  check("OneDrive's synced copy in the VM catches up: Word saved it to the cloud", synced.includes(line), synced.slice(0, 200))
} catch (err) {
  check('the probe ran', false, String((err as Error).stack ?? err))
} finally {
  if (guest) await helper('files.recycle', { path: guest, op: `probe-live-recycle-${stamp}` }).then(() => console.log(`      ${guest} sent to the VM's Recycle Bin`), (err) => console.log(`      could not recycle ${guest}: ${err}`))
  stopVmOffice(ctx as unknown as WorkCtx)
  setVmHelperStart(null)
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
