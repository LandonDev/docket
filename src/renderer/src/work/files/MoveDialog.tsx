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
import { Folder, Users } from "../../chrome/icons";
import { Cloud } from "../icons";
import { makeIn } from "./acts";
import { KindGlyph } from "./KindGlyph";
import { carryRefusal, placePage, readCopy, samePage, type PlaceCopy, type PlaceRow, type Sidebar } from "./model";
import { NameField } from "./rowParts";
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

const VERB = { move: "Move", copy: "Copy" } as const;

/** A place's glyph, as the sidebar draws it: his OneDrive a cloud, a team's library its people. */
export const placeIcon = (row: Pick<PlaceRow, "kind">): ReactNode => (row.kind === "onedrive" ? <Cloud className="size-4" /> : <Users className="size-4" />);

/** A row of the places list: a place to walk into, or a team over its channels, one level in, as the sidebar has them. */
export type PlaceItem = { target: MoveTarget; icon: ReactNode; /** a team's channel: drawn by its own name, one level in; its target names the team too */ inTeam?: string } | { team: string };

/** The places a thing can go to, in the sidebar's order, glyphs and teams: the workspace's folder, then each team or library. */
export function placeItems(sidebar: Sidebar, workspaceName: string): PlaceItem[] {
  // A channel is named with its team where it stands alone (a trail, a line that says where a thing went).
  const one = (row: PlaceRow, inTeam = false): PlaceItem => {
    const copy = readCopy(row);
    const name = row.group && row.group !== row.name ? `${row.group}, ${row.name}` : row.name;
    return { target: { copy, at: placePage(copy, name).at, name }, icon: placeIcon(row), ...(inTeam ? { inTeam: row.name } : {}) };
  };
  return [
    ...(sidebar.folder ? [{ target: { copy: sidebar.folder, at: placePage(sidebar.folder, workspaceName).at, name: workspaceName }, icon: <Folder className="size-4" /> }] : []),
    ...(sidebar.places ?? []).flatMap((p): PlaceItem[] => (p.is === "team" ? [{ team: p.name }, ...p.rows.map((row) => one(row, true))] : [one(p.row)])),
  ];
}

/** The folders he moved or saved to last, kept per workspace and verb, three at most; each read again against the places listed now. */
type Recent = MoveTarget & { where: string };
const RECENT_KEPT = 3;
const recentKey = (kind: string, workspace: { id: string; environmentId?: string }): string => `tc.${kind}.recent.${workspace.environmentId ?? ""}:${workspace.id}`;
export function recentFolders(kind: "move" | "saveAs", workspace: { id: string; environmentId?: string }, places?: readonly PlaceItem[]): Recent[] {
  let kept: Recent[] = [];
  try {
    const got = JSON.parse(localStorage.getItem(recentKey(kind, workspace)) ?? "[]") as unknown;
    kept = Array.isArray(got) ? (got as Recent[]).slice(0, RECENT_KEPT) : [];
  } catch {
    return [];
  }
  if (!places) return kept;
  // A place no longer listed is left out; one still listed goes by its copy now, so its state and verbs are today's.
  const now = places.flatMap((p) => ("target" in p ? [p.target.copy] : []));
  return kept.flatMap((f) => {
    const copy = now.find((c) => c.link === f.copy.link && c.place.id === f.copy.place.id);
    return copy ? [{ ...f, copy }] : [];
  });
}
export function keepRecentFolder(kind: "move" | "saveAs", workspace: { id: string; environmentId?: string }, folder: Recent): void {
  const same = (f: Recent): boolean => f.copy.link === folder.copy.link && JSON.stringify(f.at) === JSON.stringify(folder.at);
  try {
    localStorage.setItem(recentKey(kind, workspace), JSON.stringify([folder, ...recentFolders(kind, workspace).filter((f) => !same(f))].slice(0, RECENT_KEPT)));
  } catch {
    // A window that keeps nothing starts on the places.
  }
}

export const ROW = "flex h-8 w-full min-w-0 cursor-default items-center gap-2 rounded-md px-2 text-start text-[13px] select-none";

