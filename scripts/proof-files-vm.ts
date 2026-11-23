/**
 * The Windows VM's file changes, proven in the RIG (docs/agents/work-teams-files.md "The Windows VM": the helper's
 * change verbs), never the standing machine: tc-office.exe as built by `native/tc-office-win/build-in-rig.sh f8`,
 * spoken to over the rig's SSH as tcuser, against a dummy folder the helper is told is a OneDrive mount the way
 * OneDrive itself says so (a row under HKCU\Software\SyncEngines\Providers\OneDrive). No OneDrive, no sign-in.
 *
 *   scripts/win-vm/up.sh && native/tc-office-win/build-in-rig.sh f8
 *   bun scripts/proof-bun.ts scripts/proof-files-vm.ts [dir]      (dir: where build-in-rig.sh left the helper; default f8)
 *
 * The last steps run TempCode's own Files code (in this process, on a scratch database and folder) against the
 * rig's helper, as the box runs it against its VM: a copy of a dummy file out of the dummy mount opened in a Files
 * tab, read with the helper's version; his change sent back by that version (the guest's file changes); a send after
 * the guest's file changed, answered as the conflict with the guest's file left as it was; and Keep Both, his bytes
 * beside it as "Roster (mine).xlsx" (docs/agents/work-files.md "A copy saves back"). These need `node:sqlite`, so
 * the proof runs under scripts/proof-bun.ts.
 *
 * Make a folder and a text file, rename, move, a write with a stale version (a conflict) and with the right one,
 * a file and a folder sent to the Recycle Bin and found there, a path outside the mount refused by the helper
 * itself (by name, through `..`, through a junction, a stream, a device name), a lost answer asked again by its
 * operation id (answered as the first did, done once), and a delete refused, the file left, where the bin is off. Exits 1 on the first step that does not hold.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'

const DIR = process.argv[2] ?? 'f8'
const VM = process.env.WINVM_DIR ?? '/srv/agents/win-vm'
const SSH = ['-i', join(VM, 'keys', 'id_ed25519'), '-p', process.env.WINVM_SSH_PORT ?? '22220', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-o', `UserKnownHostsFile=${join(VM, 'base', 'known_hosts')}`, 'tcuser@127.0.0.1']
const HOME = 'C:\\Users\\tcuser'
const MOUNT = `${HOME}\\Dummy U\\Esports Staff - General`
const OUTSIDE = `${HOME}\\Outside`
const RUN = Date.now().toString(36)

const log = (...a: unknown[]): void => console.log(`[proof ${new Date().toISOString().slice(11, 19)}]`, ...a)
function fail(what: string, got: unknown): never {
  console.error(`FAILED: ${what}\n${JSON.stringify(got, null, 2)}`)
  process.exit(1)
}
function ok(cond: boolean, what: string, got: unknown): void {
  if (!cond) fail(what, got)
  log(`ok: ${what}`)
}

/** PowerShell as tcuser in the rig, through the rig's own script (sent on stdin). */
function ps(script: string): string {
  const r = spawnSync(join(import.meta.dirname, 'win-vm', 'ssh.sh'), ['--ps', script], { encoding: 'utf8', timeout: 120_000 })
  if (r.status !== 0) fail(`PowerShell in the rig: ${script.slice(0, 80)}`, { status: r.status, stdout: r.stdout, stderr: r.stderr })
  return r.stdout.trim()
}

type Answer = { ok: boolean; value?: any; error?: { code: string; message: string } }

