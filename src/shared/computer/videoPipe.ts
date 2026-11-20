import { HEADER_SIZE, MAGIC, MAX_MESSAGE_BYTES } from '../video/nsl1'
import { VIDEO_STREAM } from './protocol'

/**
 * The bytes pipe between the host and tc-computer (docs/computer-protocol.md
 * §30): the service's fourth stdio entry, both ways. A record is the stream's
 * number as four bytes, big-endian, then one whole NSL1 message, whose own
 * header says how long it is. The service sends frames; the host sends acks.
 * No frame waits behind a line of the JSON pipe, and none pays base64.
 */

export const PIPE_ID_BYTES = VIDEO_STREAM.pipeIdBytes
const RECORD_HEAD = PIPE_ID_BYTES + HEADER_SIZE

export class VideoPipeError extends Error {}

/** One record: the stream's number, then the message as it is. */
export function encodeRecord(stream: number, message: Uint8Array): Uint8Array {
  if (!Number.isInteger(stream) || stream < 1 || stream > 0xffffffff) throw new VideoPipeError('Invalid stream number')
  const out = new Uint8Array(PIPE_ID_BYTES + message.byteLength)
  new DataView(out.buffer).setUint32(0, stream)
  out.set(message, PIPE_ID_BYTES)
  return out
}

export interface PipeRecord {
  stream: number
  /** one whole NSL1 message: a copy, the reader's buffer moves on */
  message: Uint8Array
}

/**
 * Cuts the pipe's bytes into records as they come, in whatever pieces. A
 * record that does not start with a stream number and an NSL1 header, or
 * that names a message larger than the wire allows, throws: the pipe has
 * lost its place and cannot find it again.
 */
export class RecordReader {
  private buffer: Uint8Array = new Uint8Array(0)

  push(chunk: Uint8Array): PipeRecord[] {
    if (this.buffer.byteLength) {
      const joined = new Uint8Array(this.buffer.byteLength + chunk.byteLength)
      joined.set(this.buffer)
      joined.set(chunk, this.buffer.byteLength)
      this.buffer = joined
    } else this.buffer = chunk
    const out: PipeRecord[] = []
    let at = 0
    for (;;) {
      if (this.buffer.byteLength - at < RECORD_HEAD) break
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + at, RECORD_HEAD)
      const stream = view.getUint32(0)
      if (!stream || view.getUint32(PIPE_ID_BYTES) !== MAGIC) throw new VideoPipeError('The bytes pipe lost its place')
      const length = HEADER_SIZE + view.getUint32(PIPE_ID_BYTES + 16)
      if (length > MAX_MESSAGE_BYTES) throw new VideoPipeError('A message on the bytes pipe is larger than the wire allows')
      if (this.buffer.byteLength - at < PIPE_ID_BYTES + length) break
      out.push({ stream, message: this.buffer.slice(at + PIPE_ID_BYTES, at + PIPE_ID_BYTES + length) })
      at += PIPE_ID_BYTES + length
    }
    this.buffer = at === this.buffer.byteLength ? new Uint8Array(0) : this.buffer.slice(at)
    return out
  }
}
