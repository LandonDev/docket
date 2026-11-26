import { useEffect, useRef, useState } from "react";
import type { DeckVersion } from "@shared/contract-work-slides";
import { DialogFooter } from "../../../chrome/ConfirmDialog";
import { Modal, ModalBody } from "../../../chrome/Modal";
import { Tip } from "../../../components/tip";
import { Button } from "../../../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { ROW_PRESS } from "../../../components/ui/press";
import { Skeleton } from "../../../components/ui/skeleton";
import { dayTime } from "../../../lib/duration";
import { History } from "../../icons";
import type { PdfDoc, PdfEngine } from "../../pdf/engine";
import type { DeckHost } from "../deck";
import { Picture } from "../Picture";
import type { HandSession } from "./session";

/**
 * History, in the deck's own bar (docs/DESIGN.md "The slide editor"): the
 * kept copies of the deck, newest first. A press on one opens it to look at
 * (`VersionLook`: its slides as the host draws the copy), with Restore there.
 * A restore puts the copy in the file's place and keeps the deck as it was
 * first, so the copy from just before is at the top of the list next time.
 */

export const FIRST_WORDS = "Before Docket changed it";

export type Kept = { list: DeckVersion[] | null; error: string | null };

export function HistoryButton({ host, session, engine }: { host: DeckHost; session: HandSession; engine: PdfEngine }) {
  const [open, setOpen] = useState(false);
  const [kept, setKept] = useState<Kept>({ list: null, error: null });
  const [restoring, setRestoring] = useState<string | null>(null);
  const [looking, setLooking] = useState<DeckVersion | null>(null);
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
  // From the look: the list closes for it, and the look closes once the copy is in the file's place.
  const restore = (version: DeckVersion): void => {
    setRestoring(version.id);
    void session.restore(version.id).then((done) => {
      setRestoring(null);
      if (done) setLooking(null);
    });
  };
  const look = (version: DeckVersion): void => {
    setOpen(false);
    setLooking(version);
  };
  // Under 560px of bar the word goes and the glyph takes the tip, as the pane's own History does.
  const word = useRef<HTMLSpanElement>(null);
  const [bare, setBare] = useState(false);
  const measure = (): void => setBare(!!word.current && getComputedStyle(word.current).display === "none");
  return (
    <>
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
            <Button variant="ghost" size="xs" aria-label="History" data-slides-history className="shrink-0 @max-[560px]/bar:px-1.5" onPointerEnter={measure} onFocus={measure}>
              <History />
              <span ref={word} className="@max-[560px]/bar:hidden">
                History
              </span>
            </Button>
          }
        />
      </Tip>
      <PopoverContent align="end" sideOffset={4} aria-label="History" className="w-[280px] gap-0 p-1">
        <VersionList kept={kept} onRetry={read} onLook={look} />
      </PopoverContent>
    </Popover>
    {looking ? <VersionLook version={looking} host={host} engine={engine} restoring={restoring === looking.id} onRestore={() => restore(looking)} onClose={() => setLooking(null)} /> : null}
    </>
  );
}

/** A kept copy's picture, opened by range from the host as it draws it; its failure in words, with Retry. */
type Opened = { doc: PdfDoc | null; error: string | null };

/**
 * A kept copy to look at before Restore: its slides one under another as the host draws the copy, in a dialog with
 * Restore beside Cancel. Nothing changes until Restore; Escape, Cancel or the backdrop leave the deck as it is.
 */
export function VersionLook({ version, host, engine, restoring, onRestore, onClose }: { version: DeckVersion; host: DeckHost; engine: PdfEngine; restoring: boolean; onRestore(): void; onClose(): void }) {
  const [opened, setOpened] = useState<Opened>({ doc: null, error: null });
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    setOpened({ doc: null, error: null });
    void host
      .version(version.id, 0, 1)
      .then(({ size, rev }) => engine.open({ size, read: async (offset, length) => (await host.version(version.id, offset, length, rev)).data }))
      .then(
        (doc) => live && setOpened({ doc, error: null }),
        (error: unknown) => live && setOpened({ doc: null, error: error instanceof Error && error.message ? error.message : "The host did not answer" }),
      );
    return () => {
      live = false;
    };
  }, [version.id, host, engine, tries]);
  const { doc, error } = opened;
  return (
    <Modal onClose={onClose} title={dayTime(version.at)} {...(version.first ? { description: FIRST_WORDS } : {})} size="md" busy={restoring} data-slides-version={version.id}>
      <ModalBody className="max-h-[min(560px,60vh)] gap-3 overflow-x-hidden overflow-y-auto overscroll-contain">
        {error ? (
          <div className="flex min-h-7 items-center justify-between gap-2 text-[13px] leading-5 text-muted-foreground">
            <span className="min-w-0">{error}</span>
            <Button variant="ghost" size="xs" className="shrink-0 text-foreground" onClick={() => setTries((n) => n + 1)}>
              Retry
            </Button>
          </div>
        ) : !doc ? (
          <div data-slides-version-loading aria-busy="true" aria-label="Loading" className="flex flex-col gap-3">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="aspect-video w-full rounded-md" />
            ))}
          </div>
        ) : (
          Array.from({ length: doc.pages }, (_, i) => (
            <div key={i} data-version-slide={i + 1} className="overflow-hidden rounded-md outline-1 -outline-offset-1 outline-(--image-outline)">
              <Picture doc={doc} page={i + 1} width={536} title={`Slide ${i + 1}`} thumb first />
            </div>
          ))
        )}
      </ModalBody>
      <DialogFooter onCancel={onClose} confirmLabel="Restore" busyLabel="Restoring" pending={restoring} disabled={!doc} onConfirm={onRestore} />
    </Modal>
  );
}

/** What History holds: the kept copies, each opening its look, its loading rows, its empty line, or why it could not be read. */
export function VersionList({ kept, onRetry, onLook }: { kept: Kept; onRetry(): void; onLook(version: DeckVersion): void }) {
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
        <div key={v.id} role="listitem" data-version={v.id}>
          <button
            type="button"
            aria-label={`Look at the ${dayTime(v.at)} version`}
            onClick={() => onLook(v)}
            className={`flex min-h-9 w-full flex-col justify-center rounded-lg py-1 ps-2 pe-1 text-start ${ROW_PRESS}`}
          >
            <span className="truncate text-[13px] leading-5 tabular-nums">{dayTime(v.at)}</span>
            {v.first ? <span className="truncate text-xs leading-4 text-muted-foreground">{FIRST_WORDS}</span> : null}
          </button>
        </div>
      ))}
    </div>
  );
}
