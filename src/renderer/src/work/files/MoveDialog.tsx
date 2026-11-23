import { useEffect, useState } from "react";
import type { FileCrumb } from "@shared/contract-work-files";
import { DEFAULT_SORT, refusal, type FileEntry, type FolderRef } from "@shared/work/files";
import { DialogFooter } from "../../chrome/ConfirmDialog";
import { ChevronRight } from "../../chrome/icons";
import { Modal } from "../../chrome/Modal";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { KindGlyph } from "./KindGlyph";
import { placePage, readCopy, samePage, type PlaceCopy, type Sidebar } from "./model";
import { useListing, type ListFrom } from "./store";

/**
 * Move to… and Copy to… (docs/DESIGN.md "The Files place"): one dialog that walks to a folder. It starts in the
 * folder the things are in; the places are one press away, each with its folders under it. The verb is off, with
 * the place's own sentence beside it, where the grammar refuses it (`refusal`, the rule the host holds), so
 * nothing is offered that would be refused.
 */

export interface MoveTarget {
  copy: PlaceCopy;
  at: FolderRef;
  name: string;
}

const ROW = "flex h-8 w-full min-w-0 cursor-default items-center gap-2 rounded-md px-2 text-start text-[13px] select-none";

export function MoveDialog({
  verb,
  entries,
  from,
  start,
  sidebar,
  workspace,
  onPick,
  onClose,
}: {
  verb: "move" | "copy";
  entries: readonly FileEntry[];
  /** the place the things are in */
  from: PlaceCopy;
  /** the folder the dialog opens in: the one the things are in */
  start: { at: FolderRef; name: string };
  sidebar: Sidebar;
  workspace: { id: string; name: string };
  /** he chose a folder: the caller carries the things there; the dialog waits for it */
  onPick(to: MoveTarget): Promise<boolean>;
  onClose(): void;
}) {
  // Where the dialog stands: a place's copy and a folder in it; null is the list of places.
  const [at, setAt] = useState<MoveTarget | null>({ copy: from, at: start.at, name: start.name });
  const [pending, setPending] = useState(false);
  const what = entries.length === 1 ? entries[0]!.name : `${entries.length} things`;
  const places: MoveTarget[] = [
    ...(sidebar.folder ? [{ copy: sidebar.folder, at: placePage(sidebar.folder, workspace.name).at, name: workspace.name }] : []),
    ...sidebar.rows.map((row) => {
      const copy = readCopy(row);
      return { copy, at: placePage(copy, row.name).at, name: row.group && row.group !== row.name ? `${row.group}, ${row.name}` : row.name };
    }),
  ];
  // The grammar's refusal for the folder shown, for any of the things.
  const no = at ? (entries.map((entry) => refusal(from.place, verb, entry, at.copy.place)).find((r) => r !== null) ?? null) : null;
  // A thing cannot go into itself or stay where it is.
  const same = !!at && (samePage(at.at, start.at) && verb === "move" ? "It is in this folder already." : entries.some((e) => e.folder && samePage(e.folder, at.at)) ? "A folder cannot go inside itself." : null);
  const why = no?.text ?? same ?? null;
  return (
    <Modal onClose={onClose} title={`${verb === "move" ? "Move" : "Copy"} ${what}`} size="sm" busy={pending} className="h-[440px]" data-files-move="">
      <div className="flex min-h-0 flex-1 flex-col px-3 pt-3">
        {at ? <Folders key={`${at.copy.link}:${JSON.stringify(at.at)}`} workspaceId={workspace.id} target={at} entries={entries} onInto={setAt} onPlaces={() => setAt(null)} /> : <Places places={places} onInto={setAt} />}
      </div>
      <DialogFooter
        onCancel={onClose}
        confirmLabel={at ? `${verb === "move" ? "Move" : "Copy"} Here` : verb === "move" ? "Move" : "Copy"}
        pending={pending}
        disabled={!at || why !== null}
        note={why ? <span className="text-xs text-muted-foreground">{why}</span> : undefined}
        onConfirm={() => {
          if (!at || pending) return;
          setPending(true);
          void onPick(at)
            .then((went) => went && onClose())
            .finally(() => setPending(false));
        }}
      />
    </Modal>
  );
}

/** The places a thing can go to. */
function Places({ places, onInto }: { places: readonly MoveTarget[]; onInto(to: MoveTarget): void }) {
  return (
    <div role="listbox" aria-label="Places" className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
      <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Places</p>
      {places.map((place) => (
        <Button key={`${place.copy.link}:${place.copy.place.id}`} variant="ghost" role="option" aria-selected={false} className={`${ROW} justify-start font-normal`} onClick={() => onInto(place)}>
          <KindGlyph kind="folder" />
          <span className="min-w-0 flex-1 truncate">{place.name}</span>
          <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      ))}
    </div>
  );
}

/** One folder's folders, under the trail that led to it; a press walks in. The host is asked for folders alone, a page at a time as the list nears its end. */
function Folders({ workspaceId, target, entries, onInto, onPlaces }: { workspaceId: string; target: MoveTarget; entries: readonly FileEntry[]; onInto(to: MoveTarget): void; onPlaces(): void }) {
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
      </nav>
      <div ref={setScroller} role="listbox" aria-label={`Folders in ${target.name}`} className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
        {!listing.loaded ? (
          <div role="status" aria-label="Loading" aria-busy className="flex flex-col">
            {["w-[46%]", "w-[60%]", "w-[38%]"].map((w, i) => (
              <div key={i} className="flex h-8 items-center gap-2 px-2">
                <Skeleton className="size-4 shrink-0 rounded-sm" />
                <Skeleton className={`h-3 ${w}`} />
              </div>
            ))}
          </div>
        ) : listing.error && !folders.length ? (
          <div className="flex flex-col items-start gap-2 p-2 text-xs text-muted-foreground">
            <span>This folder did not load.</span>
            <Button variant="ghost" size="xs" onClick={listing.retry}>
              Retry
            </Button>
          </div>
        ) : !folders.length ? (
          <p className="p-2 text-xs text-muted-foreground">No folders in here.</p>
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
