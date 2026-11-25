import { useEffect, useState, type ReactNode } from "react";
import type { FileCrumb } from "@shared/contract-work-files";
import { DEFAULT_SORT, refusal, type FileEntry, type FolderRef } from "@shared/work/files";
import { DialogFooter } from "../../chrome/ConfirmDialog";
import { ChevronRight } from "../../chrome/icons";
import { Modal } from "../../chrome/Modal";
import { Tip } from "../../components/tip";
import { BusyLabel, Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { KindGlyph } from "./KindGlyph";
import { carryRefusal, placePage, readCopy, samePage, type PlaceCopy, type Sidebar } from "./model";
import { pressFor, useListing, type ListFrom } from "./store";

/**
 * Move to…, Copy to… and Save as Word to… (docs/DESIGN.md "The Files place"): one dialog that walks to a folder. It
 * starts in the folder the things are in (Save as Word: on the places); the places are one press away, each with its
 * folders under it. The verb is off, with the place's own sentence beside it, where the grammar refuses it
 * (`refusal`, the rule the host holds; for Save as Word, New's in that folder) or the folder is on another computer
 * (`carryRefusal`), so nothing is offered that would be refused. A press that fails anyway says why in the same place.
 */

export interface MoveTarget {
  copy: PlaceCopy;
  at: FolderRef;
  name: string;
}

const VERB = { move: "Move", copy: "Copy", word: "Save" } as const;

export const ROW = "flex h-8 w-full min-w-0 cursor-default items-center gap-2 rounded-md px-2 text-start text-[13px] select-none";

export function MoveDialog({
  verb,
  entries,
  what: named,
  from,
  start,
  waiting = false,
  sidebar,
  workspace,
  onPick,
  onClose,
}: {
  /** `word`: Save as Word to…, a new file made in the folder; `entries` is empty and `what` names the document */
  verb: "move" | "copy" | "word";
  entries: readonly FileEntry[];
  /** the name the title gives what goes, where no entry names it */
  what?: string;
  /** the place the things are in; absent for Save as Word */
  from?: PlaceCopy;
  /** the folder the dialog opens in: the one the things are in; null opens on the places */
  start: { at: FolderRef; name: string } | null;
  /** the places are still being read: their rows are drawn as they come */
  waiting?: boolean;
  sidebar: Sidebar;
  workspace: { id: string; name: string };
  /** he chose a folder: the caller carries the things there; the dialog waits for it, and says why through `fail` when nothing went */
  onPick(to: MoveTarget, fail: (why: string) => void): Promise<boolean>;
  onClose(): void;
}) {
  // Where the dialog stands: a place's copy and a folder in it; null is the list of places.
  const [at, setAt] = useState<MoveTarget | null>(start && from ? { copy: from, at: start.at, name: start.name } : null);
  // A folder he goes into here is his press for it: a sleeping VM wakes for it, as in the place itself.
  const into = (to: MoveTarget): void => {
    pressFor(to.at);
    setAt(to);
  };
  const [pending, setPending] = useState(false);
  // Why the last press carried nothing, for the folder it was pressed in.
  const [failed, setFailed] = useState<{ at: MoveTarget; why: string } | null>(null);
  const what = named ?? (entries.length === 1 ? entries[0]!.name : `${entries.length} things`);
  const places: MoveTarget[] = [
    ...(sidebar.folder ? [{ copy: sidebar.folder, at: placePage(sidebar.folder, workspace.name).at, name: workspace.name }] : []),
    ...sidebar.rows.map((row) => {
      const copy = readCopy(row);
      return { copy, at: placePage(copy, row.name).at, name: row.group && row.group !== row.name ? `${row.group}, ${row.name}` : row.name };
    }),
  ];
  // The grammar's refusal for the folder shown, for any of the things; a Word file is a new thing made there.
  const no = !at ? null : verb === "word" || !from ? refusal(at.copy.place, "make") : (entries.map((entry) => carryRefusal(from.place, verb, entry, at.copy.place)).find((r) => r !== null) ?? null);
  // A thing cannot go into itself or stay where it is.
  const same = !!at && (start && samePage(at.at, start.at) && verb === "move" ? "It is in this folder already." : entries.some((e) => e.folder && samePage(e.folder, at.at)) ? "A folder cannot go inside itself." : null);
  const why = no?.text ?? same ?? null;
  const note = why ?? (failed?.at === at ? failed.why : null);
  return (
    <Modal onClose={onClose} title={verb === "word" ? `Save ${what} as Word` : `${VERB[verb]} ${what}`} size="sm" busy={pending} className="h-[440px]" data-files-move="">
      <div className="flex min-h-0 flex-1 flex-col px-3 pt-3">
        {at ? <Folders key={`${at.copy.link}:${JSON.stringify(at.at)}`} workspaceId={workspace.id} target={at} entries={entries} onInto={into} onPlaces={() => setAt(null)} /> : <Places places={places} waiting={waiting} onInto={into} />}
      </div>
      <DialogFooter
        onCancel={onClose}
        confirmLabel={at ? `${VERB[verb]} Here` : VERB[verb]}
        pending={pending}
        disabled={!at || why !== null}
        note={note ? <span className="text-xs text-muted-foreground">{note}</span> : undefined}
        onConfirm={() => {
          if (!at || pending) return;
          setPending(true);
          setFailed(null);
          void onPick(at, (said) => setFailed({ at, why: said }))
            .then((went) => went && onClose())
            .finally(() => setPending(false));
        }}
      />
    </Modal>
  );
}

/** The places a thing can go to; Save As… puts the folders he saved to last over them. */
export function Places({ places, recent = [], off = [], waiting, onInto }: { places: readonly MoveTarget[]; recent?: readonly (MoveTarget & { where: string })[]; off?: readonly { name: string; why: string }[]; waiting: boolean; onInto(to: MoveTarget): void }) {
  return (
    <div role="listbox" aria-label="Places" className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      {recent.length ? (
        <>
          <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Recent</p>
          {recent.map((folder) => (
            <Button key={`${folder.copy.link}:${JSON.stringify(folder.at)}`} variant="ghost" role="option" aria-selected={false} className={`${ROW} justify-start font-normal`} onClick={() => onInto(folder)}>
              <KindGlyph kind="folder" />
              <span className="min-w-0 flex-1 truncate">{folder.name}</span>
              <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{folder.where}</span>
            </Button>
          ))}
          <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">Places</p>
        </>
      ) : (
        <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Places</p>
      )}
      {waiting && !places.length ? <RowBones /> : null}
      {places.map((place) => (
        <Button key={`${place.copy.link}:${place.copy.place.id}`} variant="ghost" role="option" aria-selected={false} className={`${ROW} justify-start font-normal`} onClick={() => onInto(place)}>
          <KindGlyph kind="folder" />
          <span className="min-w-0 flex-1 truncate">{place.name}</span>
          <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      ))}
      {/* A place the verb cannot reach yet, there and off, with its sentence on hover. */}
      {off.map((place) => (
        <Tip key={place.name} label={place.why} side="right">
          <div role="option" aria-selected={false} aria-disabled aria-description={place.why} className={`${ROW} text-muted-foreground opacity-60`}>
            <KindGlyph kind="folder" tinted={false} />
            <span className="min-w-0 flex-1 truncate">{place.name}</span>
          </div>
        </Tip>
      ))}
    </div>
  );
}

/**
 * One folder's folders, under the trail that led to it; a press walks in. The host is asked for folders alone, a page at
 * a time as the list nears its end. `end` stands at the trail's end (Save As…'s New Folder); `first` is a row over the
 * folders (the new folder's name being typed).
 */
export function Folders({ workspaceId, target, entries, onInto, onPlaces, end, first }: { workspaceId: string; target: MoveTarget; entries: readonly FileEntry[]; onInto(to: MoveTarget): void; onPlaces(): void; end?: ReactNode; first?: ReactNode }) {
  const from: ListFrom = { workspaceId, copy: target.copy, foldersOnly: true };
  const listing = useListing(from, target.at, DEFAULT_SORT);
  const folders = listing.entries.filter((e) => e.folder);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const more = listing.more && !listing.error;
  useEffect(() => {
    if (!scroller || !more) return;
    const near = (): void => {
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32 * 8) listing.loadMore();
    };
    near();
    scroller.addEventListener("scroll", near, { passive: true });
    return () => scroller.removeEventListener("scroll", near);
    // `loadMore` is new each render; the scroller and the count decide when to listen again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scroller, more, folders.length]);
  const moving = new Set(entries.map((e) => e.key));
  const trail: FileCrumb[] = listing.trail.length ? listing.trail : [{ name: target.name, at: target.at }];
  return (
    <>
      <nav aria-label="Folder" className="flex min-w-0 shrink-0 items-center gap-0.5 pb-1">
        <Button variant="ghost" size="xs" className="shrink-0 text-muted-foreground" onClick={onPlaces}>
          Places
        </Button>
        {trail.map((crumb, i) => (
          <span key={i} className="flex min-w-0 items-center gap-0.5">
            <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            {i === trail.length - 1 ? (
              <span aria-current="page" className="truncate px-2 text-xs font-medium text-foreground">
                {crumb.name}
              </span>
            ) : (
              <Button variant="ghost" size="xs" className="min-w-0 text-muted-foreground" onClick={() => onInto({ copy: target.copy, at: crumb.at, name: crumb.name })}>
                <span className="truncate">{crumb.name}</span>
              </Button>
            )}
          </span>
        ))}
        {end ? <span className="ms-auto flex shrink-0 items-center">{end}</span> : null}
      </nav>
      <div ref={setScroller} role="listbox" aria-label={`Folders in ${target.name}`} className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        {first}
        {/* A read with no rows is the bones, but his Retry keeps "did not load" with that Retry spinning. */}
        {!listing.loaded || (!folders.length && listing.loading && !listing.retrying) ? (
          <RowBones />
        ) : listing.error && !folders.length ? (
          <div className="flex flex-col items-start gap-2 p-2 text-xs text-muted-foreground">
            <span>This folder did not load.</span>
            <Button variant="ghost" size="xs" disabled={!!listing.retrying} onClick={() => void listing.retry()}>
              <BusyLabel busy={!!listing.retrying} label="Retry" />
            </Button>
          </div>
        ) : !folders.length ? (
          first ? null : <p className="p-2 text-xs text-muted-foreground">No folders in here.</p>
        ) : (
          folders.map((folder) => (
            <Button
              key={folder.key}
              variant="ghost"
              role="option"
              aria-selected={false}
              // A folder being moved is no place to put it.
              disabled={moving.has(folder.key)}
              className={`${ROW} justify-start font-normal`}
              onClick={() => onInto({ copy: target.copy, at: folder.folder!, name: folder.name })}
            >
              <KindGlyph kind="folder" />
              <span className="min-w-0 flex-1 truncate">{folder.name}</span>
              <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            </Button>
          ))
        )}
        {listing.loading && listing.more && folders.length ? (
          <div aria-busy className="flex h-8 shrink-0 items-center gap-2 px-2 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Loading more
          </div>
        ) : listing.error && folders.length ? (
          <div className="flex h-8 shrink-0 items-center gap-2 px-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">The rest did not load.</span>
            <Button variant="ghost" size="xs" onClick={listing.lostPage ? listing.loadMore : listing.retry}>
              Retry
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** Rows still being read: three bones in the rows' own shape. */
export function RowBones() {
  return (
    <div role="status" aria-label="Loading" aria-busy className="flex flex-col">
      {["w-[46%]", "w-[60%]", "w-[38%]"].map((w, i) => (
        <div key={i} className="flex h-8 items-center gap-2 px-2">
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <Skeleton className={`h-3 ${w}`} />
        </div>
      ))}
    </div>
  );
}
