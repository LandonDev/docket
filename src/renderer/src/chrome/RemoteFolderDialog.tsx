import { dialogErrorWords } from "../lib/dialogErrorWords";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { ItemButton, ItemContent, ItemMedia, ItemTitle } from "@renderer/components/ui/item";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbSeparator } from "@renderer/components/ui/breadcrumb";
import { Bones, Region } from "@renderer/components/bones";
import { DialogFooter, ErrorLine } from "./ConfirmDialog";
import { ArrowUpLong, Folder, FolderPlus } from "./icons";
import { Modal, useModalClose } from "./Modal";
import { registry, useEnvironments } from "../lib/connection";
import { useHostRead } from "../lib/connection/hostRead";
import { NO_ANSWER } from "../lib/connection/openRead";
import { nameInLine } from "../lib/hostWords";
import { createPath, listDir, type FsEntry } from "../lib/fs";

/**
 * Pick a folder on another machine (thread K2). No native dialog can open
 * there, so this browses the host's work root over its link, makes a new
 * folder when asked, and takes a typed path when the folder is elsewhere.
 */

type WorkRoot = { root: string; home: string; hostname: string; platform: string; exists: boolean };

const parentOf = (path: string): string | null => {
  const trimmed = path.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  return at > 0 ? trimmed.slice(0, at) : at === 0 && trimmed.length > 1 ? "/" : null;
};

