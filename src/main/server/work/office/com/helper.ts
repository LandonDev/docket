import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptTree } from '../../../procTree'
import { TC_OFFICE_CS } from './source'

/**
 * tc-office.exe, the Windows carrier's helper (docs/agents/work-office.md
 * "Windows"): compiled once from its C# (native/tc-office-win/TcOffice.cs,
 * carried here as `TC_OFFICE_CS`) by the csc.exe every Windows has (.NET
 * Framework 4), into the temp dir under a name from the source's hash, as the
 * job helper is (procTree.ts). So no exe ships and no PowerShell runs. It is
 * started hidden in a Job Object of its own and ends with the app.
 */

export const CSC_REFS = ['/r:System.Core.dll', '/r:System.Web.Extensions.dll', '/r:System.Windows.Forms.dll']

export const helperExe = (dir: string = tmpdir()): string => join(dir, `tempcode-office-${createHash('sha256').update(TC_OFFICE_CS).digest('hex').slice(0, 12)}.exe`)

export const defaultCsc = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.SystemRoot || env.windir || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')

export const cscArgs = (out: string, src: string): string[] => ['/nologo', '/optimize', '/target:exe', ...CSC_REFS, `/out:${out}`, src]

export interface HelperDeps {
  exe?: string
  csc?: string
  compile?: (csc: string, source: string, out: string) => Promise<void>
  exists?: (path: string) => boolean
}

/** The helper's path, compiled first when missing. Two instances compiling at once settle on whichever finished. */
export async function ensureHelper(deps: HelperDeps = {}): Promise<string> {
  const exe = deps.exe ?? helperExe()
  const exists = deps.exists ?? existsSync
  if (exists(exe)) return exe
  const tmp = `${exe}.${process.pid}.tmp.exe`
  try {
    await (deps.compile ?? compileCs)(deps.csc ?? defaultCsc(), TC_OFFICE_CS, tmp)
    renameSync(tmp, exe)
  } catch (err) {
    if (!exists(exe)) throw err
  } finally {
    rmSync(tmp, { force: true })
  }
  return exe
}

async function compileCs(csc: string, source: string, out: string): Promise<void> {
  const src = `${out}.cs`
  await writeFile(src, source)
  try {
    await new Promise<void>((resolve, reject) =>
      execFile(csc, cscArgs(out, src), { windowsHide: true, timeout: 120_000 }, (err, stdout) => (err ? reject(new Error(`csc: ${String(stdout).trim() || err.message}`)) : resolve()))
    )
  } finally {
    rmSync(src, { force: true })
  }
}

/** The helper running, hidden, in a job of its own; its stdin closing (the app gone) ends it. */
export async function spawnHelper(deps: HelperDeps = {}): Promise<ChildProcess> {
  const exe = await ensureHelper(deps)
  return adoptTree(spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }))
}
