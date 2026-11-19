import type { ReactNode } from "react";
import { Skeleton } from "../../components/ui/skeleton";

/** A document's bones at its measure (a 52px gutter, a 672px text column), centred as the document is: a title, then three lines. */
export function ItemBones({ title }: { title?: ReactNode }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="mx-auto flex max-w-[724px] flex-col gap-2.5 pl-[52px]">
      {title ?? <Skeleton className="h-3 w-1/3" />}
      <Skeleton className="mt-4 h-3 w-[92%]" />
      <Skeleton className="h-3 w-[78%]" />
      <Skeleton className="h-3 w-[44%]" />
    </div>
  );
}

/** A loading item, in a document's shape and at the document's scroller's insets, so the kind's own bones take its place without moving. */
export function ItemSkeleton() {
  return (
    <div data-canvas-skeleton className="px-6 pt-8">
      <ItemBones />
    </div>
  );
}
