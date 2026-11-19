import { connect, type Socket } from 'node:net'

export interface QmpCommand {
  execute: string
  arguments?: Record<string, unknown>
}

/**
 * QEMU's machine protocol over its unix socket: one JSON object per line. The server greets, the client
 * sends qmp_capabilities, then each command gets one `return` or `error`; `event` lines come in between.
 */
export class Qmp {
  private buf = ''
  private waiters: { resolve: (v: unknown) => void; reject: (e: Error) => void }[] = []
  private greeted: Promise<void>
  private closed: Error | null = null

  private constructor(private sock: Socket) {
    let greet!: () => void
    this.greeted = new Promise((r) => (greet = r))
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      this.buf += chunk
      let nl: number
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (!line) continue
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if ('QMP' in msg) greet()
        else if ('return' in msg) this.waiters.shift()?.resolve(msg.return)
        else if ('error' in msg) {
          const e = msg.error as { class?: string; desc?: string }
          this.waiters.shift()?.reject(new Error(`QMP ${e.class ?? 'error'}: ${e.desc ?? line}`))
        }
      }
    })
    const fail = (e: Error) => {
      this.closed ??= e
      for (const w of this.waiters.splice(0)) w.reject(e)
    }
    sock.on('error', fail)
    sock.on('close', () => fail(new Error('QMP socket closed')))
  }

  static async open(path: string, timeoutMs = 5000): Promise<Qmp> {
    const sock = connect(path)
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', resolve)
      sock.once('error', reject)
    })
    const q = new Qmp(sock)
    try {
      await withTimeout(q.greeted, timeoutMs, 'QMP greeting')
      await q.run({ execute: 'qmp_capabilities' }, timeoutMs)
    } catch (e) {
      // QEMU serves one QMP client at a time: an abandoned socket left open would hold the line for good.
      sock.destroy()
      throw e
    }
    return q
  }

  run(cmd: QmpCommand, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed)
    const answer = new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject })
      this.sock.write(JSON.stringify(cmd) + '\n')
    })
    return withTimeout(answer, timeoutMs, `QMP ${cmd.execute}`)
  }

  close(): void {
    this.sock.end()
  }

  destroy(): void {
    this.sock.destroy()
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms).unref())])
}

/** Runs commands on a fresh connection and closes it. */
export async function qmp(path: string, ...cmds: QmpCommand[]): Promise<unknown[]> {
  const q = await Qmp.open(path)
  try {
    const out: unknown[] = []
    for (const c of cmds) out.push(await q.run(c))
    return out
  } finally {
    q.destroy()
  }
}

export const screendump = (filename: string): QmpCommand => ({ execute: 'screendump', arguments: { filename, format: 'png' } })
export const sendKey = (...keys: string[]): QmpCommand => ({ execute: 'send-key', arguments: { keys: keys.map((data) => ({ type: 'qcode', data })) } })
export const powerdown: QmpCommand = { execute: 'system_powerdown' }
export const quit: QmpCommand = { execute: 'quit' }
