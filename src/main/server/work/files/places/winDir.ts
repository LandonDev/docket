import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileCs, defaultCsc } from '../../../procTree'

/**
 * A folder on a mapped or network drive read in one go, its rows' sizes and times with it (docs/agents/work-files.md
 * "A mapped drive"). Node's directory read on Windows keeps the names and drops what Windows answered with them, so
 * each row's size was one more look, a few round trips over the link apiece: 300 rows over a VPN were seconds. .NET's
 * folder read keeps them, so a few lines of C#, compiled once with the csc.exe every Windows carries (as procTree's
 * job helper is), answer a whole folder from the same answers Windows already had. One helper process for the app,
 * started when Files first lists such a drive; each folder a line in and a line out, several at once.
 *
 * Nothing here decides who may read what: the caller passed the fence before it asks.
 */

export const DIR_HELPER_CS = String.raw`
using System;
using System.IO;
using System.Text;
using System.Threading;

static class TcDir {
  static readonly object Gate = new object();
  static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
  static StreamWriter Out;

  static void Main() {
    Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    string line;
    while ((line = input.ReadLine()) != null) {
      int tab = line.IndexOf('\t');
      if (tab <= 0) continue;
      long id;
      if (!long.TryParse(line.Substring(0, tab), out id)) continue;
      string path = line.Substring(tab + 1);
      ThreadPool.QueueUserWorkItem(delegate { Answer(id, path); });
    }
  }

  static void Answer(long id, string path) {
    var sb = new StringBuilder();
    try {
      sb.Append("{\"id\":").Append(id).Append(",\"rows\":[");
      bool first = true;
      foreach (FileSystemInfo e in new DirectoryInfo(path).EnumerateFileSystemInfos()) {
        bool dir = (e.Attributes & FileAttributes.Directory) != 0;
        long size = dir ? 0 : ((FileInfo)e).Length;
        long ms = (long)(e.LastWriteTimeUtc - Epoch).TotalMilliseconds;
        if (!first) sb.Append(',');
        first = false;
        sb.Append("[\"").Append(Escape(e.Name)).Append("\",").Append(dir ? 1 : 0).Append(',').Append(size).Append(',').Append(ms).Append(',').Append((long)e.Attributes).Append(']');
      }
      sb.Append("]}");
    } catch (Exception ex) {
      sb.Length = 0;
      sb.Append("{\"id\":").Append(id).Append(",\"error\":\"").Append(Escape(ex.GetType().Name + ": " + ex.Message)).Append("\"}");
    }
    lock (Gate) {
      Out.Write(sb.ToString());
      Out.Write('\n');
      Out.Flush();
    }
  }

  static string Escape(string s) {
    var b = new StringBuilder(s.Length + 8);
    foreach (char c in s) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.ToString();
  }
}
`

/** One row as the helper answers it: name, folder (1), size, change time (epoch ms), Windows' attribute bits. */
export type WinDirRow = [name: string, dir: 0 | 1, size: number, changed: number, attributes: number]

/** A link (a symlink or a junction): never followed, never listed. */
export const REPARSE_POINT = 0x400
/** Bits Windows sets on a file whose bytes are elsewhere (a cloud placeholder, an offline file): reading it downloads it. */
export const NOT_HERE_BITS = 0x1000 | 0x40000 | 0x400000

/** How long one folder may take before its read counts as failed: a drive that hangs is the reach check's to say. */
export const DIR_READ_MS = 20_000

export interface WinDirDeps {
  exe?: string
  csc?: string
  spawnHelper?: (exe: string) => ChildProcess
  compile?: (csc: string, source: string, out: string) => Promise<void>
  log?: (line: string) => void
}

