import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A child and everything it starts, as one thing the host can stop.
 *
 * POSIX: the child leads a process group of its own (`detached: true`) and a
 * stop signals the group (`process.kill(-pid)`), as every call site always did.
 *
 * Windows has neither: a negative pid throws, `detached` opens a console
 * window, and a child outlives its parent. So there a child is spawned
 * hidden in the parent's console, and `adoptTree` puts it in a Job Object of
 * its own with KILL_ON_JOB_CLOSE: whatever it starts joins the job, ending
 * the job ends them all, and the job ends when the child exits, when the
 * host stops it, or when the app itself goes (the helper holding the jobs
 * reads its stdin from the app; when that closes it exits and Windows closes
 * every job). Job Objects have no Node API, so the helper is a few lines of
 * C# compiled once with the csc.exe every Windows carries (.NET Framework 4)
 * into the temp dir. Without it a stop falls back to `taskkill /T /F`, which
 * reaches the descendants whose parents are still alive.
 */

export const IS_WIN = process.platform === 'win32'

/** Spawn options for a child the host stops with its tree. */
export function treeSpawnOptions(platform: NodeJS.Platform = process.platform): { detached: boolean; windowsHide?: boolean } {
  return platform === 'win32' ? { detached: false, windowsHide: true } : { detached: true }
}

export interface KillTreeDeps {
  platform?: NodeJS.Platform
  /** process.kill */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void
  /** Runs taskkill (win32); defaults to a hidden, unwaited execFile. */
  taskkill?: (args: string[]) => void
  /** The job of an adopted pid, ended at once (win32). */
  endJob?: (pid: number) => boolean
}

/**
 * Signal `pid`'s tree: its process group on POSIX; on win32 its job when it
 * was adopted, and `taskkill /T /F` in any case (Windows has no gentle signal
 * for a console program: SIGTERM is a kill there too). False when nothing was
 * there.
 */
export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM', deps: KillTreeDeps = {}): boolean {
  if (!pid || pid <= 1) return false
  const kill = deps.kill ?? ((p, s) => process.kill(p, s))
  if ((deps.platform ?? process.platform) !== 'win32') {
    try {
      kill(-pid, signal)
      return true
    } catch {
      return false
    }
  }
  try {
    kill(pid, 0)
  } catch {
    // The root is gone; its job (when adopted) still holds what it left.
    return (deps.endJob ?? endJob)(pid)
  }
  ;(deps.endJob ?? endJob)(pid)
  ;(deps.taskkill ?? runTaskkill)(taskkillTreeArgs(pid))
  return true
}

export function taskkillTreeArgs(pid: number): string[] {
  return ['/PID', String(pid), '/T', '/F']
}

function runTaskkill(args: string[]): void {
  execFile('taskkill.exe', args, { windowsHide: true, timeout: 15_000 }, () => {
    // exits non-zero when a process of the tree was already gone
  })
}

// ── Job Objects (win32) ───────────────────────────────────────────────

/** The helper: one job per adopted pid, named by it. Lines in: `add <pid>`, `end <pid>`. EOF ends every job. */
export const JOB_HELPER_CS = `using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
static class TcJobs {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attrs, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref Ext info, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long A; public long B; public uint LimitFlags; public UIntPtr C; public UIntPtr D; public uint E; public UIntPtr F; public uint G; public uint H; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct Ext { public Basic Basic; public Io Io; public UIntPtr A, B, C, D; }
  static void Main() {
    var jobs = new Dictionary<int, IntPtr>();
    string line;
    while ((line = Console.ReadLine()) != null) {
      var parts = line.Split(' ');
      int pid;
      if (parts.Length != 2 || !int.TryParse(parts[1], out pid)) { Console.WriteLine("err " + line); continue; }
      IntPtr job;
      if (parts[0] == "add") {
        job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
        var info = new Ext();
        info.Basic.LimitFlags = 0x2000;
        SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(Ext)));
        var proc = OpenProcess(0x0101, false, pid);
        bool ok = proc != IntPtr.Zero && AssignProcessToJobObject(job, proc);
        if (proc != IntPtr.Zero) CloseHandle(proc);
        if (!ok) { CloseHandle(job); Console.WriteLine("err " + pid + " " + Marshal.GetLastWin32Error()); continue; }
        if (jobs.ContainsKey(pid)) CloseHandle(jobs[pid]);
        jobs[pid] = job;
        Console.WriteLine("ok " + pid);
      } else if (parts[0] == "end" && jobs.TryGetValue(pid, out job)) {
        TerminateJobObject(job, 1);
        CloseHandle(job);
        jobs.Remove(pid);
        Console.WriteLine("ended " + pid);
      }
    }
  }
}
`

