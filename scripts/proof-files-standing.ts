/**
 * A delete in his real OneDrive in the box's standing Windows VM, through this tree's own Files code
 * (docs/agents/work-files.md "The Windows VM's verbs"): dummy things only, made by this proof in a folder named
 * "TempCode proof <run>" at the top of one mount (the `tc-proof` library where OneDrive syncs one, else his own
 * OneDrive). Nothing else there is listed, opened, read, changed or deleted.
 *
 *   bun scripts/proof-bun.ts scripts/proof-files-standing.ts ['<an earlier run's "TempCode proof <run>" folder>'...]
 *
 * The machine must be awake (its keeper's); the proof speaks to the helper the keeper started, as the box's service
 * does: over the admin's SSH forward to the guest's loopback door, with the door's token. It makes a folder, a file
 * and a folder inside it through `work.files.make`, waits for OneDrive, deletes the file and the inner folder through
 * `work.files.trash` (asked, as his window asks), finds both in tcuser's Recycle Bin by the bin's own records, and
 * puts them back through `work.files.restore` where the helper has `files.restore`; with a helper built before it,
 * Put back says so, and the proof puts each back by the same steps `files.restore` takes (the item out of the bin to
 * the path its record names, the record gone), as the admin. The dummy folder ends in the Recycle Bin.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import type { Socket } from 'node:net'
import { join } from 'node:path'

import { openVmProofSocket, VmProofWire, type VmProofReply } from './lib/vmProofWire'
import { watchProofChild } from './e2e-work-lib'

const VM = process.env.WINVM_DIR ?? '/srv/agents/win-vm'
const PORT = 22230
const LOCAL = 47911
const RUN = Date.now().toString(36)
const KEY = ['-i', join(VM, 'keys', 'id_ed25519'), '-p', String(PORT), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-o', `UserKnownHostsFile=${join(VM, 'standing', 'known_hosts')}`, '-o', 'StrictHostKeyChecking=no']

const log = (...a: unknown[]): void => console.log(`[standing ${new Date().toISOString().slice(11, 19)}]`, ...a)
function fail(what: string, got: unknown): never {
  throw new Error(`${what}\n${JSON.stringify(got, null, 2)}`)
}
function ok(cond: boolean, what: string, got: unknown): void {
  if (!cond) fail(what, got)
  log(`ok: ${what}`)
}

/** PowerShell as the admin of the standing machine, through the rig's own script. */
function adminPs(script: string): string {
  const r = spawnSync(join(import.meta.dirname, 'win-vm', 'ssh.sh'), ['--instance', 'standing', '-a', '--ps', script], { encoding: 'utf8', timeout: 120_000 })
  if (r.status !== 0) fail(`PowerShell as the admin: ${script.slice(0, 80)}`, { status: r.status, stdout: r.stdout, stderr: r.stderr })
  return r.stdout.trim()
}

/** The helper's door: one JSON line each way after the token. */
class Door {
  private socket?: Socket
  private wire?: VmProofWire

  async open(token: string, signal: AbortSignal): Promise<void> {
    this.socket = await openVmProofSocket({ host: '127.0.0.1', port: LOCAL }, signal)
    this.wire = new VmProofWire(this.socket, this.socket)
    this.socket.write(token + '\n')
    await this.wire.waitReady(10_000, signal)
  }

  call(verb: string, args: Record<string, unknown> = {}, ms = 60_000): Promise<VmProofReply> {
    return this.wire!.call(verb, args, ms)
  }

  close(): void {
    this.wire?.close()
    this.socket?.destroy()
  }
}

/** The Recycle Bin's records of tcuser's, whose path lies under `under`: each record's path, and where its item is. */
function binRecords(sid: string, under: string): { path: string; item: string; there: boolean }[] {
  const out = adminPs(
    [
      `$d = 'C:\\$Recycle.Bin\\${sid}'`,
      `Get-ChildItem -LiteralPath $d -Force -Filter '$I*' | ForEach-Object {`,
      `  $b = [IO.File]::ReadAllBytes($_.FullName)`,
      `  if ([BitConverter]::ToInt64($b, 0) -eq 2) { $n = [BitConverter]::ToInt32($b, 24); $p = [Text.Encoding]::Unicode.GetString($b, 28, ($n - 1) * 2) } else { $p = [Text.Encoding]::Unicode.GetString($b, 24, 520).TrimEnd([char]0) }`,
      `  if ($p.StartsWith('${under.replace(/'/g, "''")}')) { $r = Join-Path $d ('$R' + $_.Name.Substring(2)); $p + '|' + $r + '|' + (Test-Path -LiteralPath $r) }`,
      `}`
    ].join('\n')
  )
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [path, item, there] = l.split('|')
      return { path: path!, item: item!, there: there === 'True' }
    })
}

