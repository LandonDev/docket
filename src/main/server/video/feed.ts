import type { VideoCloseReason } from '@shared/contract-video'
import { MESSAGE_TYPES, encodeFrame, parseHeader, type Frame } from '@shared/video/nsl1'

/**
 * A feed is one viewer's stream at its source: the box's engine
 * (work/browser/box/engineFeed.ts), a window in tc-computer
 * (computer/videoFeed.ts), or a socket another host dialed in to publish
 * (video/published.ts). The relay joins it to the viewer's socket and reads
 * nothing but a message's type.
 */
export interface FeedSink {
  /** one whole NSL1 frame message, passed on as it is */
  frame(bytes: Uint8Array): void
  /** the source ended the stream; the viewer's socket closes with this reason */
  end(reason: VideoCloseReason): void
}

export interface VideoFeed {
  /** Frames flow to the sink from here until `close`, or until the sink is told the end. Called once. */
  start(sink: FeedSink): void
  /** The viewer's ack of one frame, as it came: the encoder reads the true link from these. */
  ack(bytes: Uint8Array): void
  /** One input message of his. The relay calls it only for a `drive` stream while he is the driver. */
  input(bytes: Uint8Array): void
  /** The viewer is gone or the stream was ended. Safe to call twice, and before `start`. */
  close(): void
}

/** A feed a test or a proof drives by hand: frames out, and what came back. */
export class FakeFeed implements VideoFeed {
  readonly acks: Uint8Array[] = []
  readonly inputs: Uint8Array[] = []
  started = false
  closed = false
  private sink: FeedSink | null = null
  private sequence = 0

  constructor(readonly generation = 1) {}

  start(sink: FeedSink): void {
    this.started = true
    this.sink = sink
  }
  ack(bytes: Uint8Array): void {
    this.acks.push(bytes)
  }
  input(bytes: Uint8Array): void {
    this.inputs.push(bytes)
  }
  close(): void {
    this.closed = true
    this.sink = null
  }

  /** Sends one frame of `size` bytes (a keyframe first), and answers its sequence. */
  push(frame: Partial<Frame> & { size?: number } = {}): number {
    const sequence = ++this.sequence
    const data = frame.data ?? new Uint8Array(frame.size ?? 64).fill(sequence & 0xff)
    this.sink?.frame(
      encodeFrame({ generation: this.generation, sequence, keyframe: sequence === 1, width: 1280, height: 800, timestamp: Date.now() * 1000, ...frame, data })
    )
    return sequence
  }
  /** Sends bytes as they are: a message the relay must not pass on. */
  raw(bytes: Uint8Array): void {
    this.sink?.frame(bytes)
  }
  finish(reason: VideoCloseReason): void {
    this.sink?.end(reason)
  }
  /** The sequences the viewer acked, in the order they arrived. */
  acked(): number[] {
    return this.acks.map((bytes) => parseHeader(bytes).sequence)
  }
}

/** True for a frame message: all a relay passes to a viewer. */
export const isFrame = (bytes: Uint8Array): boolean => bytes.byteLength > 5 && bytes[5] === MESSAGE_TYPES.frame
