import { connect, type Socket } from 'node:net'
import { vmHelper } from '../../winvm'
import { VM_ASLEEP } from '../../winvm/helperDoor'
import { OfficeError } from '../carrier'

/**
 * One call to the helper in the Windows VM (docs/agents/work-files.md "The Windows VM"): a
 * connection of its own through the keeper's forward, the token, the helper's `ready`, one request
 * and its answer. A connection per call, so a long download never holds a list, and nothing is kept
 * open across the machine's sleep.
 */

export interface VmCallOpts {
  /** the answer's deadline; default two minutes */
  timeoutMs?: number
  signal?: AbortSignal
  /** false: never wake the machine for this call; asleep, it fails with `VmAsleep` */
  wake?: boolean
}
export type VmCall = (verb: string, args?: Record<string, unknown>, opts?: VmCallOpts) => Promise<unknown>

/** The machine sleeps and the call may not wake it. */
export class VmAsleep extends Error {
  constructor() {
    super(VM_ASLEEP)
  }
}

/** The connection ended before the helper answered: the helper may be gone, so its door is checked again. */
class LinkDown extends Error {}

const CODES = new Set<OfficeError['code']>(['not-installed', 'not-running', 'not-allowed', 'needs-consent', 'not-found', 'busy', 'refused', 'failed'])

/** The helper's own stdin and stdout, as one socket: what the Windows carrier drives (com/carrier.ts `HelperProcess`). */
export async function helperSocket(door: { socket: string; token: string }): Promise<Socket> {
  const s = connect(door.socket)
  await new Promise<void>((resolve, reject) => {
    s.once('connect', resolve)
    s.once('error', reject)
  })
  s.write(`${door.token}\n`)
  return s
}

function once(door: { socket: string; token: string }, verb: string, args: Record<string, unknown>, opts: VmCallOpts): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const s = connect(door.socket)
    let buf = ''
    let ready = false
    let done = false
    const finish = (err: Error | null, value?: unknown) => {
      if (done) return
      done = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', aborted)
      s.destroy()
      if (err) reject(err)
      else resolve(value)
    }
    const aborted = () => finish(new Error('cancelled'))
    const timer = setTimeout(() => finish(new Error(`The Windows VM did not answer ${verb} in time.`)), opts.timeoutMs ?? 120_000)
    if (opts.signal?.aborted) return finish(new Error('cancelled'))
    opts.signal?.addEventListener('abort', aborted, { once: true })
    s.on('connect', () => s.write(`${door.token}\n`))
    s.setEncoding('utf8')
    s.on('data', (d: string) => {
      buf += d
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let f: { event?: string; id?: number; ok?: boolean; value?: unknown; error?: { code?: string; message?: string } }
        try {
          f = JSON.parse(line)
        } catch {
          continue
        }
        if (f.event === 'ready' && !ready) {
          ready = true
          s.write(JSON.stringify({ id: 1, verb, args }) + '\n')
        } else if (f.id === 1) {
          if (f.ok) finish(null, f.value)
          else finish(new OfficeError(f.error?.message || 'The helper in the Windows VM failed.', CODES.has(f.error?.code as OfficeError['code']) ? (f.error!.code as OfficeError['code']) : 'failed'))
        }
      }
    })
    s.on('error', (err) => finish(ready ? new Error(`The link to the Windows VM dropped: ${err.message}`) : new LinkDown(err.message)))
    s.on('close', () => finish(ready ? new Error('The link to the Windows VM dropped.') : new LinkDown('closed')))
  })
}

async function real(verb: string, args: Record<string, unknown> = {}, opts: VmCallOpts = {}): Promise<unknown> {
  const helper = vmHelper()
  const open = async () => {
    const door = opts.wake === false ? await helper.openIfAwake() : await helper.open()
    if (!door) throw new VmAsleep()
    return door
  }
  try {
    return await once(await open(), verb, args, opts)
  } catch (err) {
    if (!(err instanceof LinkDown)) throw err
    // The helper was not there (stopped, or the guest restarted): have its door made ready again, once.
    helper.doubt()
    try {
      return await once(await open(), verb, args, opts)
    } catch (again) {
      throw again instanceof LinkDown ? new Error('The helper in the Windows VM did not answer.') : again
    }
  }
}

let call: VmCall = real
/** A test's stand-in guest; null puts the real one back. */
export const setVmCall = (fn: VmCall | null): void => void (call = fn ?? real)
export const vmCall: VmCall = (verb, args, opts) => call(verb, args, opts)
