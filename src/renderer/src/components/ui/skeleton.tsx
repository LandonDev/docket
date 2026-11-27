import type { ComponentProps } from "react";
import { cn } from "@renderer/lib/cn";

/** The hand-drawn bone, on its way out: a still block on the `skeleton`
 *  token. Loading states are drawn by Skullet now (components/bones.tsx;
 *  docs/agents/loading-bones.md), and only the folders that
 *  lib/bonesGuard.test.ts still holds may import this. It goes with the last
 *  of them. */
function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn("rounded-md bg-skeleton", className)} {...props} />;
}

export { Skeleton };
