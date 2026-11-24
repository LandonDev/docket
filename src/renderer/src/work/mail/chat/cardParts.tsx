import { Skeleton } from "../../../components/ui/skeleton";

/** The card's shape while what it shows is on its way. */
export function CardBones() {
  return (
    <div role="status" aria-label="Loading" className={CARD}>
      <div className="flex h-9 items-center px-3">
        <Skeleton className="h-3 w-40" />
      </div>
      <div className="flex flex-col gap-2 px-3 pt-1 pb-3">
        <Skeleton className="h-3 w-[86%]" />
        <Skeleton className="h-3 w-[64%]" />
      </div>
    </div>
  );
}

/** One card in the transcript: 12px radius, a hairline, no card inside it. */
export const CARD = "tc-mail min-w-0 overflow-hidden rounded-xl border border-border bg-background";
/** A card's head: 36px, its title at 13px medium, its state at the end in 12px muted. */
export const HEAD = "flex h-9 items-center gap-2 px-3";
/** A card's foot: its presses, on a hairline. */
export const FOOT = "flex h-11 items-center gap-1.5 border-t border-border px-3";
