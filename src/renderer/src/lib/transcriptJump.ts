/**
 * Scroll-to-row requests for a transcript that may not be mounted yet.
 *
 * A search hit names a thread by session id and a row by the event log
 * `seq` it came from. The thread opens through the normal path (which may
 * fetch its history first), so the request waits here until that thread's
 * AgentTranscript mounts, sees its blocks, and claims it with `take`. The
 * transcript's own scroll engine does the moving — this file only carries
 * the intent across the open.
 */

export type TranscriptJump = { sessionId: string; seq: number };

let pending: TranscriptJump | null = null;
const listeners = new Set<() => void>();

export function requestTranscriptJump(sessionId: string, seq: number): void {
  pending = { sessionId, seq };
  for (const fn of listeners) fn();
}

/** The waiting request for this session, if any; peek without consuming. */
export function pendingTranscriptJump(sessionId: string): TranscriptJump | null {
  return pending?.sessionId === sessionId ? pending : null;
}

/** Consume the request once the transcript has scrolled to it. */
export function takeTranscriptJump(sessionId: string): TranscriptJump | null {
  const jump = pendingTranscriptJump(sessionId);
  if (jump) pending = null;
  return jump;
}

export function subscribeTranscriptJump(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** What a jump asks of the store (lib/tcserver/store.ts) to reach an older row. */
export type OlderReach = {
  olderBefore(id: string): number | null;
  loadOlder(id: string, through?: number): Promise<boolean>;
};

const paging = new WeakSet<TranscriptJump>();

/**
 * A hit older than the loaded rows (a remote thread's tail): the history
 * pages in until its row is in, through one bounded run of the store's
 * (`loadOlder(id, seq)`, at most JUMP_PAGES pages); the transcript lands
 * on the row when its blocks change. When the run ends short of the row
 * (past the bound, or a failed ask) the request is dropped and the thread
 * stays as it is. Answers whether the jump waits on older rows.
 */
export function pageTowardJump(jump: TranscriptJump, store: OlderReach): boolean {
  const before = store.olderBefore(jump.sessionId);
  if (before === null || before <= jump.seq) return false;
  if (paging.has(jump)) return true;
  paging.add(jump);
  const end = (): void => {
    const left = store.olderBefore(jump.sessionId);
    if (pending === jump && left !== null && left > jump.seq) pending = null;
  };
  void store.loadOlder(jump.sessionId, jump.seq).then(end, end);
  return true;
}

/** The prose block that holds event row `seq`: a user row is its own block;
 *  an assistant stream's final row belongs to the block its first row began.
 *  So: the last user/assistant block born at or before `seq`. */
export function blockForSeq<T extends { role: string; seq?: number }>(
  blocks: readonly T[],
  seq: number,
): T | null {
  let found: T | null = null;
  for (const block of blocks) {
    if (block.seq === undefined) continue;
    if (block.role !== "user" && block.role !== "assistant") continue;
    if (block.seq > seq) break;
    found = block;
  }
  return found;
}