async function main(): Promise<void> {
  const token = adminPs(`Get-Content -LiteralPath 'C:\\ProgramData\\TempCode\\token' -Raw`).trim()
  ok(token.length >= 32, 'the door\'s token is read as the admin', token.length)
  const forward: ChildProcess = spawn('ssh', [...KEY, '-N', '-L', `127.0.0.1:${LOCAL}:127.0.0.1:47801`, 'tcadmin@127.0.0.1'], { stdio: 'ignore' })
  const lost = new AbortController()
  const exited = watchProofChild(forward, 'VM proof SSH forward')
  void exited.then((error) => lost.abort(error ?? new Error('VM proof SSH forward exited')))
  const door = new Door()
  const kit = await import('../src/main/server/work/files/testkit')
  const { filesHandle, closeFilesState } = await import('../src/main/server/work/files/handle')
  const { setVmCall } = await import('../src/main/server/work/office/vm/link')
  const { setVmState } = await import('../src/main/server/work/office/vm/office')
  const rig = kit.makeRig()
  let top = ''
  try {
    const connectBy = Date.now() + 15_000
    while (true) {
      try {
        await door.open(token, lost.signal)
        break
      } catch (error) {
        door.close()
        if (lost.signal.aborted || Date.now() > connectBy) throw error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    const status = (await door.call('guest.status')).value
    ok(status?.onedrive?.running === true, `OneDrive runs in the VM as ${status?.onedrive?.account ?? 'nobody'}`, status?.onedrive)
    const mounts = status.mounts as { path: string; type: string }[]
    const mount = mounts.find((m) => /\\tc-proof$/i.test(m.path)) ?? mounts.find((m) => m.type === 'mine')
    if (!mount) fail('no tc-proof library and no own OneDrive among the mounts', mounts.map((m) => m.type))
    log(`the dummies go in ${mount.path}`)
    const verbs = status.verbs as string[]
    log(`the helper has: ${verbs.join(', ')}`)
    const sid = adminPs(`(New-Object System.Security.Principal.NTAccount('tcuser')).Translate([System.Security.Principal.SecurityIdentifier]).Value`)
    rig.db.prepare(`INSERT OR REPLACE INTO work_office_files (key, value) VALUES ('vm:status', ?)`).run(JSON.stringify({ at: Date.now(), status: { ...status, mounts: [{ ...mount, type: mount.type === 'mine' ? 'mine' : 'team', web: null }] }, tops: { [mount.path]: [] } }))
    setVmState(() => ({ state: 'awake', cannot: null }))
    setVmCall(async (verb, args) => {
      const a = await door.call(verb, (args ?? {}) as Record<string, unknown>)
      if (!a.ok) throw Object.assign(new Error(a.error?.message ?? verb), { code: a.error?.code })
      return a.value
    })
    const call = async <T>(method: string, params: Record<string, unknown>): Promise<T> => ((await filesHandle({ id: 'p', method, params: { workspaceId: kit.WS, ...params } } as never, rig.ctx, kit.window)) as { result: T }).result
    const ref = (path: string) => ({ at: 'file', host: kit.HOST, path })

    // Made through Files: the folder, a file and a folder in it.
    const made = await call<{ entries: { name: string; folder: { path: string } | null; ref: { path: string } | null }[] }>('work.files.make', { at: ref(mount.path), kind: 'folder', name: `TempCode proof ${RUN}`, op: `standing-${RUN}-top` })
    top = made.entries[0]!.folder!.path
    const file = (await call<typeof made>('work.files.make', { at: ref(top), kind: 'text', name: 'TempCode proof', op: `standing-${RUN}-file` })).entries[0]!.ref!.path
    const inner = (await call<typeof made>('work.files.make', { at: ref(top), kind: 'folder', name: 'TempCode proof folder', op: `standing-${RUN}-inner` })).entries[0]!.folder!.path
    ok(!!file && !!inner, `made ${file} and ${inner}`, { file, inner })
    await new Promise((r) => setTimeout(r, 30_000))
    for (const p of [file, inner]) log(`OneDrive's state of ${p.slice(p.lastIndexOf('\\') + 1)}: ${JSON.stringify((await door.call('files.stat', { path: p })).value)}`)

    // Deleted through Files, as his window asks it.
    const done = await call<{ trashed: string[]; refused: { name: string; text: string }[] }>('work.files.trash', { refs: [ref(file), ref(inner)], op: `standing-${RUN}-trash`, asked: true })
    ok(done.trashed.length === 2 && !done.refused.length, 'work.files.trash sent the file and the folder to the Recycle Bin', done)
    const gone = await door.call('files.list', { dir: top })
    ok(gone.ok && (gone.value as unknown[]).length === 0, 'both left the folder', gone.value)
    const records = binRecords(sid, top)
    log(`tcuser's Recycle Bin holds:\n${records.map((r) => `${r.path} -> ${r.item} (${r.there ? 'there' : 'missing'})`).join('\n')}`)
    ok(records.length === 2 && records.every((r) => r.there) && records.some((r) => r.path === file) && records.some((r) => r.path === inner), 'both sit in the Recycle Bin, each record naming where it was', records)

    // Put back.
    const back = await call<{ entries: { name: string }[]; refused: { name: string; text: string }[] }>('work.files.restore', { ids: done.trashed, op: `standing-${RUN}-undo` })
    log(`Put back through Files answered: ${JSON.stringify(back)}`)
    if (verbs.includes('files.restore')) {
      ok(back.entries.length === 2 && !back.refused.length, 'work.files.restore put both back through the helper', back)
    } else {
      ok(back.refused.every((r) => r.text === 'Put it back from the Recycle Bin in the Windows VM.'), "this helper is a release behind: Put back says where to put it back", back.refused)
      // The steps files.restore takes, as the admin: the item to the path its record names, never over anything; the record goes.
      for (const r of records) {
        adminPs(
          [
            `if (Test-Path -LiteralPath '${r.path.replace(/'/g, "''")}') { throw 'taken' }`,
            `Move-Item -LiteralPath '${r.item.replace(/'/g, "''")}' -Destination '${r.path.replace(/'/g, "''")}'`,
            `Remove-Item -LiteralPath '${r.item.replace(/\$R([^\\]*)$/, (_m, rest: string) => `$I${rest}`).replace(/'/g, "''")}' -Force`
          ].join('\n')
        )
      }
    }
    const again = await door.call('files.list', { dir: top })
    const names = (again.value as { name: string }[]).map((e) => e.name).sort()
    ok(names.join('|') === 'TempCode proof folder|TempCode proof.txt', 'both are back where they were', names)
    ok(binRecords(sid, top).length === 0, 'and the Recycle Bin holds them no more', null)
    await new Promise((r) => setTimeout(r, 20_000))
    for (const p of [file, inner]) log(`OneDrive's state of ${p.slice(p.lastIndexOf('\\') + 1)} after: ${JSON.stringify((await door.call('files.stat', { path: p })).value)}`)
  } finally {
    try {
      const recycle = async (path: string, suffix: string): Promise<void> => {
        const answer = await door.call('files.recycle', { path, op: `tc-files:standing-${RUN}:${suffix}` }, 10_000)
        if (!answer.ok) throw new Error(answer.error?.message ?? `Could not recycle ${path}`)
        log(`recycled proof folder ${path}`)
      }
      if (top) await recycle(top, 'end')
      for (const [i, left] of process.argv.slice(2).entries()) {
        if (!/\\TempCode proof [a-z0-9]+$/.test(left)) fail('only an earlier run’s dummy folder may be named', left)
        await recycle(left, `left-${i}`)
      }
    } finally {
      door.close()
      forward.kill()
      setVmCall(null)
      closeFilesState(rig.db)
      rig.close()
    }
  }
  log('ALL HELD')
}

main().catch((error: unknown) => {
  console.error('FAILED', error)
  process.exitCode = 1
})
