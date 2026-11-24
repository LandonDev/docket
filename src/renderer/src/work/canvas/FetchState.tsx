import type { CanvasKind } from "@shared/work";
import { Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { Progress } from "../../components/ui/progress";
import { workErrorWords } from "../../lib/workErrorWords";
import type { Fetch } from "./fetched";
import { ItemBones } from "./ItemBones";

/** From this size a fetch shows how far it got; a smaller file lands before a bar would read. */
export const SHOW_PROGRESS_FROM = 1024 * 1024;

/** The kind as the failure names it: "Couldn't open this PDF". */
const NOUN: Partial<Record<CanvasKind, string>> = { pdf: "PDF", sheet: "sheet", document: "document", slides: "deck", meeting: "meeting", dashboard: "dashboard", form: "form", browser: "page" };
export const kindNoun = (kind: CanvasKind): string => NOUN[kind] ?? "file";

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

/** "2.1 of 8.4 MB" */
export const progressWords = (received: number, total: number): string => `${mb(Math.min(received, total))} of ${mb(total)} MB`;

/**
 * A viewer with nothing to show (docs/DESIGN.md "The canvas pane"): the centred `Empty` with the kind in its title,
 * the reason when there is one, and Retry; never a red line over a blank pane. The state line is for a source that
 * dropped while the content stays.
 */
export function OpenFailed({ kind, why, onRetry }: { kind: CanvasKind; why?: string | undefined; /** absent where trying again cannot help (a file he must export first) */ onRetry?: (() => void) | undefined }) {
  // A host's reason in his words (`workErrorWords`): a raw line says nothing, and the title stands alone.
  const said = why ? workErrorWords(why) : "";
  return (
    <Empty data-canvas-failed>
      <EmptyHeader>
        <EmptyTitle>{`Couldn't open this ${kindNoun(kind)}`}</EmptyTitle>
        {said ? <EmptyDescription>{said}</EmptyDescription> : null}
      </EmptyHeader>
      {onRetry ? (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </Empty>
  );
}

/**
 * A fetched item before its kind opens it: the document's bones while the
 * bytes come, the first line a bar with how much has come for a big file;
 * a fetch that failed says so with Retry, never bones.
 */
export function FetchState({ fetch, kind, name, onRetry }: { fetch: Exclude<Fetch, { phase: "ready" }>; kind: CanvasKind; name: string; onRetry(): void }) {
  if (fetch.phase === "failed") return <OpenFailed kind={kind} why={fetch.message} onRetry={onRetry} />;
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