/** The helper of this app: compiled on first use, one process, a read a line. Null answers: no helper here, read the slow way. */
export class WinDirHost {
  private ready: Promise<ChildProcess | null> | null = null
  private next = 1
  private readonly waiting = new Map<number, { done: (rows: WinDirRow[]) => void; fail: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  /** Set once the helper could not be made: every read is the slow way until the app restarts. */
  private broken = false

  constructor(private readonly deps: WinDirDeps = {}) {}

  /** Start the helper now, so the first folder does not wait for the compile. */
  warm(): void {
    void this.start()
  }

  /** A folder's rows, or null when the helper is not to be had (the caller reads the folder itself). */
  async read(dir: string, signal?: AbortSignal): Promise<WinDirRow[] | null> {
    const helper = await this.start()
    if (!helper?.stdin || helper.stdin.destroyed) return null
    const id = this.next++
    return new Promise<WinDirRow[]>((done, fail) => {
      const timer = setTimeout(() => this.settle(id, new Error('The folder did not answer in time.')), DIR_READ_MS)
      timer.unref?.()
      this.waiting.set(id, { done, fail, timer })
      signal?.addEventListener('abort', () => this.settle(id, new Error('cancelled')), { once: true })
      helper.stdin!.write(`${id}\t${dir}\n`)
    })
  }

  private settle(id: number, err: Error | null, rows?: WinDirRow[]): void {
    const w = this.waiting.get(id)
    if (!w) return
    this.waiting.delete(id)
    clearTimeout(w.timer)
    if (err) w.fail(err)
    else w.done(rows!)
  }

  private start(): Promise<ChildProcess | null> {
    if (this.broken) return Promise.resolve(null)
    this.ready ??= (async () => {
      const log = this.deps.log ?? ((line: string) => console.log(`[files] ${line}`))
      const exe = this.deps.exe ?? join(tmpdir(), `tempcode-dir-${createHash('sha256').update(DIR_HELPER_CS).digest('hex').slice(0, 12)}.exe`)
      try {
        if (!existsSync(exe)) {
          const tmp = `${exe}.${process.pid}.tmp.exe`
          try {
            await (this.deps.compile ?? compileCs)(this.deps.csc ?? defaultCsc(), DIR_HELPER_CS, tmp)
            renameSync(tmp, exe)
          } catch (err) {
            // Another instance compiled the same helper first: use that one.
            if (!existsSync(exe)) throw err
          } finally {
            rmSync(tmp, { force: true })
          }
        }
        const helper = (this.deps.spawnHelper ?? spawnDirHelper)(exe)
        let buffer = ''
        helper.stdout?.setEncoding('utf8')
        helper.stdout?.on('data', (chunk: string) => {
          buffer += chunk
          for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
            const line = buffer.slice(0, nl)
            buffer = buffer.slice(nl + 1)
            try {
              const got = JSON.parse(line) as { id: number; rows?: WinDirRow[]; error?: string }
              this.settle(got.id, got.error ? new Error(got.error) : null, got.rows ?? [])
            } catch {
              log(`folder helper: an answer that is not one (${line.slice(0, 80)})`)
            }
          }
        })
        const lost = (why: string): void => {
          if (this.ready === null) return
          log(`folder helper ${why}`)
          this.ready = null
          for (const id of [...this.waiting.keys()]) this.settle(id, new Error('The folder helper stopped.'))
        }
        helper.on('error', (err) => lost(`failed: ${err.message}`))
        helper.stdin?.on('error', () => undefined)
        helper.once('exit', (code) => lost(`exited (${code})`))
        return helper
      } catch (err) {
        log(`no folder helper (each row is looked at): ${err instanceof Error ? err.message : String(err)}`)
        this.broken = true
        return null
      }
    })()
    return this.ready
  }
}

function spawnDirHelper(exe: string): ChildProcess {
  const helper = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  // Never holds the app open: its stdin closing at exit ends it.
  helper.unref()
  ;(helper.stdout as unknown as { unref?: () => void } | null)?.unref?.()
  ;(helper.stdin as unknown as { unref?: () => void } | null)?.unref?.()
  return helper
}

let host: WinDirHost | null = null
/** The app's one helper (Windows only); a test passes its own. */
export const winDirHost = (): WinDirHost => (host ??= new WinDirHost())
export const setWinDirHost = (h: WinDirHost | null): void => void (host = h)
