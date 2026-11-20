/**
 * A recorded stream played as a live one (docs/agents/ios-client.md, the video proof set): the box engine's own
 * frames (scripts/fixtures/ios-test-server/box-stream.nsl1, one NSL1 message after another) sent to a viewer at about
 * 120 a second, again and again. Each pass is a new generation that starts on the file's keyframe, its sequences
 * 1, 2, 3 … as the file numbers them, and its capture times stamped now; acks are counted.
 */
import { readFileSync } from 'node:fs'
import type { FeedSink, VideoFeed } from '../../src/main/server/video/feed'
import { HEADER_SIZE } from '../../src/shared/video/nsl1'

/** The messages of a recorded stream file. */
export function recordedMessages(path: string): Uint8Array[] {
  const bytes = new Uint8Array(readFileSync(path))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Uint8Array[] = []
  for (let at = 0; at + HEADER_SIZE <= bytes.byteLength; ) {
    const size = HEADER_SIZE + view.getUint32(at + 16)
    out.push(bytes.slice(at, at + size))
    at += size
  }
  return out
}

/** One message of a pass: the generation and sequence it goes out under, and the capture time, set; a copy. */
export function restamped(message: Uint8Array, generation: number, sequence: number, captureMicros: bigint): Uint8Array {
  const out = new Uint8Array(message)
  const view = new DataView(out.buffer)
  view.setUint32(8, generation)
  view.setUint32(12, sequence)
  view.setBigUint64(HEADER_SIZE + 4, captureMicros)
  return out
}

export class LoopFeed implements VideoFeed {
  acks = 0
  sent = 0
  closed = false
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly messages: readonly Uint8Array[],
    private readonly fps = 120
  ) {}

  start(sink: FeedSink): void {
    if (this.closed || !this.messages.length) return
    let generation = 1
    let index = 0
    const started = process.hrtime.bigint()
    // a tick sends every frame that is due, so a late timer catches up instead of slowing the stream
    this.timer = setInterval(() => {
      const due = Math.floor((Number(process.hrtime.bigint() - started) / 1e9) * this.fps)
      while (this.sent < due && !this.closed) {
        sink.frame(restamped(this.messages[index], generation, index + 1, process.hrtime.bigint() / 1000n))
        this.sent++
        index++
        if (index === this.messages.length) {
          index = 0
          generation++
        }
      }
    }, 4)
  }

  ack(): void {
    this.acks++
  }

  input(): void {}
  release(): void {}

  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
