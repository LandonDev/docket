/**
 * One Mail write's own answer, for a screen that must not say the change happened before LifeOS took it (the mail
 * chat's rows card: "Archived 3" only once the write came back). work-kit's acts answer nothing (`MailActions`), so the
 * answer rides on the write itself: `answerOf` runs an act, and the first write that act starts through `write`
 * (client.ts) hands back what it came to.
 */
export type WriteAnswer = { ok: true; /** settles once the write's Undo went through; absent when it has none */ undone?: Promise<void> } | { ok: false; error: unknown };

let slot: ((answer: Promise<WriteAnswer>) => void) | null = null;

/**
 * Runs `act`, which starts one write, and answers with that write's outcome. An act that started no write through
 * `write` (a stand-in client) answers ok once it returns: there is nothing to wait on.
 */
export function answerOf(act: () => void): Promise<WriteAnswer> {
  let answer: Promise<WriteAnswer> | null = null;
  slot = (p) => void (answer = p);
  try {
    act();
  } finally {
    slot = null;
  }
  return answer ?? Promise.resolve({ ok: true });
}

/** Called by `write` as it starts: the function it tells its outcome to, when an `answerOf` waits on it. */
export function claimAnswer(): ((answer: WriteAnswer) => void) | null {
  const take = slot;
  slot = null;
  if (!take) return null;
  let tell!: (answer: WriteAnswer) => void;
  take(new Promise<WriteAnswer>((resolve) => (tell = resolve)));
  return tell;
}
