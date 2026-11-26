import { Skeleton } from "../../components/ui/skeleton";

/**
 * The page's bones, at its own insets and in its shape: the title and its line, then people, then a section of rows.
 * Kept apart from the view so the frame draws them while the view's chunk is still on its way (work/shell/WorkViewPage.tsx
 * `bones`), and the page's own wait draws the same.
 */
export function PrepSkeleton() {
  return (
    <div aria-busy className="mx-auto flex w-full max-w-[720px] flex-col ps-7 pe-6 py-6">
      <Skeleton className="h-4 w-[34%]" />
      <Skeleton className="mt-2.5 h-3 w-[46%]" />
      <div className="mt-8 flex flex-col gap-3">
        <Skeleton className="h-3 w-[9%]" />
        {[38, 30, 44].map((w, i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="size-6 rounded-full" />
            <Skeleton className="h-3" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-8 flex flex-col gap-3">
        <Skeleton className="h-3 w-[7%]" />
        <Skeleton className="h-3 w-[58%]" />
        <Skeleton className="h-3 w-[42%]" />
      </div>
    </div>
  );
}
