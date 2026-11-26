import { thisDesktopInLine } from "../../../lib/native";
import type { ComputerName as Name } from "../../../lib/settings/computerName";

/** A computer's name where computers stand side by side: its own name, and for this window's own "this Mac" after it,
 *  muted and regular, 4px on (lib/settings/computerName.ts). */
export function ComputerName({ computer }: { computer: Name }) {
  return (
    <span data-slot="computer-name" className="inline-flex min-w-0 items-baseline gap-1">
      <span className="truncate">{computer.name}</span>
      {computer.own ? <span className="shrink-0 font-normal text-muted-foreground">{thisDesktopInLine()}</span> : null}
    </span>
  );
}
