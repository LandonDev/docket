import type { ReactNode } from "react";
import { WaitHost, type HostWaitProps } from "work-kit/ui/wait";
import { Region } from "../components/bones";

/*
 * work-kit's screens (Mail, the sheet, Projects) say each wait through `Wait` (work-kit/ui/wait).
 * Under `KitWaits` every one of them is a Region: its bones measured from the kit's sample, or its
 * bars where it gives none, with the hold, the sweep and the reveal of every other wait in the app
 * (docs/agents/loading-bones.md "work-kit's screens"). Wrap each place that mounts a kit screen.
 */

function KitWait({ loading, drawing, label, fill, className, children }: HostWaitProps) {
  return (
    <Region loading={loading} bones={drawing} label={label} fill={fill} {...(className ? { className } : {})}>
      {children}
    </Region>
  );
}

export function KitWaits({ children }: { children: ReactNode }) {
  return <WaitHost wait={KitWait}>{children}</WaitHost>;
}
