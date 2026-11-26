import type { ReactNode } from "react";

/**
 * A setting's value as words, in a control's place, for a key that may read the set but not change it: the row
 * still says what applies, in the muted ink a computer's page gives a value it may not change (`ThreadsRows`), and
 * the page's one `ManagedLine` says who can.
 */
export function ValueWords({ children }: { children: ReactNode }) {
  return (
    <span data-value-words="" className="text-xs text-muted-foreground">
      {children}
    </span>
  );
}
