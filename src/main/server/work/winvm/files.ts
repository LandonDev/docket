import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, existsSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { workText, type WorkToolResult } from '@shared/work'
import { VM_RUNNABLE } from '../../computer/policy'
import type { ToolCtx, WorkCtx, WorkTool } from '../modules'
import { psQuote } from './machine/guest'

/**
 * Files in and out of the Windows VM (docs/agents/work-winvm.md "Files"): `windows_put` copies a file of the
 * thread's workspace into tcuser's Documents, Downloads or Desktop, `windows_get` copies one back. Fenced at both
 * ends: on the box the file must be the workspace's own (its real path inside the workspace's folder, no link
 * out); in the guest only those three folders, a plain file name (no `..`, no other user, no stream, no 8.3
 * name, no device name), and neither the folder nor the file a link elsewhere, since the copy runs as the admin.
 * At most 200 MB either way. A put refuses a file Windows runs (policy.ts `VM_RUNNABLE`; the guest's own NTFS
 * deny of execute in those folders is the first line) and records a Result whose undo removes the file it put,
 * only while it is as it was put. Both go over the keeper's own SSH connection (SFTP).
 */

export const FILE_MAX_BYTES = 200 * 1024 * 1024
export const GUEST_FOLDERS = ['Documents', 'Downloads', 'Desktop'] as const
export type GuestFolder = (typeof GUEST_FOLDERS)[number]

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i

