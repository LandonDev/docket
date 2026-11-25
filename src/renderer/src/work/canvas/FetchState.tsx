import { createContext, useContext, useState } from "react";
import type { CanvasKind } from "@shared/work";
import { BusyLabel, Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../components/ui/empty";
import { Progress } from "../../components/ui/progress";
import { Spinner } from "../../components/ui/spinner";
import { registry } from "../../lib/connection/registry";
import { hostName } from "../../lib/threadResources";
import { workErrorWords } from "../../lib/workErrorWords";
import { DownEmpty, savedOfReason } from "../shell/DownEmpty";
import { refreshLifeos } from "../shell/lifeos";
import { useLiveDown } from "../shell/lifeosLive";
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

/** The environment the pane's item is on: set by `CanvasPane`, so a failure inside it can name the computer. */
export const FailedHost = createContext<string | null>(null);

/** That computer by the name the rail gives it in a line ("the box"); null where this window does not know it. */
const paneHost = (environmentId: string): string | null => (registry.environment(environmentId) ? hostName(environmentId) : null);

/**
 * A host's reason in his words (`workErrorWords`), naming the pane's computer: a link that is down says which is away.
 * A raw line answers "", so the title or the state's word stands alone.
 */
export function useFailedWords(why: string | null | undefined): string {
  const env = useContext(FailedHost);
  const host = why && env ? paneHost(env) : null;
  return why ? workErrorWords(why, host ? { host } : {}) : "";
}

/**
 * A viewer with nothing to show (docs/DESIGN.md "The canvas pane"): the centred `Empty` with the kind in its title,
 * the reason when there is one, and Retry; never a red line over a blank pane. The state line is for a source that
 * dropped while the content stays.
 */
export function OpenFailed({ kind, why, onRetry }: { kind: CanvasKind; why?: string | undefined; /** absent where trying again cannot help (a file he must export first); its promise, where it gives one, is the read again under way */ onRetry?: (() => void | Promise<unknown>) | undefined }) {
  const said = useFailedWords(why);
  // An open the pane's host could not make because its LifeOS session is down (a LifeOS document or sheet, a mail's
  // attachment, a dashboard read from a LifeOS sheet) says that session's state by the host's live status, with the
  // rule's press; Retry is for silence alone, and the item is asked again once the host says connected.
  const env = useContext(FailedHost);
  const saved = env ? savedOfReason(why) : null;
  const lifeos = useLiveDown(saved, saved ? env : null, saved ? onRetry : undefined);
  // His Retry spins while the read it gave is out; the failure stays until the answer replaces it.
  const [retrying, setRetrying] = useState(false);
  if (env && saved && (lifeos.down || lifeos.waits)) return <DownEmpty live={lifeos} environmentId={env} onRetry={() => refreshLifeos(env).catch(() => undefined).then(async () => void (await onRetry?.()))} />;
  // Back on connected and read again: the wait in the body's place, never the old cause.
  if (lifeos.again)
    return (
      <Empty data-canvas-again role="status" aria-busy aria-label={`Opening this ${kindNoun(kind)}`}>
        <EmptyMedia>
          <Spinner className="size-4" />
        </EmptyMedia>
      </Empty>
    );
  return (
    <Empty data-canvas-failed>
      <EmptyHeader>
        <EmptyTitle>{`Couldn't open this ${kindNoun(kind)}`}</EmptyTitle>
        {said ? <EmptyDescription>{said}</EmptyDescription> : null}
      </EmptyHeader>
      {onRetry ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void Promise.resolve(onRetry()).finally(() => setRetrying(false));
          }}
        >
          <BusyLabel busy={retrying} label="Retry" />
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