const joinPath = (dir: string, name: string): string => (dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`);

/** The crumbs from the work root down to `dir`; the root itself when `dir` is outside it. */
export function crumbsFor(root: string, dir: string): { label: string; path: string }[] {
  const base = root.replace(/\/+$/, "") || "/";
  const current = dir.replace(/\/+$/, "") || "/";
  if (current !== base && !current.startsWith(`${base}/`)) return [{ label: current, path: current }];
  const crumbs = [{ label: base.split("/").pop() || base, path: base }];
  if (current === base) return crumbs;
  let at = base;
  for (const part of current.slice(base.length + 1).split("/")) {
    at = joinPath(at, part);
    crumbs.push({ label: part, path: at });
  }
  return crumbs;
}

/** The caller's act on another computer, as the dialog's title: "Open a
 *  project on the box", "Add a workspace on the box", "Choose a folder on
 *  the box"; a host with no name known is "another computer", never its id. */
export function remoteFolderTitle(title: string | undefined, hostName: string | undefined): string {
  const act = title === "Add workspace" ? "Add a workspace" : title === "Choose folder" ? "Choose a folder" : "Open a project";
  return `${act} on ${hostName ? nameInLine(hostName) : "another computer"}`;
}

type Props = {
  environmentId: string;
  /** The caller's words for the pick (Open project, Add workspace, Choose folder): the title says that act. */
  title?: string;
  onClose: () => void;
  /** The folder chosen; the caller makes the workspace. */
  onPick: (path: string) => void;
};

export function RemoteFolderDialog(props: Props) {
  const environment = useEnvironments().find((e) => e.id === props.environmentId);
  const [pending, setPending] = useState(false);
  return (
    <Modal onClose={props.onClose} busy={pending} title={remoteFolderTitle(props.title, environment?.name)} size="md">
      <FolderPicker {...props} hostName={environment?.name} pending={pending} setPending={setPending} />
    </Modal>
  );
}

/** What the folder list's bones are drawn from: nobody reads the names, their lengths give the rows their shape. */
const SAMPLE_FOLDERS: readonly FsEntry[] = [
  { name: "temp-code", path: "sample:/work/temp-code", isDir: true, ignored: false },
  { name: "cosmic", path: "sample:/work/cosmic", isDir: true, ignored: false },
  { name: "lifeos-backend", path: "sample:/work/lifeos-backend", isDir: true, ignored: false },
];
const noop = () => {};

/** The folder list's rows: a press walks into a folder, a double press picks it. The list's bones are these rows
 *  given the sample. */
function FolderRows({ entries, onOpen, onPick }: { entries: readonly FsEntry[]; onOpen: (path: string) => void; onPick: (path: string) => void }) {
  return (
    <div className="flex flex-col p-1">
      {entries.map((entry) => (
        <ItemButton
          key={entry.path}
          size="xs"
          onClick={() => onOpen(entry.path)}
          onDoubleClick={() => onPick(entry.path)}
          className="rounded-sm text-start hover:bg-foreground/5"
        >
          <ItemMedia>
            <Folder className="size-3.5" />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="max-w-full font-normal">
              <span className="truncate">{entry.name}</span>
            </ItemTitle>
          </ItemContent>
        </ItemButton>
      ))}
    </div>
  );
}

/** A read that failed: its words, and Retry at the line's end for the read that failed. */
function ErrorRetry({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <ErrorLine error={error} />
      </div>
      <Button variant="secondary" size="sm" className="-my-1.5 shrink-0" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function FolderPicker({ environmentId, hostName, onClose, onPick, pending, setPending }: Props & { hostName?: string; pending: boolean; setPending: (on: boolean) => void }) {
  const close = useModalClose();
  // The work root is a host read: it waits for the link, and past 10 s says the host did not answer, with Retry.
  const link = useMemo(() => registry.linkOf(environmentId), [environmentId]);
  const rootRead = useHostRead(link, () => link.request<WorkRoot>("workspace.root"), environmentId);
  const workRoot = rootRead.value ?? null;
  const host = hostName ? nameInLine(hostName) : "another computer";
  const rootError = rootRead.error
    ? rootRead.error === NO_ANSWER
      ? `${host.charAt(0).toUpperCase()}${host.slice(1)} did not answer`
      : dialogErrorWords(new Error(rootRead.error), hostName)
    : null;
  const [dir, setDir] = useState<string | null>(null);
  // The last listing that came back: a folder that fails to list leaves it on screen.
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [listing, setListing] = useState(false);
  // The folder whose listing failed, for Retry beside its words.
  const [failed, setFailed] = useState<{ path: string; error: string } | null>(null);
  const [typed, setTyped] = useState("");
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = (path: string) => {
    if (close) close(() => onPick(path));
    else onPick(path);
  };

  // Only the newest listing lands: a slow answer for a folder already left is dropped.
  const latest = useRef(0);
  const load = useCallback(
    async (path: string) => {
      const n = ++latest.current;
      setListing(true);
      setFailed(null);
      setError(null);
      try {
        const listed = await listDir(environmentId, path);
        if (n !== latest.current) return;
        setEntries(listed.filter((e) => e.isDir && !e.name.startsWith(".")));
        setDir(path);
        setTyped(path);
      } catch (err) {
        if (n !== latest.current) return;
        setFailed({ path, error: dialogErrorWords(err) });
      }
      if (n === latest.current) setListing(false);
    },
    [environmentId],
  );

  useEffect(() => {
    if (!workRoot) return;
    const start = workRoot.exists ? workRoot.root : workRoot.home;
    setDir(start);
    setTyped(start);
    void load(start);
  }, [workRoot, load]);

  const crumbs = useMemo(() => (workRoot && dir ? crumbsFor(workRoot.root, dir) : []), [dir, workRoot]);
  const up = dir ? parentOf(dir) : null;
  const loading = !workRoot && !rootError;

  // While a new folder is named the footer is its own: Cancel goes back to the list (and focus to New folder), the confirm makes it.
  const newFolderButton = useRef<HTMLButtonElement>(null);
  const returning = useRef(false);
  const backToList = () => {
    returning.current = true;
    setNewFolder(null);
  };
  useEffect(() => {
    if (newFolder !== null || !returning.current) return;
    returning.current = false;
    newFolderButton.current?.focus();
  }, [newFolder]);

  const makeFolder = async (e?: FormEvent) => {
    e?.preventDefault();
    const folder = newFolder?.trim();
    if (!folder || !dir) return;
    setPending(true);
    setError(null);
    setFailed(null);
    try {
      const made = await createPath(environmentId, dir, folder, true);
      setPending(false);
      pick(made);
    } catch (err) {
      setError(dialogErrorWords(err));
      setPending(false);
    }
  };

  const choose = () => {
    const path = typed.trim();
    if (path) pick(path);
  };

  return (
    <>
      <div className="flex min-h-0 flex-col gap-3 px-5 py-4">
        {workRoot || loading ? (
          <>
            <Breadcrumb aria-label="Folder" className="-mx-2">
              <BreadcrumbList>
                {/* While the work root is read, the crumb it lands as, from a sample folder's name. */}
                {loading ? (
                  <BreadcrumbItem>
                    <Bones inline label="">
                      <BreadcrumbLink className="text-foreground">work</BreadcrumbLink>
                    </Bones>
                  </BreadcrumbItem>
                ) : null}
                {workRoot && up && crumbs.length === 1 && crumbs[0].path !== workRoot.root ? (
                  <BreadcrumbItem>
                    <BreadcrumbLink aria-label="Up a folder" onClick={() => void load(up)}>
                      <ArrowUpLong className="size-3.5" />
                    </BreadcrumbLink>
                  </BreadcrumbItem>
                ) : null}
                {crumbs.map((crumb, i) => {
                  const here = i === crumbs.length - 1;
                  return (
                    <BreadcrumbItem key={crumb.path}>
                      {i > 0 ? <BreadcrumbSeparator /> : null}
                      {/* The folder he is in stays a press: it reads the list again. */}
                      <BreadcrumbLink onClick={() => void load(crumb.path)} aria-current={here ? "location" : undefined} className={here ? "text-foreground" : undefined}>
                        {crumb.label}
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                  );
                })}
              </BreadcrumbList>
            </Breadcrumb>
            {/* A first listing that failed draws no list: the error and its Retry say it all. */}
            {!loading && !listing && entries === null ? null : <div className="flex min-h-0 flex-col rounded-lg border border-border" data-remote-folders>
              <Region loading={loading || listing || entries === null} label="Loading folders" className="min-h-0" bones={() => <FolderRows entries={SAMPLE_FOLDERS} onOpen={noop} onPick={noop} />}>
                {entries === null ? null : entries.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-muted-foreground">No folders</p>
                ) : (
                  <div className="max-h-64 min-h-0 overflow-x-hidden overflow-y-auto [--scrollbar-inset:var(--radius-lg)]">
                    <FolderRows entries={entries} onOpen={(path) => void load(path)} onPick={pick} />
                  </div>
                )}
              </Region>
            </div>}
            {newFolder === null ? (
              <div className="flex items-center gap-2">
                <Input
                  value={typed}
                  disabled={loading}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (typed.trim() !== dir) void load(typed.trim());
                    }
                  }}
                  aria-label="Folder path"
                  spellCheck={false}
                  autoComplete="off"
                  className="flex-1 font-mono text-xs"
                  data-remote-path
                />
                <Button ref={newFolderButton} variant="secondary" disabled={!dir} onClick={() => setNewFolder("")}>
                  <FolderPlus />
                  New folder
                </Button>
              </div>
            ) : (
              <form onSubmit={(e) => void makeFolder(e)}>
                <Input
                  value={newFolder}
                  autoFocus
                  disabled={pending}
                  onChange={(e) => setNewFolder(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      backToList();
                    }
                  }}
                  placeholder="Folder name"
                  aria-label="New folder name"
                  spellCheck={false}
                  autoComplete="off"
                  data-remote-new-folder
                />
              </form>
            )}
          </>
        ) : null}
        {rootError ? (
          <ErrorRetry error={rootError} onRetry={() => void rootRead.retry()} />
        ) : failed ? (
          <ErrorRetry error={failed.error} onRetry={() => void load(failed.path)} />
        ) : (
          <ErrorLine error={error} />
        )}
      </div>
      {newFolder === null ? (
        <DialogFooter onCancel={onClose} confirmLabel="Use this folder" onConfirm={choose} disabled={!typed.trim() || pending} />
      ) : (
        <DialogFooter confirmLabel="Create and use" onConfirm={() => void makeFolder()} pending={pending} disabled={!newFolder.trim()}>
          <Button data-dialog-cancel variant="secondary" disabled={pending} onClick={backToList}>
            Cancel
          </Button>
        </DialogFooter>
      )}
    </>
  );
}