/** Why a name may not be a file in the guest's folder, or null when it may. */
export function guestNameRefusal(name: string): string | null {
  if (!name || name.length > 200) return 'a file name of 1 to 200 characters'
  if (name === '.' || name === '..') return 'a file name, not a folder'
  if (/[\\/]/.test(name)) return 'a file name alone, with no folder in it'
  if (/[<>:"|?*\x00-\x1f]/.test(name)) return 'a file name without < > : " | ? * or a control character (a colon would name a stream)'
  if (name.includes('~')) return 'a file name without ~ (Windows reads one as a short name for another file)'
  if (/[. ]$/.test(name) || /^ /.test(name)) return 'a file name that does not start with a space or end with a dot or a space'
  if (RESERVED.test(name)) return 'a file name that is not a Windows device name'
  return null
}

export const NOT_IN_WORKSPACE = 'refused: the file must be in this workspace\'s own folder'
export const NO_WORKSPACE = 'refused: this thread has no workspace folder on this host'
export const RUNS = 'refused: Windows would run that kind of file (a program, a script, a shortcut, a registry or setup file); put a document instead'
export const TOO_BIG = `refused: at most ${FILE_MAX_BYTES / 1024 / 1024} MB`

export const PUTS_TABLE = 'work_winvm_puts'
export function ensurePuts(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${PUTS_TABLE} (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, folder TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, at INTEGER NOT NULL)`)
}

/** What the file tools ask of the guest: the keeper's own connection and its admin. */
export interface GuestFiles {
  /** wakes the machine and holds it for this thread; a line refusing the call, or null */
  enter(ctx: ToolCtx): Promise<string | null>
  admin(script: string): Promise<string>
  send(local: string, rel: string): Promise<void>
  fetch(rel: string, local: string): Promise<void>
}

const inside = (path: string, dir: string): boolean => {
  const r = relative(dir, path)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}

/** The thread's workspace folder on this host, its real path; null for a Work Chat or a folder not here. */
export function workspaceFolder(ctx: Pick<WorkCtx, 'db'>, workspaceId: string | null): string | null {
  if (!workspaceId) return null
  const row = ctx.db.prepare('SELECT path FROM workspaces WHERE id = ?').get(workspaceId) as { path?: string } | undefined
  if (!row?.path || !existsSync(row.path)) return null
  return realpathSync(row.path)
}

/** A path the thread named, as the workspace's real file or folder, or the line that refuses it. */
export function inWorkspace(ctx: ToolCtx, path: string, opts: { exists: boolean }): { path: string; folder: string } | { refused: string } {
  const folder = workspaceFolder(ctx, ctx.scope.workspaceId)
  if (!folder) return { refused: NO_WORKSPACE }
  const asked = resolve(folder, path)
  let real: string
  try {
    real = opts.exists ? realpathSync(asked) : join(realpathSync(dirname(asked)), basename(asked))
  } catch {
    return { refused: opts.exists ? `refused: no file ${path} in the workspace` : `refused: no folder ${dirname(path)} in the workspace` }
  }
  if (real !== folder && !inside(real, folder)) return { refused: NOT_IN_WORKSPACE }
  // the host's own fence, as for every file a thread names
  if (!ctx.reaches({ kind: 'model', caps: [], sessionId: ctx.sessionId }, real)) return { refused: NOT_IN_WORKSPACE }
  return { path: real, folder }
}

async function sha256(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer)
  return h.digest('hex')
}

/** "Budget (1).xlsx": the first of name, then "name (n)", that `taken` says is free. */
export function freeName(name: string, taken: (n: string) => boolean): string {
  if (!taken(name)) return name
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; i < 1000; i++) {
    const n = `${stem} (${i})${ext}`
    if (!taken(n)) return n
  }
  throw new Error('no free name for that file')
}

const guestDir = (folder: GuestFolder) => `C:\\Users\\tcuser\\${folder}`
/** The guest's folder checked as a real folder, not a link elsewhere (tcuser could make one: the copy runs as the admin). */
const realFolderPs = (folder: GuestFolder) => `
$dir = ${psQuote(guestDir(folder))}
$d = Get-Item -LiteralPath $dir -Force -ErrorAction Stop
if (-not $d.PSIsContainer -or ($d.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'that folder is not a plain folder' }`

const errorOf = (line: string): WorkToolResult => ({ ...workText(line), isError: true })

export function fileTools(guest: () => GuestFiles | null): WorkTool[] {
  const folder = z.enum(GUEST_FOLDERS)
  return [
    {
      name: 'windows_put',
      description:
        "Copy a file from this workspace into the Windows VM, into tcuser's Documents, Downloads or Desktop, so an app there can open it. `path` is the file in the workspace; `name` names it in the guest (the file's own name if left out; a taken name gets \"(1)\"). At most 200 MB. Programs, scripts, shortcuts and setup files are refused. It is recorded with an undo that removes the file.",
      input: z.object({ path: z.string().min(1).max(1000), to: folder, name: z.string().min(1).max(200).optional() }),
      readOnly: false,
      async run(args, ctx) {
        const { path, to, name } = args as { path: string; to: GuestFolder; name?: string }
        const g = guest()
        if (!g) return errorOf('refused: the Windows VM is not on this host')
        const file = inWorkspace(ctx, path, { exists: true })
        if ('refused' in file) return errorOf(file.refused)
        const st = statSync(file.path)
        if (!st.isFile()) return errorOf(`refused: ${path} is not a file`)
        if (st.size > FILE_MAX_BYTES) return errorOf(TOO_BIG)
        const wanted = name ?? basename(file.path)
        const bad = guestNameRefusal(wanted)
        if (bad) return errorOf(`refused: ${bad}`)
        if (VM_RUNNABLE.test(wanted) || VM_RUNNABLE.test(file.path)) return errorOf(RUNS)
        const refused = await g.enter(ctx)
        if (refused) return errorOf(refused)
        const taken = new Set(
          (await g.admin(`${realFolderPs(to)}\nGet-ChildItem -LiteralPath $dir -Force -Name`)).split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean)
        )
        const free = freeName(wanted, (n) => taken.has(n.toLowerCase()))
        await g.send(file.path, `${to}/${free}`)
        const id = randomBytes(6).toString('hex')
        const hash = await sha256(file.path)
        ctx.db.prepare(`INSERT INTO ${PUTS_TABLE} (id, session_id, folder, name, size, sha256, at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, ctx.sessionId, to, free, st.size, hash, Date.now())
        ctx.results.add({
          sessionId: ctx.sessionId,
          kind: 'windows.put',
          summary: `Put ${free} in ${to} on the Windows VM`,
          account: 'Windows VM',
          ref: { folder: to, name: free },
          undo: { pillar: 'winvm', verb: 'windows_put_undo', args: { put: id }, label: 'Remove the file' }
        })
        return workText(`Put ${basename(file.path)} in ${to} on the Windows VM as ${guestDir(to)}\\${free}.`)
      }
    },
    {
      name: 'windows_get',
      description:
        "Copy a file from tcuser's Documents, Downloads or Desktop in the Windows VM into this workspace. `name` is the file's name there; `path` is a folder in the workspace to put it in (the workspace's own folder if left out; a taken name gets \"(1)\"). At most 200 MB.",
      input: z.object({ from: folder, name: z.string().min(1).max(200), path: z.string().min(1).max(1000).optional() }),
      readOnly: false,
      async run(args, ctx) {
        const { from, name, path } = args as { from: GuestFolder; name: string; path?: string }
        const g = guest()
        if (!g) return errorOf('refused: the Windows VM is not on this host')
        const bad = guestNameRefusal(name)
        if (bad) return errorOf(`refused: ${bad}`)
        const into = inWorkspace(ctx, path ?? '.', { exists: true })
        if ('refused' in into) return errorOf(into.refused)
        if (!statSync(into.path).isDirectory()) return errorOf(`refused: ${path} is not a folder in the workspace`)
        const refused = await g.enter(ctx)
        if (refused) return errorOf(refused)
        const facts = await g.admin(`${realFolderPs(from)}
$f = Get-Item -LiteralPath (Join-Path $dir ${psQuote(name)}) -Force -ErrorAction SilentlyContinue
if (-not $f) { 'missing' } elseif ($f.PSIsContainer -or ($f.Attributes -band [IO.FileAttributes]::ReparsePoint)) { 'not-a-file' } else { "size $($f.Length)" }`)
        if (facts.includes('missing')) return errorOf(`refused: no file ${name} in ${from}`)
        if (facts.includes('not-a-file')) return errorOf(`refused: ${name} in ${from} is not a plain file`)
        const size = Number(/size (\d+)/.exec(facts)?.[1] ?? NaN)
        if (!Number.isFinite(size)) return errorOf(`refused: ${name} in ${from} could not be read`)
        if (size > FILE_MAX_BYTES) return errorOf(TOO_BIG)
        const free = freeName(name, (n) => existsSync(join(into.path, n)))
        const dest = join(into.path, free)
        const part = `${dest}.${randomBytes(4).toString('hex')}.part`
        try {
          await g.fetch(`${from}/${name}`, part)
          if (statSync(part).size > FILE_MAX_BYTES) throw new Error(TOO_BIG)
          renameSync(part, dest)
        } finally {
          rmSync(part, { force: true })
        }
        return workText(`Copied ${name} from ${from} on the Windows VM into the workspace as ${relative(into.folder, dest) || free}.`)
      }
    },
    {
      name: 'windows_put_undo',
      description: 'Remove a file windows_put put in the Windows VM, by the put\'s id, while it is still as it was put. The way back of a put\'s Result.',
      input: z.object({ put: z.string().regex(/^[0-9a-f]{12}$/) }),
      readOnly: false,
      async run(args, ctx) {
        const { put } = args as { put: string }
        const row = ctx.db.prepare(`SELECT * FROM ${PUTS_TABLE} WHERE id = ?`).get(put) as { session_id: string; folder: GuestFolder; name: string; sha256: string } | undefined
        if (!row || row.session_id !== ctx.sessionId) return errorOf('refused: no such put of this thread')
        const g = guest()
        if (!g) return errorOf('refused: the Windows VM is not on this host')
        const refused = await g.enter(ctx)
        if (refused) return errorOf(refused)
        const out = await g.admin(`${realFolderPs(row.folder)}
$p = Join-Path $dir ${psQuote(row.name)}
$f = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
if (-not $f) { 'gone' }
elseif ($f.PSIsContainer -or ($f.Attributes -band [IO.FileAttributes]::ReparsePoint)) { 'changed' }
elseif ((Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() -ne ${psQuote(row.sha256)}) { 'changed' }
else { Remove-Item -LiteralPath $p -Force; 'removed' }`)
        if (out.includes('changed')) return errorOf(`refused: ${row.name} in ${row.folder} changed since it was put; it is left as it is`)
        return workText(out.includes('gone') ? `${row.name} was already gone from ${row.folder}.` : `Removed ${row.name} from ${row.folder} on the Windows VM.`)
      }
    }
  ]
}
