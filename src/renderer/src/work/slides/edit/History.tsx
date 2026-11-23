import { useRef, useState } from "react";
import type { DeckVersion } from "@shared/contract-work-slides";
import { Tip } from "../../../components/tip";
import { BusyLabel, Button } from "../../../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { reveal } from "../../../components/ui/reveal";
import { Skeleton } from "../../../components/ui/skeleton";
import { dayTime } from "../../../lib/duration";
import { History } from "../../icons";
import type { DeckHost } from "../deck";
import type { HandSession } from "./session";

/**
 * History, in the deck's own bar (docs/DESIGN.md "The slide editor"): the
 * kept copies of the deck, newest first, each with Restore. A restore puts
 * the copy in the file's place and keeps the deck as it was first, so the
 * copy from just before is at the top of the list next time.
 */

export const FIRST_WORDS = "Before TempCode changed it";

export type Kept = { list: DeckVersion[] | null; error: string | null };

export function HistoryButton({ host, session }: { host: DeckHost; session: HandSession }) {
  const [open, setOpen] = useState(false);
  const [kept, setKept] = useState<Kept>({ list: null, error: null });
  const [restoring, setRestoring] = useState<string | null>(null);
  // Each opening asks again, so a version kept a moment ago is there; an answer for an older opening is dropped.
  const asked = useRef(0);
  const read = (): void => {
    const ask = ++asked.current;
    setKept((was) => ({ list: was.list, error: null }));
    host.versions().then(
      (list) => ask === asked.current && setKept({ list, error: null }),
      (error: unknown) => ask === asked.current && setKept({ list: null, error: error instanceof Error && error.message ? error.message : "The host did not answer" }),
    );
  };
  const restore = (version: DeckVersion): void => {
    setRestoring(version.id);
    void session.restore(version.id).then((done) => {
      setRestoring(null);
      if (done) setOpen(false);
    });
  };
  // Under 560px of bar the word goes and the glyph takes the tip, as the pane's own History does.
  const word = useRef<HTMLSpanElement>(null);
  const [bare, setBare] = useState(false);
  const look = (): void => setBare(!!word.current && getComputedStyle(word.current).display === "none");
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) read();
      }}
    >
      <Tip label="History" disabled={!bare}>
        <PopoverTrigger
          render={
            <Button variant="ghost" size="xs" aria-label="History" data-slides-history className="shrink-0 @max-[560px]/bar:px-1.5" onPointerEnter={look} onFocus={look}>
              <History />
              <span ref={word} className="@max-[560px]/bar:hidden">
                History
              </span>
            </Button>
          }
        />
      </Tip>
      <PopoverContent align="end" sideOffset={4} aria-label="History" className="w-[280px] gap-0 p-1">
        <VersionList kept={kept} restoring={restoring} onRetry={read} onRestore={restore} />
      </PopoverContent>
    </Popover>
  );
}

/** What History holds: the kept copies with Restore on each, its loading rows, its empty line, or why it could not be read. */
export function VersionList({ kept, restoring, onRetry, onRestore }: { kept: Kept; restoring: string | null; onRetry(): void; onRestore(version: DeckVersion): void }) {
  return kept.error ? (
    <div className="flex min-h-7 items-center justify-between gap-2 py-1 ps-2 text-[13px] leading-5 text-muted-foreground">
      <span className="min-w-0">{kept.error}</span>
      <Button variant="ghost" size="xs" className="shrink-0 text-foreground" onClick={onRetry}>
        Retry
      </Button>
    </div>
  ) : !kept.list ? (
    <div data-slides-history-loading aria-busy="true" aria-label="Loading" className="flex flex-col">
      {[34, 44, 28].map((w) => (
        <div key={w} className="flex h-9 items-center px-2">
          <Skeleton className="h-3" style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  ) : kept.list.length === 0 ? (
    <div className="flex min-h-7 items-center px-2 text-[13px] leading-5 text-muted-foreground">No versions yet</div>
  ) : (
    <div role="list" className="flex max-h-[284px] flex-col overflow-x-hidden overflow-y-auto">
      {kept.list.map((v) => (
        <div key={v.id} role="listitem" data-version={v.id} className="group/row flex min-h-9 items-center gap-2 rounded-lg py-1 ps-2 pe-1 hover:bg-foreground/5">
          <span className="flex min-w-0 grow flex-col">
            <span className="truncate text-[13px] leading-5 tabular-nums">{dayTime(v.at)}</span>
            {v.first ? <span className="truncate text-xs leading-4 text-muted-foreground">{FIRST_WORDS}</span> : null}
          </span>
          <span className={restoring === v.id ? "flex" : `flex ${reveal("row", { row: true })}`}>
            <Button variant="ghost" size="xs" aria-label={`Restore the ${dayTime(v.at)} version`} disabled={restoring !== null} onClick={() => onRestore(v)}>
              <BusyLabel busy={restoring === v.id} label="Restore" busyLabel="Restoring" />
            </Button>
          </span>
        </div>
      ))}
    </div>
  );
}
