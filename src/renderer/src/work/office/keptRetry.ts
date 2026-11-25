import { useState } from "react";

/**
 * Retry on a read that clears its failure when asked again (`useHostRead`): while the read he asked for is out, the
 * row keeps its failed line with Retry spinning in place, never its bones, until the answer replaces it. `out` is
 * true while the read has neither a value nor a failure. Only his press keeps the line; a read the row starts by
 * itself draws its own loading state.
 */
export function useKeptRetry(error: string | null, out: boolean): { error: string | null; retrying: boolean; press(retry: () => void): void } {
  const [press, setPress] = useState<{ error: string; seen: boolean } | null>(null);
  // The press is answered once its read has gone out and come back, with a value or a failure.
  if (press && !press.seen && out) setPress({ ...press, seen: true });
  else if (press?.seen && !out) setPress(null);
  return {
    error: error ?? press?.error ?? null,
    retrying: press !== null,
    press(retry) {
      if (error !== null) setPress({ error, seen: false });
      retry();
    },
  };
}
