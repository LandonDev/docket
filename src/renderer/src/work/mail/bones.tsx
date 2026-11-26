import { Skeleton } from "../../components/ui/skeleton";
import { SurfaceSkeleton } from "../../surfaces/SurfaceSkeleton";

/**
 * Mail's bones, kept apart from its view so the frame can draw them while the view's chunk is still on its way
 * (work/shell/WorkViewPage.tsx `bones`): the same frame the session's wait draws, so a cold open moves nothing.
 */

/** The list's width: its default, its bounds, and where the app keeps it. */
export const LIST_WIDTH = { base: 296, min: 260, max: 480, key: "tc.mail.listWidth" } as const;

export const clampList = (width: number): number => Math.min(LIST_WIDTH.max, Math.max(LIST_WIDTH.min, Math.round(width)));

export function readListWidth(): number {
  try {
    const kept = Number(localStorage.getItem(LIST_WIDTH.key));
    return kept ? clampList(kept) : LIST_WIDTH.base;
  } catch {
    return LIST_WIDTH.base;
  }
}

/** While the session opens: the list's rows beside the reading pane's head and lines, the frame Mail lands in. */
export function MailBones() {
  return (
    <div role="status" aria-label="Loading Mail" aria-busy className="@container/mail flex h-full min-h-0 select-none">
      <div style={{ width: readListWidth() }} className="flex shrink-0 flex-col border-r border-border @max-[40rem]/mail:w-full! @max-[40rem]/mail:border-r-0">
        <SurfaceSkeleton kind="rows" count={8} />
      </div>
      <div className="min-w-0 flex-1 px-8 pt-8 @max-[40rem]/mail:hidden">
        <Skeleton className="h-4 w-64 max-w-full" />
        <Skeleton className="mt-2 h-3 w-40" />
        <div className="mt-6 flex flex-col gap-3">
          <Skeleton className="h-3 w-[88%]" />
          <Skeleton className="h-3 w-[72%]" />
          <Skeleton className="h-3 w-[80%]" />
        </div>
      </div>
    </div>
  );
}