export function MoveDialog({
  verb,
  entries,
  from,
  start,
  waiting = false,
  sidebar,
  workspace,
  onPick,
  onClose,
}: {
  verb: "move" | "copy";
  entries: readonly FileEntry[];
  /** the place the things are in */
  from?: PlaceCopy;
  /** the folder the dialog opens in: the one the things are in; null opens on the places */
  start: { at: FolderRef; name: string } | null;
  /** the places are still being read: their rows are drawn as they come */
  waiting?: boolean;
  sidebar: Sidebar;
  workspace: { id: string; name: string; environmentId?: string };
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
  const what = entries.length === 1 ? entries[0]!.name : `${entries.length} things`;
  const places = placeItems(sidebar, workspace.name);
  // Move and Copy keep the folders he carried things to last, as Save As keeps its own.
  const recent = recentFolders("move", workspace, places);
  // The grammar's refusal for the folder shown, for any of the things.
  const no = !at ? null : !from ? refusal(at.copy.place, "make") : (entries.map((entry) => carryRefusal(from.place, verb, entry, at.copy.place)).find((r) => r !== null) ?? null);
  // A thing cannot go into itself; one moved where it already is: Move Here is greyed, and no note says so (it opens there).
  const inside = !!at && entries.some((e) => e.folder && samePage(e.folder, at.at)) ? "A folder cannot go inside itself." : null;
  const stays = !!at && !!start && verb === "move" && samePage(at.at, start.at);
  const why = no?.text ?? inside;
  const note = why ?? (failed?.at === at ? failed.why : null);
  // New Folder at the trail's end, where the place makes folders; the folder made is the one he stands in.
  const [naming, setNaming] = useState(false);
  const makesFolder = !!at && !refusal(at.copy.place, "make") && (at.copy.place.makes ?? []).includes("folder");
  const newFolder = async (typed: string | null): Promise<void> => {
    setNaming(false);
    if (!typed?.trim() || !at) return;
    const made = await makeIn({ workspaceId: workspace.id, home: workspace.environmentId ?? at.copy.link }, at.copy, at.at, "folder", typed);
    if (made?.folder) setAt({ copy: at.copy, at: made.folder, name: made.name });
  };
  return (
    <Modal onClose={onClose} title={`${VERB[verb]} ${what}`} size="sm" busy={pending} className="h-[440px]" data-files-move="">
      <div className="flex min-h-0 flex-1 flex-col px-3 pt-3">
        {at ? (
          <Folders
            key={`${at.copy.link}:${JSON.stringify(at.at)}`}
            workspaceId={workspace.id}
            target={at}
            entries={entries}
            onInto={(to) => (setNaming(false), into(to))}
            onPlaces={() => (setNaming(false), setAt(null))}
            {...(makesFolder
              ? {
                  end: (
                    <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={naming} onClick={() => setNaming(true)}>
                      New Folder
                    </Button>
                  ),
                  first: naming ? (
                    <div className={ROW}>
                      <KindGlyph kind="folder" />
                      <NameField name="New Folder" folder className="h-6 flex-1 text-[13px]" onDone={(typed) => void newFolder(typed)} />
                    </div>
                  ) : null,
                }
              : {})}
          />
        ) : (
          <Places places={places} recent={recent} waiting={waiting} onInto={into} />
        )}
      </div>
      <DialogFooter
        onCancel={onClose}
        confirmLabel={at ? `${VERB[verb]} Here` : VERB[verb]}
        pending={pending}
        disabled={!at || why !== null || stays}
        note={note ? <span className="text-xs text-muted-foreground">{note}</span> : undefined}
        onConfirm={() => {
          if (!at || pending) return;
          setPending(true);
          setFailed(null);
          void onPick(at, (said) => setFailed({ at, why: said }))
            .then((went) => {
              if (!went) return;
              keepRecentFolder("move", workspace, { ...at, where: at.copy.place.name });
              onClose();
            })
            .finally(() => setPending(false));
        }}
      />
    </Modal>
  );
}

/** The places a thing can go to; Save As… puts the folders he saved to last over them. */
export function Places({ places, recent = [], off = [], waiting, onInto }: { places: readonly PlaceItem[]; recent?: readonly (MoveTarget & { where: string })[]; off?: readonly { name: string; why: string }[]; waiting: boolean; onInto(to: MoveTarget): void }) {
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
      {places.map((item) =>
        "team" in item ? (
          // A team is no folder: its name over its channels, which stand one level in.
          <div key={`team:${item.team}`} role="presentation" className={`${ROW} text-muted-foreground`}>
            <Users aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{item.team}</span>
          </div>
        ) : (
          <Button
            key={`${item.target.copy.link}:${item.target.copy.place.id}`}
            variant="ghost"
            role="option"
            aria-selected={false}
            // One level in under its team: the button's own icon padding (`has-[>svg:first-child]:ps-2`) would win over a bare `ps-6`.
            className={`${ROW} justify-start font-normal ${item.inTeam ? "ps-6 has-[>svg:first-child]:ps-6" : ""} [&>svg:first-child]:text-muted-foreground`}
            onClick={() => onInto(item.target)}
          >
            {item.icon}
            <span className="min-w-0 flex-1 truncate">{item.inTeam ?? item.target.name}</span>
            <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          </Button>
        ),
      )}
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
        {listing.loading && listing.more && folders.length && !listing.retrying ? (
          <div aria-busy className="flex h-8 shrink-0 items-center gap-2 px-2 text-xs text-muted-foreground">
            <Spinner className="size-3" />
            Loading more
          </div>
        ) : listing.error && folders.length ? (
          <div className="flex h-8 shrink-0 items-center gap-2 px-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">The rest did not load.</span>
            <Button variant="ghost" size="xs" disabled={!!listing.retrying} onClick={() => void (listing.lostPage ? listing.retryRest() : listing.retry())}>
              <BusyLabel busy={!!listing.retrying} label="Retry" />
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
