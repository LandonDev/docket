/**
 * A Files tab's copy of a deck in the box's Windows VM, its save sent back, run by TempCode's own Files code in this
 * process against the STANDING machine's real helper (.temp-code/plans/landed/F-edits-lost.md). Dummy files only:
 * one deck named "TempCode proof deck …" made in his own OneDrive there, named in place, opened as a copy in a Files
 * tab, the copy's bytes changed as the deck's own replace leaves them, then sent as the window asks; the guest's file
 * read back by the helper; the tab closed; the deck sent to the VM's Recycle Bin at the end.
 *
 * The helper is reached through a forward of its own (`--socket`, made by the caller as the admin over the standing
 * machine's SSH: `ssh -N -L <sock>:127.0.0.1:47801 tcadmin@127.0.0.1 -p 22230`) with the box's token, so the box's
 * live service is not asked anything. The VM's status is the helper's own `guest.status`.
 *
 *   bun scripts/proof-bun.ts scripts/probe-vm-copy.ts --socket /tmp/tc-vm-probe.sock [--token-file <file>]
 */
import { connect } from 'node:net'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CopyBack, FilesOpened, FilesTabs, FileDone } from '../src/shared/contract-work-files'
import { canvasSourcePath } from '../src/shared/work'
import { setCopyAllowed } from '../src/main/server/work/office/files/library'
import { setVmCall } from '../src/main/server/work/office/vm/link'
import { setVmState } from '../src/main/server/work/office/vm/office'
import { copiesInFlight, copyRecord, copySaved, copyTiming } from '../src/main/server/work/files/copies'
import { closeFilesState, filesHandle } from '../src/main/server/work/files/handle'
import { registerFileMaker } from '../src/main/server/work/files/hooks'
import { forgetVmLists } from '../src/main/server/work/files/places/teams'
import { fileWritten, onFileSaved } from '../src/main/server/work/files/save'
import { approver, HOST, makeRig, window, WS } from '../src/main/server/work/files/testkit'

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

const rig = makeRig()
copyTiming.grace = 0
const status = (await helper('guest.status')) as { mounts: { path: string; type: string }[]; verbs?: string[] }
const mine = status.mounts.find((m) => m.type === 'mine')
if (!mine) throw new Error('no OneDrive of his own in the VM')
rig.db.prepare(`INSERT OR REPLACE INTO work_office_files (key, value) VALUES ('vm:status', ?)`).run(JSON.stringify({ at: Date.now(), status, tops: {} }))
setVmState(() => ({ state: 'awake', cannot: null }) as never)
setVmCall((verb, args) => helper(verb, (args ?? {}) as Record<string, unknown>))
setCopyAllowed(rig.db, WS, true)
forgetVmLists()
const deckBytes = readFileSync(join(REPO, 'src/main/server/work/slides/fixtures/kinds.pptx'))
registerFileMaker('slides', { forms: ['pptx'], async blank(target) { writeFileSync(target.path, deckBytes, { flag: 'wx', mode: 0o600 }) } })
const offSaved = onFileSaved((path) => copySaved(rig.ctx, path))
const call = async <T>(method: string, params: Record<string, unknown>, by = window): Promise<T> => {
  const out = await filesHandle({ id: '1', method, params: { workspaceId: WS, ...params } } as never, rig.ctx, by)
  if (!out || !(out as { handled?: boolean }).handled) throw new Error(`${method} not answered`)
  return (out as { result: T }).result
}
const settled = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.all(copiesInFlight())
}
const versionOf = async (path: string): Promise<{ size: number; version: string }> => {
  const got = (await helper('files.read', { path, offset: 0, length: 1, version: true })) as { size: number; version: string }
  return { size: got.size, version: got.version }
}

const stamp = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${Math.random().toString(36).slice(2, 6)}`
let guest: string | null = null
try {
  // New → Deck in the place, as his press makes it, then named in place.
  const made = await call<FileDone>('work.files.make', { at: { at: 'file', host: HOST, path: mine.path }, kind: 'deck', name: `TempCode proof deck ${stamp}`, op: `probe-make-${stamp}` })
  const entry = made.entries[0]
  check('a deck is made in his OneDrive in the VM', !!entry, JSON.stringify(made).slice(0, 300))
  const first = (entry!.ref as { path: string }).path
  const renamed = await call<FileDone>('work.files.rename', { ref: entry!.ref, name: `TempCode proof deck ${stamp} named.pptx`, op: `probe-rename-${stamp}` })
  guest = (renamed.entries[0]!.ref as { path: string }).path
  check('and named in place', guest !== first, guest)
  const before = await versionOf(guest)

  // Opened from its row (this scratch host's fence holds a remote key to its own roots, so the window opens it; his
  // Mac's key asks the send below, as his Mac's window does).
  const opened = await call<FilesOpened>('work.files.open', { ref: renamed.entries[0]!.ref, name: renamed.entries[0]!.name, key: renamed.entries[0]!.key })
  const tab = opened.tabs.find((t) => t.id === opened.tabId)
  const copy = canvasSourcePath(opened.item!.source)!
  check("it opens in a Files tab as a copy that saves back", !!tab?.copyOf && tab.back?.is === "ok" && opened.item?.kind === "slides", JSON.stringify({ tab, item: opened.item }))
  check('the copy record names the guest file', copyRecord(rig.ctx, WS, HOST, guest)?.path === guest)

  // His edit as the deck writes it: new bytes put in the copy's place, then the deck's replace says so.
  const next = Buffer.concat([readFileSync(copy).subarray(0, -2), Buffer.from([0x05, 0x00])])
  writeFileSync(copy, next)
  fileWritten(copy)
  await settled()
  let after = await versionOf(guest)
  const tabs1 = await call<FilesTabs>('work.files.tabs', {})
  check("the host sends the deck's write to the guest's file, with no ask of the window", after.version !== before.version, `${before.version} → ${after.version}; ${JSON.stringify(tabs1.tabs.find((t) => t.id === opened.tabId)?.back)}`)
  // His window's ask, as the tab makes it once the deck says saved.
  writeFileSync(copy, Buffer.concat([next.subarray(0, -2), Buffer.from([0x06, 0x00])]))
  const back = await call<CopyBack>('work.files.copyBack', { tabId: opened.tabId }, approver)
  after = await versionOf(guest)
  check("his window's ask sends it too, and the tab says saved with the time", back.is === 'ok' && !!back.at && after.size === next.length, JSON.stringify(back))
  await call('work.files.tabClose', { tabId: opened.tabId }, approver)
  await new Promise((r) => setTimeout(r, 50))
  await settled()
  check('the tab closes with nothing waiting: the record goes', copyRecord(rig.ctx, WS, HOST, guest) === null)
} catch (err) {
  check('the probe ran', false, String((err as Error).stack ?? err))
} finally {
  if (guest) await helper('files.recycle', { path: guest, op: `probe-recycle-${stamp}` }).then(() => console.log(`      ${guest} sent to the VM's Recycle Bin`), (err) => console.log(`      could not recycle ${guest}: ${err}`))
  offSaved()
  closeFilesState(rig.db)
  rig.close()
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
