/**
 * What a Work window asks a host when its link opens again (perf M10), in one lane per host, as the transcripts'
 * catch-up does (lib/tcserver/catchUp.ts): the shown view's ask goes at once, and every other one waits for it, then
 * goes in turn, one at a time. Before it, every Work store asked at once on each open: on the pair a reconnect sent 23
 * asks before a folder was current and 35 in the next second.
 *
 * Each ask still goes once per open, so every view reads what is true after a reconnect; only the order changes.
 */

/** The longest an ask in turn waits for the shown view's: a front that never settles never holds the rest. */
export const REOPEN_FRONT_WAIT_MS = 2_000;
/** The longest the lane waits on one ask in turn before the next goes: the slow one keeps going and settles itself. */
export const REOPEN_TURN_WAIT_MS = 10_000;

type Ask = () => unknown;

interface Lane {
  front: Set<Promise<unknown>>;
  waiting: Ask[];
  pumping: boolean;
}

const lanes = new Map<string, Lane>();
const laneOf = (env: string): Lane => {
  let lane = lanes.get(env);
  if (!lane) lanes.set(env, (lane = { front: new Set(), waiting: [], pumping: false }));
  return lane;
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const settled = (p: Promise<unknown>): Promise<void> => p.then(
  () => undefined,
  () => undefined,
);
const started = (ask: Ask): Promise<unknown> => {
  try {
    return Promise.resolve(ask());
  } catch (error) {
    return Promise.reject(error);
  }
};

async function pump(env: string, lane: Lane): Promise<void> {
  if (lane.pumping) return;
  lane.pumping = true;
  try {
    // (the asks of one open come together: the shown view's are in the front before any in turn goes)
    await Promise.resolve();
    while (lane.waiting.length) {
      if (lane.front.size) await Promise.race([Promise.all([...lane.front].map(settled)), wait(REOPEN_FRONT_WAIT_MS)]);
      const next = lane.waiting.shift()!;
      await Promise.race([settled(started(next)), wait(REOPEN_TURN_WAIT_MS)]);
    }
  } finally {
    lane.pumping = false;
    if (!lane.waiting.length && !lane.front.size) lanes.delete(env);
  }
}

/** Runs one ask in the host's lane: at once in the front when `shown`, else in turn. */
export function inReopenLane(env: string, ask: Ask, shown = false): void {
  const lane = laneOf(env);
  if (shown) {
    const going = settled(started(ask));
    lane.front.add(going);
    void going.then(() => lane.front.delete(going));
    return;
  }
  lane.waiting.push(ask);
  void pump(env, lane);
}

/**
 * A Work view's ask for each time its link opens again, through the host's lane. `shown`: whether the view is on
 * screen now (the front); a view not shown, or a store's background ask, waits its turn. Answers its off.
 */
export function onWorkReopen(link: { environmentId: string; onOpen(listener: () => void): () => void }, ask: Ask, shown: () => boolean = () => false): () => void {
  return link.onOpen(() => inReopenLane(link.environmentId, ask, shown()));
}

/** For tests: every lane forgotten. */
export function resetReopenLanes(): void {
  lanes.clear();
}
