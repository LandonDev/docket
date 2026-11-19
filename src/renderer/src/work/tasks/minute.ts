import { useEffect, useState } from "react";

/** The time, moved on at each minute's boundary: a due time turns red, and a past event greys, within the minute. */
export function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(Date.now()), 60_000 - (now % 60_000));
    return () => window.clearTimeout(timer);
  }, [now]);
  return now;
}
