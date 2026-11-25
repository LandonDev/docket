/**
 * A phone's attempt key carries when it was made (`phone-<ms>-<uuid>`, the phone's `PendingPress.newAttempt`). A key
 * older than the host keeps a key's answer is expired: its answer may have been pruned, so its read is unknown, never
 * "never heard", and a repeat of it is refused, never run as new. A key in an older form carries no time: unchanged.
 */
export function attemptExpired(attempt: string, now: number, keptMs: number): boolean {
  const made = /^phone-(\d{13})-/.exec(attempt)
  return !!made && now - Number(made[1]) >= keptMs
}
