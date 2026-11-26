import type { ComponentProps } from "react";
import { cn } from "@renderer/lib/cn";

/** A loading placeholder shaped like the content it stands in for: a
 *  still block on the `skeleton` token (the muted fill in dark, a wash of
 *  foreground in light, where muted vanishes on the rail and a card). Only text being produced pulses (docs/DESIGN.md). */
function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn("rounded-md bg-skeleton", className)} {...props} />;
}

export { Skeleton };
