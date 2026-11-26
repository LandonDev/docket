import { useState, type ReactNode } from "react";

/**
 * `children` while `on`; once it has been on in this window, `kept` after it
 * goes off. The root holds Work's half of the rail in one (work/shell/
 * WorkRailHost.tsx) with the Clash dialog's host as `kept`, so a clash open
 * when Work goes off on every host stays and says so rather than closing under
 * him. Nothing mounts before the first on, so nothing of Work enters the first
 * paint.
 */
export function OnceOnSlot({ on, kept, children }: { on: boolean; kept: ReactNode; children: ReactNode }) {
  const [seen, setSeen] = useState(on);
  if (on && !seen) setSeen(true);
  return on ? children : seen ? kept : null;
}
