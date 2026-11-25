/**
 * What one guest link may cost the box (docs/agents/work-guests.md "A link's budget"). A guest with an Edit
 * link holds a writer's token, and nothing else caps what a writer sends but the 4 MiB frame: so each link has a
 * budget of its own, counted where its frames pass (routes/guests.ts for a document, routes/sheet.ts for a
 * sheet), before the document or the sheet sees them.
 */

const MIB = 1024 * 1024

/** A link's budget; a test lowers them. */
export const BUDGET = {
  /** what a link may send at once, and how fast that comes back */
  bytes: 4 * MIB,
  bytesPerMinute: 1 * MIB,
  /** sockets one link holds at a time: a guest's few tabs */
  sockets: 8,
  /** past this a guest adds nothing more to a document; the owner still may */
  docBytes: 32 * MIB
}

/** The close a socket hears when its link is over budget; its reason ends with the seconds to wait ("… wait 42 s"). */
export const CLOSE_TOO_MUCH = 4429
/** The close a guest's write gets on a document that is as large as a guest may make it. */
export const CLOSE_FULL = 4413

/**
 * A bucket of bytes that fills at a steady rate: `take` answers 0 and spends, or the milliseconds until that many
 * are there and spends nothing. A take that had to wait holds the link (`held`) until then, so the tries a page
 * makes meanwhile cost one refused upgrade each, never another megabyte read.
 */
export class Bucket {
  private level: number
  private at: number
  private until = 0
  constructor(
    private readonly cap: number,
    private readonly perMs: number,
    now = Date.now()
  ) {
    this.level = cap
    this.at = now
  }
  private fill(now: number): void {
    this.level = Math.min(this.cap, this.level + Math.max(0, now - this.at) * this.perMs)
    this.at = now
  }
  take(n: number, now = Date.now()): number {
    this.fill(now)
    if (n <= this.level) {
      this.level -= n
      return 0
    }
    // More than the bucket ever holds is never there: the wait is for a full bucket, and the frame cap stops the rest.
    const wait = Math.ceil((Math.min(n, this.cap) - this.level) / this.perMs)
    this.until = now + wait
    return wait
  }
  /** Milliseconds a link that overdrew still has to wait; 0 when it may come back. */
  held(now = Date.now()): number {
    return Math.max(0, this.until - now)
  }
}

/** One bucket a key (a link), made on first use; at most `cap` keys, the oldest let go. */
export class Buckets {
  private readonly held = new Map<string, Bucket>()
  constructor(
    private readonly make: (now: number) => Bucket,
    private readonly cap = 5000
  ) {}
  of(key: string, now = Date.now()): Bucket {
    let b = this.held.get(key)
    if (!b) {
      while (this.held.size >= this.cap) this.held.delete(this.held.keys().next().value!)
      this.held.set(key, (b = this.make(now)))
    }
    return b
  }
  clear(): void {
    this.held.clear()
  }
}

/** The words a socket over budget is closed with: the page reads the seconds at the end. */
export const tooMuchWords = (waitMs: number): string => `too much at once: wait ${Math.max(1, Math.ceil(waitMs / 1000))} s`
/** The seconds in those words; null for any other reason. */
export const waitOf = (reason: string): number | null => {
  const m = /wait (\d{1,5}) s$/.exec(reason)
  return m ? Number(m[1]) : null
}