export interface JobHelperDeps {
  /** The compiled helper's path; compiled when missing. */
  exe?: string
  csc?: string
  spawnHelper?: (exe: string) => ChildProcess
  compile?: (csc: string, source: string, out: string) => Promise<void>
  log?: (line: string) => void
}

/** The jobs of this app: one helper process, started on the first adoption. */
export class JobHost {
  private helper: ChildProcess | null = null
  private ready: Promise<ChildProcess | null> | null = null
  private readonly live = new Set<number>()

  constructor(private readonly deps: JobHelperDeps = {}) {}

  /** Put `pid` (and so whatever it starts from now on) in a job of its own; resolves false when the helper is unavailable. */
  async add(pid: number): Promise<boolean> {
    const helper = await this.start()
    if (!helper?.stdin || helper.stdin.destroyed) return false
    this.live.add(pid)
    helper.stdin.write(`add ${pid}\n`)
    return true
  }

  /** End the job of `pid` and everything in it; false when it has none. */
  end(pid: number): boolean {
    if (!this.live.delete(pid)) return false
    const stdin = this.helper?.stdin
    if (!stdin || stdin.destroyed) return false
    stdin.write(`end ${pid}\n`)
    return true
  }

  has(pid: number): boolean {
    return this.live.has(pid)
  }