/** One helper over SSH: stdin and stdout, one JSON line each way (Git Bash's pipes between sshd and the helper, as rig.test.ts). */
class Helper {
  private p: ChildProcessWithoutNullStreams
  private buf = ''
  private id = 0
  private waiting = new Map<number, (a: Answer) => void>()
  readonly ready: Promise<void>
  constructor() {
    this.p = spawn('ssh', [...SSH, `"C:\\Program Files\\Git\\bin\\bash.exe" -c "cat | ./${DIR}/tc-office.exe | cat"`], { stdio: 'pipe' })
    let isReady: () => void
    this.ready = new Promise((r) => (isReady = r))
    this.p.stdout.setEncoding('utf8')
    this.p.stdout.on('data', (d: string) => {
      this.buf += d
      let nl: number
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (!line) continue
        const f = JSON.parse(line)
        if (f.event === 'ready') isReady()
        else if (typeof f.id === 'number') this.waiting.get(f.id)?.(f)
      }
    })
    this.p.stderr.on('data', (d) => process.stderr.write(`[helper] ${d}`))
  }
  /** Sends a request and never reads its answer: the answer is lost. */
  send(verb: string, args: Record<string, unknown>): void {
    this.p.stdin.write(JSON.stringify({ id: ++this.id, verb, args }) + '\n')
  }
  call(verb: string, args: Record<string, unknown> = {}): Promise<Answer> {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${verb} did not answer`)), 60_000)
      this.waiting.set(id, (a) => {
        clearTimeout(timer)
        resolve(a)
      })
      this.p.stdin.write(JSON.stringify({ id, verb, args }) + '\n')
    })
  }
  stop(): Promise<void> {
    return new Promise((r) => {
      this.p.once('close', () => r())
      this.p.stdin.end()
      setTimeout(() => this.p.kill(), 15_000)
    })
  }
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const op = (n: string): string => `proof-${RUN}-${n}`

async function main(): Promise<void> {
  log(`run ${RUN}: a dummy mount at ${MOUNT}`)
  // The dummy mount, as OneDrive names one: a provider row whose MountPoint is the folder. And a folder outside it.
  ps(
    [
      `$m = '${MOUNT}'; $o = '${OUTSIDE}'`,
      `if (Test-Path -LiteralPath $m) { Remove-Item -LiteralPath $m -Recurse -Force }`,
      `New-Item -ItemType Directory -Force -Path $m, $o | Out-Null`,
      `Set-Content -LiteralPath "$o\\secret.txt" -Value 'outside'`,
      `$k = 'HKCU:\\Software\\SyncEngines\\Providers\\OneDrive\\TcProofDummy'`,
      `New-Item -Path $k -Force | Out-Null`,
      `New-ItemProperty -Path $k -Name MountPoint -Value $m -Force | Out-Null`,
      `New-ItemProperty -Path $k -Name LibraryType -Value 'teamsite' -Force | Out-Null`,
      `New-ItemProperty -Path $k -Name UrlNamespace -Value 'https://dummyu.example.com/sites/EsportsStaff/Shared Documents/General' -Force | Out-Null`,
      // a junction inside the mount that leads out of it
      `cmd /c mklink /J "$m\\Way out" "$o" | Out-Null`
    ].join('\n')
  )

  let h = new Helper()
  await h.ready
  const status = await h.call('guest.status')
  ok(status.ok && Array.isArray(status.value.verbs) && ['files.mkdir', 'files.rename', 'files.move', 'files.write', 'files.recycle', 'files.outcome'].every((v) => status.value.verbs.includes(v)), 'guest.status lists the change verbs', status)
  ok(status.value.mounts.some((m: { path: string }) => m.path.toLowerCase() === MOUNT.toLowerCase()), 'the dummy folder is one of the mounts', status.value.mounts)

  // New: a folder and a text file
  const mk = await h.call('files.mkdir', { dir: MOUNT, name: 'Budgets', op: op('mkdir') })
  ok(mk.ok && mk.value.entry.dir === true && mk.value.entry.path === `${MOUNT}\\Budgets`, 'files.mkdir makes a folder', mk)
  const made = await h.call('files.write', { dir: `${MOUNT}\\Budgets`, name: 'notes.txt', data: b64('first'), op: op('new') })
  ok(made.ok && made.value.entry.size === 5, 'files.write {dir, name} makes a text file', made)
  const taken = await h.call('files.write', { dir: `${MOUNT}\\Budgets`, name: 'NOTES.txt', data: b64('x'), op: op('new-taken') })
  ok(!taken.ok && /already there/.test(taken.error!.message), 'a new file never lands on a taken name (case-blind)', taken)

  // Rename and move
  const rn = await h.call('files.rename', { path: `${MOUNT}\\Budgets\\notes.txt`, name: 'plan.txt', op: op('rename') })
  ok(rn.ok && rn.value.entry.name === 'plan.txt', 'files.rename', rn)
  await h.call('files.mkdir', { dir: MOUNT, name: 'Archive', op: op('mkdir-archive') })
  const mv = await h.call('files.move', { path: `${MOUNT}\\Budgets\\plan.txt`, dir: `${MOUNT}\\Archive`, op: op('move') })
  ok(mv.ok && mv.value.entry.path === `${MOUNT}\\Archive\\plan.txt`, 'files.move into another folder of the mount', mv)
  const PLAN = `${MOUNT}\\Archive\\plan.txt`

  // Write by version: stale refused as a conflict, right one replaces
  const read = await h.call('files.read', { path: PLAN, version: true })
  ok(read.ok && Buffer.from(read.value.data, 'base64').toString() === 'first' && /^5:\d+:[0-9a-f]{64}$/.test(read.value.version), 'files.read {version} answers the bytes and the version word', read)
  const stale = await h.call('files.write', { path: PLAN, data: b64('second'), expect: `5:1:${'0'.repeat(64)}`, op: op('write-stale') })
  ok(stale.ok && stale.value.conflict?.version === read.value.version, 'a write with a stale version is answered as a conflict', stale)
  const wrote = await h.call('files.write', { path: PLAN, data: b64('second'), expect: read.value.version, op: op('write') })
  ok(wrote.ok && /^6:\d+:[0-9a-f]{64}$/.test(wrote.value.version) && wrote.value.entry.size === 6, 'a write with the right version replaces the bytes', wrote)
  const back = await h.call('files.read', { path: PLAN })
  ok(Buffer.from(back.value.data, 'base64').toString() === 'second', 'the new bytes read back', back)
  const tmpLeft = ps(`(Get-ChildItem -LiteralPath '${MOUNT}\\Archive' -Force | Where-Object Name -like '*.tmp').Count`)
  ok(tmpLeft === '0', 'no staged file is left beside it', tmpLeft)

  // The fence, in the helper itself
  const outside = [
    ['files.mkdir', { dir: OUTSIDE, name: 'x', op: op('out-1') }, 'a folder outside every mount'],
    ['files.write', { dir: `${MOUNT}\\..\\..\\Outside`, name: 'x.txt', data: b64('x'), op: op('out-2') }, 'a path that climbs out with ..'],
    ['files.write', { dir: `${MOUNT}\\Way out`, name: 'x.txt', data: b64('x'), op: op('out-3') }, 'a junction inside the mount that leads out'],
    ['files.rename', { path: `${MOUNT}\\Way out\\secret.txt`, name: 'mine.txt', op: op('out-4') }, 'a file reached through that junction'],
    ['files.write', { path: `${MOUNT}\\Archive\\plan.txt:hidden`, data: b64('x'), expect: '', op: op('out-5') }, 'an alternate data stream'],
    ['files.mkdir', { dir: MOUNT, name: 'CON', op: op('out-6') }, 'a name Windows keeps for a device'],
    ['files.recycle', { path: `${OUTSIDE}\\secret.txt`, op: op('out-7') }, 'a delete outside every mount'],
    ['files.rename', { path: MOUNT, name: 'Elsewhere', op: op('out-8') }, 'the mount itself'],
    ['files.move', { path: `${MOUNT}\\Archive\\plan.txt`, dir: OUTSIDE, op: op('out-9') }, 'a move out of the mount'],
    ['files.mkdir', { dir: `${MOUNT.slice(0, 2)}/Users/tcuser/Outside`, name: 'x', op: op('out-10') }, 'the other separator']
  ] as const
  for (const [verb, args, what] of outside) {
    const r = await h.call(verb, args as Record<string, unknown>)
    ok(!r.ok && (r.error!.code === 'not-allowed' || r.error!.code === 'refused'), `refused by the helper: ${what} (${r.error?.message})`, r)
  }
  const secret = ps(`Get-Content -LiteralPath '${OUTSIDE}\\secret.txt'; (Get-ChildItem -LiteralPath '${OUTSIDE}' -Force).Count`)
  ok(secret === 'outside\n1' || secret === 'outside\r\n1', 'nothing outside the mount changed', secret)

  // A lost answer: the request goes, the connection closes before its answer is read; a new helper asked again by the
  // same id answers what the first did and does it once.
  h.send('files.mkdir', { dir: MOUNT, name: 'Lost answer', op: op('lost') })
  await h.stop()
  h = new Helper()
  await h.ready
  const outcome = await h.call('files.outcome', { op: op('lost') })
  ok(outcome.ok && outcome.value.state === 'done' && outcome.value.value.entry.name === 'Lost answer', 'files.outcome says what the lost change did', outcome)
  const again = await h.call('files.mkdir', { dir: MOUNT, name: 'Lost answer', op: op('lost') })
  ok(again.ok && again.value.entry.name === 'Lost answer', 'the same id again answers what the first did (a second mkdir would have been refused)', again)
  const reWrite = await h.call('files.write', { path: PLAN, data: b64('second'), expect: read.value.version, op: op('write') })
  ok(reWrite.ok && reWrite.value.version === wrote.value.version, 'a write retried by its id answers the first write, not a conflict', reWrite)
  const reNew = await h.call('files.write', { dir: `${MOUNT}\\Budgets`, name: 'notes.txt', data: b64('first'), op: op('new') })
  const budgets = ps(`(Get-ChildItem -LiteralPath '${MOUNT}\\Budgets' -Force).Count`)
  ok(reNew.ok && reNew.value.entry.name === 'notes.txt' && budgets === '0', 'a new file retried by its id after a rename is not made again', { reNew, budgets })
  const other = await h.call('files.mkdir', { dir: MOUNT, name: 'Another', op: op('lost') })
  ok(!other.ok && /another change/.test(other.error!.message), 'the same id for another change is refused', other)
  const unknown = await h.call('files.outcome', { op: op('never') })
  ok(unknown.ok && unknown.value.state === 'unknown', 'an id never seen is unknown', unknown)

  // The Recycle Bin: a file and a folder (with a file in it), found there afterwards
  await h.call('files.write', { dir: `${MOUNT}\\Budgets`, name: 'inside.txt', data: b64('in a folder'), op: op('inside') })
  const rf = await h.call('files.recycle', { path: PLAN, op: op('recycle-file') })
  ok(rf.ok && typeof rf.value.bin === 'string' && /\$Recycle\.Bin/i.test(rf.value.bin), `files.recycle sends a file to the Recycle Bin (${rf.value?.bin ?? rf.error?.message})`, rf)
  const rd = await h.call('files.recycle', { path: `${MOUNT}\\Budgets`, op: op('recycle-folder') })
  ok(rd.ok && typeof rd.value.bin === 'string' && /\$Recycle\.Bin/i.test(rd.value.bin), `files.recycle sends a folder to the Recycle Bin (${rd.value?.bin ?? rd.error?.message})`, rd)
  const inBin = ps(
    [
      `$bin = (New-Object -ComObject Shell.Application).NameSpace(10)`,
      `$bin.Items() | ForEach-Object { $_.Name + '|' + $bin.GetDetailsOf($_, 1) + '|' + $_.Path }`
    ].join('\n')
  )
  log(`the Recycle Bin holds:\n${inBin}`)
  const lines = inBin.split(/\r?\n/)
  ok(
    // The bin shows a name as Explorer does: with its extension hidden, by default.
    lines.some((l) => /^plan(\.txt)?\|/.test(l) && l.includes('Archive') && l.endsWith(rf.value.bin)),
    'the file is in the Recycle Bin, from where it was',
    lines
  )
  ok(
    lines.some((l) => l.startsWith('Budgets|') && l.includes('Esports Staff - General') && l.endsWith(rd.value.bin)),
    'the folder is in the Recycle Bin',
    lines
  )
  const binFolder = ps(`Get-Content -LiteralPath (Join-Path '${rd.value.bin}' 'inside.txt')`)
  ok(binFolder === 'in a folder', "the folder's file is whole in the bin", binFolder)
  const gone = ps(`Test-Path -LiteralPath '${PLAN}'; Test-Path -LiteralPath '${MOUNT}\\Budgets'`)
  ok(gone.split(/\r?\n/).every((l) => l === 'False'), 'both left the mount', gone)
  const reRecycle = await h.call('files.recycle', { path: PLAN, op: op('recycle-file') })
  ok(reRecycle.ok && reRecycle.value.bin === rf.value.bin, 'a recycle retried by its id answers the first', reRecycle)

  // Where Windows would delete for good (the bin turned off for this user's volumes), nothing is deleted.
  await h.call('files.write', { dir: MOUNT, name: 'keep.txt', data: b64('keep'), op: op('keep') })
  const BIN = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume'
  ps(`Get-ChildItem '${BIN}' | ForEach-Object { Set-ItemProperty -Path $_.PSPath -Name NukeOnDelete -Value 1 -Type DWord }; (Get-ChildItem '${BIN}').Count`)
  try {
    const nuke = await h.call('files.recycle', { path: `${MOUNT}\\keep.txt`, op: op('nuke') })
    const kept = ps(`Get-Content -LiteralPath '${MOUNT}\\keep.txt'`)
    ok(!nuke.ok && /for good/.test(nuke.error!.message) && kept === 'keep', `with the bin turned off a delete is refused and the file stays (${nuke.error?.message})`, { nuke, kept })
  } finally {
    ps(`Get-ChildItem '${BIN}' | ForEach-Object { Set-ItemProperty -Path $_.PSPath -Name NukeOnDelete -Value 0 -Type DWord }`)
  }

  await saveBack(h)

  await h.stop()
  ps(`Remove-Item -Path 'HKCU:\\Software\\SyncEngines\\Providers\\OneDrive\\TcProofDummy' -Recurse -Force`)
  log('ALL HELD')
}

/**
 * A copy saves back, through TempCode's own code: the box's Files module, its stand-in context of tests
 * (files/testkit.ts: temp folders, an in-memory database), and the rig's helper as its VM.
 */
async function saveBack(h: Helper): Promise<void> {
  const FOLDER = `${MOUNT}\\Saveback`
  const ROSTER = `${FOLDER}\\Roster.xlsx`
  ps([`New-Item -ItemType Directory -Force -Path '${FOLDER}' | Out-Null`, `Set-Content -LiteralPath '${ROSTER}' -Value 'as the team left it' -NoNewline`].join('\n'))
  const kit = await import('../src/main/server/work/files/testkit')
  const { filesHandle, closeFilesState } = await import('../src/main/server/work/files/handle')
  const { copiesInFlight } = await import('../src/main/server/work/files/copies')
  const { setVmCall } = await import('../src/main/server/work/office/vm/link')
  const { setVmState } = await import('../src/main/server/work/office/vm/office')
  const { setCopyAllowed } = await import('../src/main/server/work/office/files/library')
  const { setThreadsMayWrite } = await import('../src/main/server/work/files/policy')
  const rig = kit.makeRig()
  try {
    const status = (await h.call('guest.status')).value
    // What the box keeps of its VM's last read: the mounts and the verbs the helper said it has.
    rig.db.prepare(`INSERT OR REPLACE INTO work_office_files (key, value) VALUES ('vm:status', ?)`).run(JSON.stringify({ at: Date.now(), status: { ...status, mounts: [{ path: MOUNT, type: 'team', web: null }] }, tops: { [MOUNT]: ['Saveback'] } }))
    setVmState(() => ({ state: 'awake', cannot: null }))
    setVmCall(async (verb, args) => {
      const a = await h.call(verb, (args ?? {}) as Record<string, unknown>)
      if (!a.ok) throw Object.assign(new Error(a.error?.message ?? verb), { code: a.error?.code })
      return a.value
    })
    setCopyAllowed(rig.db, kit.WS, true)
    setThreadsMayWrite(true)
    const call = async <T>(method: string, params: Record<string, unknown>): Promise<T> => ((await filesHandle({ id: 'p', method, params: { workspaceId: kit.WS, ...params } } as never, rig.ctx, kit.window)) as { result: T }).result
    const opened = await call<{ tabId: string; item: { source: { path: string } } }>('work.files.open', { ref: { at: 'file', host: kit.HOST, path: ROSTER }, name: 'Roster.xlsx' })
    const copy = opened.item.source.path
    const { readFileSync, writeFileSync } = await import('node:fs')
    ok(readFileSync(copy, 'utf8') === 'as the team left it', 'save back: the copy holds the guest file\'s bytes', copy)
    const tab = async (): Promise<{ back?: { is: string }; name: string; copyOf?: { path: string } }> => (await call<{ tabs: { id: string; back?: { is: string }; name: string; copyOf?: { path: string } }[] }>('work.files.tabs', {})).tabs.find((t) => t.id === opened.tabId)!
    ok((await tab()).back?.is === 'ok', 'save back: the tab is a copy that saves back', await tab())

    writeFileSync(copy, 'his change')
    const sent = await call<{ is: string }>('work.files.copyBack', { tabId: opened.tabId })
    const there = ps(`Get-Content -LiteralPath '${ROSTER}' -Raw`)
    ok(sent.is === 'ok' && there === 'his change', 'save back: sent by the version it was read at, the bytes in the guest change', { sent, there })

    ps(`Set-Content -LiteralPath '${ROSTER}' -Value 'changed in the VM' -NoNewline`)
    writeFileSync(copy, 'his second change')
    const clash = await call<{ is: string }>('work.files.copyBack', { tabId: opened.tabId })
    const left = ps(`Get-Content -LiteralPath '${ROSTER}' -Raw`)
    ok(clash.is === 'changed' && left === 'changed in the VM', "save back: after the guest's file changed it is refused as the conflict, the guest's file as it was", { clash, left })

    await call('work.files.copyKeep', { tabId: opened.tabId })
    const mine = ps(`Get-Content -LiteralPath '${FOLDER}\\Roster (mine).xlsx' -Raw`)
    const kept = await tab()
    ok(mine === 'his second change' && kept.name === 'Roster (mine).xlsx' && kept.copyOf?.path === `${FOLDER}\\Roster (mine).xlsx`, 'save back: Keep Both writes his beside it in the guest, and the tab shows that file', { mine, kept })
    const tmpLeft = ps(`(Get-ChildItem -LiteralPath '${FOLDER}' -Force | Where-Object Name -like '*.tmp').Count`)
    ok(tmpLeft === '0', 'save back: no staged file is left beside them', tmpLeft)
    await Promise.all(copiesInFlight())
  } finally {
    setVmCall(null)
    setThreadsMayWrite(false)
    closeFilesState(rig.db)
    rig.close()
    ps(`Remove-Item -LiteralPath '${FOLDER}' -Recurse -Force`)
  }
}

main().catch((err) => fail('the proof threw', err instanceof Error ? err.stack : err))
