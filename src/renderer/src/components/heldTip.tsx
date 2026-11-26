import type { ReactElement } from "react";
import { Tip } from "./tip";

/**
 * A control held while its host's link is not open (D5): disabled by its owner, and wrapped here so its tooltip
 * says the host's state (`useHostHeld`, lib/connection/degraded.ts). A disabled button takes no pointer, so the
 * wrapper is the tooltip's trigger. Not held: the control as it is, nothing added.
 */
export function HeldTip({ held, className, children }: { held: string | null; className?: string; children: ReactElement }) {
  if (!held) return children;
  return (
    <Tip label={held}>
      <span data-held className={className ? `inline-flex ${className}` : "inline-flex"}>
        {children}
      </span>
    </Tip>
  );
}
