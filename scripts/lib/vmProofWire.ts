import { createConnection, type NetConnectOpts, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { withinDeadline } from '../e2e-work-lib'

export type VmProofReply = { id?: number; ok: boolean; value?: any; error?: { code?: string; message?: string } }

/** The VM helper reads one JSON request per line, and sends ready before it takes requests. */
export class VmProofWire {
  private readonly down = new AbortController()
  private readonly ready = Promise.withResolvers<void>()
  private readonly waiting = new Map<number, (answer: VmProofReply) => void>()
  private id = 0
  private readonly lines: ReturnType<typeof createInterface>

  constructor(read: Readable, private readonly write: Writable) {
    this.lines = createInterface({ input: read, crlfDelay: Infinity })
    this.lines.on('line', (line) => {
      if (!line.trim()) return
      try {
        const reply = JSON.parse(line) as VmProofReply & { event?: string }
        if (reply.event === 'ready') this.ready.resolve()
        else if (typeof reply.id === 'number') this.waiting.get(reply.id)?.(reply)
      } catch (error) {
        this.down.abort(new Error('The VM helper sent an invalid line', { cause: error }))
      }
    })
    this.lines.once('close', () => this.down.abort(new Error('The VM helper closed its wire')))
    read.on('error', (error) => this.down.abort(error))
    this.lines.on('error', (error) => this.down.abort(error))
    if ((read as object) !== write) write.on('error', (error) => this.down.abort(error))
  }

  waitReady(ms = 15_000, parent?: AbortSignal): Promise<void> {
    return withinDeadline('the VM helper says ready', ms, () => this.ready.promise, parent ? AbortSignal.any([this.down.signal, parent]) : this.down.signal)
  }

  send(verb: string, args: Record<string, unknown> = {}): void {
    this.down.signal.throwIfAborted()
    this.write.write(JSON.stringify({ id: ++this.id, verb, args }) + '\n')
  }

  async call(verb: string, args: Record<string, unknown> = {}, ms = 60_000): Promise<VmProofReply> {
    const id = ++this.id
    try {
      return await withinDeadline(verb, ms, () => new Promise<VmProofReply>((resolve, reject) => {
        this.waiting.set(id, resolve)
        this.write.write(JSON.stringify({ id, verb, args }) + '\n', (error) => { if (error) reject(error) })
      }), this.down.signal)
    } finally {
      this.waiting.delete(id)
    }
  }

  close(): void {
    this.down.abort(new Error('Closed the VM helper proof wire'))
    this.lines.close()
  }
}

export async function openVmProofSocket(options: NetConnectOpts, parent?: AbortSignal): Promise<Socket> {
  const socket = createConnection(options)
  try {
    await withinDeadline('connect to the VM helper', 5000, () => new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
      socket.once('close', () => reject(new Error('The VM helper closed before connecting')))
    }), parent)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

export async function vmProofCall(path: string, token: string, verb: string, args: Record<string, unknown>, ms = 120_000): Promise<unknown> {
  const socket = await openVmProofSocket({ path })
  const wire = new VmProofWire(socket, socket)
  try {
    socket.write(token + '\n')
    await wire.waitReady()
    const answer = await wire.call(verb, args, ms)
    if (!answer.ok) throw new Error(answer.error?.message ?? `${verb} failed`)
    return answer.value
  } finally {
    wire.close()
    socket.destroy()
  }
}
