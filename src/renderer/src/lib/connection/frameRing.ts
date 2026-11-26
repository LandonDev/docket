/**
 * The last frames the window handled, each with when its handling began and
 * ended (`performance.now()`, the long-task clock): a push by its name, an
 * answer by its request's method. Every socket's message handler writes one
 * slot a frame (transport.ts); the stall recorder asks which frame a long
 * task ran for (stallRecorder.ts `cause=`). Fixed arrays, so a frame costs
 * three writes and no allocation.
 */
export const FRAME_RING_SIZE = 32;

export interface FrameRing {
  /** A frame handled from `start` to `end`: `push:<name>` or `answer:<method>`. */
  note(kind: "push" | "answer", name: string, start: number, end: number): void;
  /** The newest frame whose handling overlaps `start..end`, as `push:<name>` or `answer:<method>`; else undefined. */
  overlapping(start: number, end: number): string | undefined;
}

export function createFrameRing(size = FRAME_RING_SIZE): FrameRing {
  const kinds: ("push" | "answer")[] = new Array(size).fill("push");
  const names: string[] = new Array(size).fill("");
  const starts = new Float64Array(size);
  const ends = new Float64Array(size);
  let next = 0;
  let filled = 0;
  return {
    note(kind, name, start, end) {
      kinds[next] = kind;
      names[next] = name;
      starts[next] = start;
      ends[next] = end;
      next = (next + 1) % size;
      if (filled < size) filled += 1;
    },
    overlapping(start, end) {
      for (let k = 1; k <= filled; k++) {
        const i = (next - k + size) % size;
        if (starts[i] <= end && ends[i] >= start) return `${kinds[i]}:${names[i]}`;
      }
      return undefined;
    },
  };
}

/** The window's one ring, shared by every link. */
export const frameRing = createFrameRing();
