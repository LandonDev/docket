import type { CanvasKind } from "@shared/work";
import { Progress } from "../../components/ui/progress";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import type { Fetch } from "./fetched";
import { ItemBones } from "./ItemBones";

/** From this size a fetch shows how far it got; a smaller file lands before a bar would read. */
export const SHOW_PROGRESS_FROM = 1024 * 1024;

/** The kind as the failure names it: "Couldn't open this PDF". */
const NOUN: Partial<Record<CanvasKind, string>> = { pdf: "PDF", sheet: "sheet", document: "document", slides: "deck", meeting: "recording" };

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

/** "2.1 of 8.4 MB" */
export const progressWords = (received: number, total: number): string => `${mb(Math.min(received, total))} of ${mb(total)} MB`;

/**
 * A fetched item before its kind opens it: the document's bones while the
 * bytes come, the first line a bar with how much has come for a big file;
 * a fetch that failed says so with Retry, never bones.
 */
export function FetchState({ fetch, kind, name, onRetry }: { fetch: Exclude<Fetch, { phase: "ready" }>; kind: CanvasKind; name: string; onRetry(): void }) {
  if (fetch.phase === "failed") return <EmptyState title={`Couldn't open this ${NOUN[kind] ?? "file"}`} line={fetch.message} action={{ label: "Retry", onClick: onRetry }} />;
  const total = fetch.total;
  const big = total !== null && total >= SHOW_PROGRESS_FROM;
  return (
    <div data-canvas-skeleton data-fetching className="px-6 pt-8">
      <ItemBones
        title={
          big ? (
            <div className="flex h-3 w-1/2 min-w-48 items-center gap-2">
              <Progress aria-label={`Getting ${name}`} value={fetch.received} max={total} className="flex-1" />
              <span className="shrink-0 text-xs leading-none text-muted-foreground tabular-nums">{progressWords(fetch.received, total)}</span>
            </div>
          ) : undefined
        }
      />
    </div>
  );
}