  private start(): Promise<ChildProcess | null> {
    this.ready ??= (async () => {
      const log = this.deps.log ?? ((line: string) => console.log(`[procTree] ${line}`))
      const exe = this.deps.exe ?? join(tmpdir(), `tempcode-jobs-${createHash('sha256').update(JOB_HELPER_CS).digest('hex').slice(0, 12)}.exe`)
      try {
        if (!existsSync(exe)) {
          const tmp = `${exe}.${process.pid}.tmp.exe`
          await (this.deps.compile ?? compileCs)(this.deps.csc ?? defaultCsc(), JOB_HELPER_CS, tmp)
          renameSync(tmp, exe)
        }
        const helper = (this.deps.spawnHelper ?? spawnJobHelper)(exe)
        helper.on('error', (err) => log(`job helper: ${err.message}`))
        helper.stdin?.on('error', () => undefined)
        helper.stdout?.on('data', (d: Buffer) => {
          for (const line of d.toString().split('\n')) if (line.startsWith('err')) log(`job helper: ${line.trim()}`)
        })
        helper.once('exit', () => {
          this.helper = null
          this.ready = null
          this.live.clear()
        })
        this.helper = helper
        return helper
      } catch (err) {
        log(`no job helper (stops use taskkill /T): ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
    })()
    return this.ready
  }
}

function defaultCsc(): string {
  return join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
}

async function compileCs(csc: string, source: string, out: string): Promise<void> {
  const { writeFile, rm } = await import('node:fs/promises')
  const src = `${out}.cs`
  await writeFile(src, source)
  try {
    await new Promise<void>((resolve, reject) =>
      execFile(csc, ['/nologo', '/optimize', '/target:exe', `/out:${out}`, src], { windowsHide: true, timeout: 60_000 }, (err, stdout) =>
        err ? reject(new Error(`${err.message} ${String(stdout).trim()}`)) : resolve()
      )
    )
  } finally {
    await rm(src, { force: true })
  }
}

function spawnJobHelper(exe: string): ChildProcess {
  const helper = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  // Never holds the app's event loop open: its stdin closing at exit is what ends the jobs.
  helper.unref()
  ;(helper.stdout as unknown as { unref?: () => void } | null)?.unref?.()
  ;(helper.stdin as unknown as { unref?: () => void } | null)?.unref?.()
  return helper
}

let jobs: JobHost | null = null
function jobHost(): JobHost {
  jobs ??= new JobHost()
  return jobs
}

function endJob(pid: number): boolean {
  return jobs?.end(pid) ?? false
}

/**
 * win32: put `child` in a job of its own, ended when it exits, so nothing it
 * started outlives it. Anywhere else nothing: its process group serves.
 */
export function adoptTree(child: ChildProcess, platform: NodeJS.Platform = process.platform, host: () => JobHost = jobHost): ChildProcess {
  if (platform !== 'win32' || !child.pid) return child
  const pid = child.pid
  void host().add(pid)
  child.once('exit', () => host().end(pid))
  return child
}

// ── the process table and the listeners (win32) ──────────────────────

export interface ProcRow {
  pid: number
  ppid: number
  /** Working set in kB (win32), RSS elsewhere. */
  rssKb: number
  /** The command line; empty when Windows does not say (another user's process). */
  args: string
  /** Epoch ms, when known. */
  startedAt: number | null
}

/** One process table from CIM, as PowerShell prints it with ConvertTo-Json. */
export const WIN_PS_TABLE =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine,@{n="Started";e={if($_.CreationDate){[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds()}}} | ConvertTo-Json -Compress'

export function parseWinProcessTable(json: string): ProcRow[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : []
  const out: ProcRow[] = []
  for (const r of rows as Array<Record<string, unknown>>) {
    const pid = Number(r.ProcessId)
    if (!Number.isInteger(pid) || pid <= 0) continue
    out.push({
      pid,
      ppid: Number(r.ParentProcessId) || 0,
      rssKb: Math.round((Number(r.WorkingSetSize) || 0) / 1024),
      args: typeof r.CommandLine === 'string' ? r.CommandLine : '',
      startedAt: Number.isFinite(Number(r.Started)) && r.Started != null ? Number(r.Started) : null
    })
  }
  return out
}

/** The win32 process table (one PowerShell, about half a second); empty when PowerShell is refused. */
export function scanWinProcesses(run: (file: string, args: string[]) => Promise<string> = execText): Promise<ProcRow[]> {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS_TABLE]).then(parseWinProcessTable, () => [])
}

export interface PortListener {
  port: number
  pid: number
}

/** `netstat -ano -p tcp`'s LISTENING rows (v4; `-p tcpv6` prints the v6 ones the same way). */
export function parseNetstat(text: string): PortListener[] {
  const out: PortListener[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5 || !/^TCP/i.test(cols[0]!) || cols[3] !== 'LISTENING') continue
    const port = Number(cols[1]!.slice(cols[1]!.lastIndexOf(':') + 1))
    const pid = Number(cols[4])
    const key = `${port}/${pid}`
    if (!Number.isInteger(port) || !Number.isInteger(pid) || seen.has(key)) continue
    seen.add(key)
    out.push({ port, pid })
  }
  return out
}

/** The host's TCP listeners on win32, v4 and v6. */
export async function winListeners(run: (file: string, args: string[]) => Promise<string> = execText): Promise<PortListener[]> {
  const [v4, v6] = await Promise.all([run('netstat.exe', ['-ano', '-p', 'tcp']).catch(() => ''), run('netstat.exe', ['-ano', '-p', 'tcpv6']).catch(() => '')])
  return parseNetstat(`${v4}\n${v6}`)
}

function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout))))
  )
}
