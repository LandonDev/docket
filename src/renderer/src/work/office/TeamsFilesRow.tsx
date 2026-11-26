import { useState } from "react";
import type { TeamsLibrary, TeamsPlace, TeamsRoot } from "@shared/contract-work-office";
import { Field } from "../../chrome/DialogField";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { ModalBody, ModalPanel, useClosingDialog } from "../../chrome/Modal";
import { PageEmpty, PageError, PageRow, PageRowsSkeleton, PageSection } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { ChoiceSelect } from "../../components/choice-select";
import { BusyLabel, Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { StatusMark } from "../../components/ui/status";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import type { Link } from "../../lib/connection/link";
import { useHostRead } from "../../lib/connection/hostRead";
import { pickFolder } from "../../lib/fs";
import { nameInLine } from "../../lib/hostWords";
import { workErrorWords } from "../../lib/workErrorWords";
import { nativePlatform } from "../../lib/native";
import { isWebMode } from "../../lib/nativeWeb";
import { ListFilter, useListFilter } from "../../surfaces/settings/parts/ListFilter";
import { SaveMark } from "../../surfaces/settings/parts/SaveMark";
import { useSaved } from "../../surfaces/settings/parts/useSaved";
import { useKeptRetry } from "./keptRetry";
import { MoreHorizontal } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";

/**
 * Settings → Files, a section a computer (docs/agents/work-teams-files.md "Settings", docs/agents/settings.md "The
 * pages: Work"): the folders on it that Files lists as shared places, "Folders on <computer>", or the Windows VM's,
 * "Folders in the Windows VM" (`vm`: the libraries that lie in the guest). Add folder… stands at the heading's end.
 * Each library OneDrive syncs there is found and on by default; he turns one off, or adds any folder (a network
 * drive's too) and stops listing it. Each library row says where its Office files open, and opens a dialog for that
 * and its web address (a channel's Files → Copy link). Only this computer's own window edits its list: another's
 * rows are words, and `elsewhere` says where they are changed. A list past eight rows gets a find field.
 */

type Libraries = { libraries: TeamsLibrary[]; roots: TeamsRoot[]; off: string[]; places?: TeamsPlace[] };

/** The row's line when it lists nothing: what OneDrive's folders on this computer (or in its Windows VM) say, where it says. */
export function noneLine(places: readonly TeamsPlace[] | undefined, vm = false): string {
  if (vm) {
    const place = places?.find((p) => p.kind === "vm");
    if (place?.state === "signed-out") return "OneDrive in the Windows VM is not signed in";
    if (place?.state === "reading") return "Reading the Windows VM's folders…";
    if (place?.state === "error") return place.detail ?? "The Windows VM's folders could not be read";
    return "None synced";
  }
  const folders = places?.find((p) => p.kind === "folders");
  if (folders?.state === "no-onedrive") return "OneDrive is not signed in here";
  if (folders?.state === "error") return folders.detail ?? "OneDrive's folders could not be read";
  return "None synced";
}

/** A library's name as the row reads it. */
export const libraryTitle = (l: Pick<TeamsLibrary, "kind" | "team" | "library">): string => (l.kind === "mine" ? "My files" : l.library ? `${l.team} ${l.library}` : l.team);

/** A folder he added himself: a library the computer did not find. Off folders and found libraries are named by their team. */
const added = (library: TeamsLibrary | null): boolean => !!library && !library.found;

/** His list with one folder's row changed; a row that says nothing more is dropped. */
export function withRoot(roots: readonly TeamsRoot[], folder: string, change: Partial<TeamsRoot> | null): TeamsRoot[] {
  const rest = roots.filter((r) => r.folder !== folder);
  if (change === null) return rest;
  const next: TeamsRoot = { ...roots.find((r) => r.folder === folder), ...change, folder };
  if (!next.off) delete next.off;
  if (!next.web) delete next.web;
  return [...rest, next];
}

/** A failure on a computer's folders in his words, naming it: `workErrorWords`, else the act's own line. */
function folderFailure(err: unknown, host: string | undefined, act: string, write = false): string {
  const name = host ? nameInLine(host) : undefined;
  return workErrorWords(err, { host: name, write }) || `${name ? name.charAt(0).toUpperCase() + name.slice(1) : "The computer"} ${act}.`;
}

/** A computer that keeps a Windows VM: its libraries in the guest are a section of their own. */
const keepsVm = (value: Libraries): boolean => value.libraries.some((l) => l.vm) || value.places?.some((p) => p.kind === "vm" && p.state !== "not-set-up") === true;
/** An off folder's section: on a computer that keeps a VM, a path with a drive letter is the guest's; else every off folder is its own. */
const offIn = (folder: string, value: Libraries, vm: boolean): boolean => (keepsVm(value) && /^[A-Za-z]:[\\/]/.test(folder)) === vm;

/** What a row's switch does, said once over the list. */
const LISTED_LINE = "On means listed in Files.";
/** A folder he added leaves the list from its menu: one press, nothing on disk changes, Add folder… brings it back. */
const FOLDER_MENU: MenuRow[] = [{ kind: "item", id: "stop", label: "Stop listing" }];

/** The way most libraries' Office files open; none when two ways tie with no majority. */
export function mostOpens(modes: readonly OpensIn[]): OpensIn | undefined {
  const live = modes.filter((m) => m === "live").length;
  const here = modes.length - live;
  return live === here ? undefined : live > here ? "live" : "here";
}

type FolderRowValue = { folder: string; title: string; library: TeamsLibrary | null; on: boolean };
const rowWords = (row: FolderRowValue): string => `${row.title} ${row.folder}`;

export function TeamsFilesRow({
  link,
  title,
  host,
  editable,
  vm = false,
  setting,
  elsewhere,
}: {
  link: Link | null | undefined;
  title: string;
  host?: string;
  editable: boolean;
  /** The Windows VM's folders on this computer, not its own. */
  vm?: boolean;
  /** The section's place in the map (lib/settings/map.ts). */
  setting?: string;
  /** Where the list is changed, for a window that may not: "Changed in Docket on PURDUE-LT". */
  elsewhere?: string;
}) {
  const read = useHostRead(link, () => link!.request<Libraries>("work.office.filesLibraries", {}));
  // A dialog's failed save says so in the dialog alone; a row's, under the row.
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: "add" } | { kind: "library"; library: TeamsLibrary; title: string } | null>(null);
  const value = read.value;
  const kept = useKeptRetry(read.error, value === undefined && read.error === null);
  const shown: FolderRowValue[] = value
    ? [
        ...value.libraries.filter((l) => !!l.vm === vm).map((l) => ({ folder: l.path, title: libraryTitle(l), library: l, on: true })),
        ...value.off.filter((folder) => offIn(folder, value, vm)).map((folder) => ({ folder, title: folder.split(/[\\/]/).pop() ?? folder, library: null, on: false })),
      ]
    : [];
  const filter = useListFilter(shown, rowWords);
  // Where each listed library's Office files open, read together: the way most open is said once, in the heading's line.
  const libraryIds = value ? value.libraries.filter((l) => !!l.vm === vm).map((l) => l.id) : [];
  const modes = useHostRead(
    libraryIds.length ? link : null,
    () => Promise.all(libraryIds.map((libraryId) => link!.request<{ mode: OpensIn }>("work.office.live.libraryDefault", { libraryId }).then((a) => [libraryId, a.mode] as const))).then((pairs) => new Map(pairs)),
    libraryIds.join(","),
  );
  const common = modes.value ? mostOpens([...modes.value.values()]) : undefined;
  if (!value)
    return (
      <PageSection title={title} data-setting={setting}>
        {kept.error ? (
          <PageError
            action={
              <Button variant="ghost" size="sm" disabled={kept.retrying} onClick={() => kept.press(read.retry)}>
                <BusyLabel busy={kept.retrying} label="Retry" />
              </Button>
            }
          >
            {folderFailure(kept.error, host, "could not list its folders")}
          </PageError>
        ) : (
          <PageRowsSkeleton rows={3} description control="switch" />
        )}
      </PageSection>
    );
  // A computer with no Windows VM set up has no VM section at all.
  if (vm && !keepsVm(value)) return null;
  const add = editable ? (
    // A ghost press over a column of ghost presses (Stop listing) and switches: its box ends on the column's edge as theirs do.
    <Button variant="ghost" size="sm" data-setting={vm ? undefined : "files.add"} onClick={() => setDialog({ kind: "add" })}>
      Add folder…
    </Button>
  ) : undefined;
  /** One write of his list; a refusal comes back in his words, naming the computer. */
  const put = async (roots: TeamsRoot[]): Promise<void> => {
    try {
      read.set(await link!.request<Libraries>("work.office.filesSetRoots", { roots }));
    } catch (err) {
      throw new Error(folderFailure(err, host, "did not save the folders", true));
    }
  };
  const saveDialog = async (roots: TeamsRoot[]): Promise<boolean> => {
    setDialogError(null);
    try {
      await put(roots);
      return true;
    } catch (err) {
      setDialogError((err as Error).message);
      return false;
    }
  };
  const closed = (saved: boolean): void => {
    setDialog(null);
    setDialogError(null);
    // A save already holds the computer's answer; otherwise ask again, keeping what is shown meanwhile.
    if (!saved) read.retry();
    void modes.retry();
  };
  return (
    <PageSection title={title} action={add} data-setting={setting} description={shown.length ? [LISTED_LINE, common ? `${OPENS_LINE[common]}.` : null].filter(Boolean).join(" ") : undefined}>
      <ListFilter filter={filter} label="Find a folder" />
      {shown.length ? null : <PageEmpty>{noneLine(value.places, vm)}</PageEmpty>}
      {filter.shown.map((row) => (
        <FolderRow
          key={row.folder}
          row={row}
          // A library says where its files open only where it differs from the heading's line.
          opens={row.library && row.on ? (modes.value?.get(row.library.id) ?? null) : null}
          common={common ?? null}
          editable={editable}
          onSwitch={(on) => put(withRoot(value.roots, row.folder, { off: !on }))}
          onStop={() => put(withRoot(value.roots, row.folder, null))}
          onOpen={row.library && row.on && editable ? () => setDialog({ kind: "library", library: row.library!, title: row.title }) : undefined}
        />
      ))}
      {!editable && elsewhere ? <PageEmpty data-managed="">{elsewhere}</PageEmpty> : null}
      {dialog?.kind === "add" ? <FolderDialog onClose={closed} onSave={(text) => saveDialog(withRoot(value.roots, text, {}))} error={dialogError} /> : null}
      {dialog?.kind === "library" ? (
        <LibraryDialog
          link={link!}
          library={dialog.library}
          title={dialog.title}
          onClose={closed}
          onSaveWeb={(web) => saveDialog(withRoot(value.roots, dialog.library.path, { web: web || undefined }))}
          error={dialogError}
          setError={setDialogError}
        />
      ) : null}
    </PageSection>
  );
}

/** One folder: its name (a found library's path in a tip), where its Office files open, and its one control. */
function FolderRow({
  row,
  opens,
  common,
  editable,
  onSwitch,
  onStop,
  onOpen,
}: {
  row: FolderRowValue;
  opens: OpensIn | null;
  common: OpensIn | null;
  editable: boolean;
  onSwitch: (on: boolean) => Promise<void>;
  onStop: () => Promise<void>;
  onOpen?: () => void;
}) {
  const saved = useSaved();
  // Each fact a line of its own, never joined to the next: the path of a folder he added, a slow folder's reason, and
  // where its Office files open where that differs from the heading's line (the dialog changes it).
  const lines = [added(row.library) ? row.folder : null, row.library?.slow ?? null, opens && opens !== common ? OPENS_LINE[opens] : null].filter((line): line is string => !!line);
  const busy = saved.state === "saving" || saved.state === "slow";
  return (
    <PageRow
      data-folder={row.folder}
      title={
        added(row.library) ? (
          row.title
        ) : (
          <Tooltip>
            <TooltipTrigger render={<span data-library-path={row.folder} tabIndex={0} className="focus-ring rounded-sm" />}>{row.title}</TooltipTrigger>
            <TooltipContent side="bottom" align="start" className="max-w-sm break-all">
              {row.folder}
            </TooltipContent>
          </Tooltip>
        )
      }
      description={
        lines.length
          ? lines.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))
          : undefined
      }
      error={saved.error}
      onOpen={onOpen}
      openLabel={`${row.title}: where its files open`}
    >
      {editable ? (
        <>
          <SaveMark state={saved.state} />
          {/* One control for listing on every row; a folder he added can also be taken off the list, in its menu. */}
          <SettingSwitch label={row.title} on={row.on} disabled={busy} onChange={(on) => saved.run(() => onSwitch(on))} />
          {row.library && !row.library.found ? (
            <RowsMenu
              label={`${row.title} actions`}
              trigger={
                <Button variant="ghost" size="icon-sm" aria-label={`${row.title} actions`} disabled={busy} className="text-muted-foreground">
                  <MoreHorizontal />
                </Button>
              }
              rows={FOLDER_MENU}
              onPick={() => void saved.run(onStop)}
              align="end"
            />
          ) : null}
        </>
      ) : (
        <StatusMark state="idle" glyph={false} word={row.on ? "On" : "Off"} className="text-xs" />
      )}
    </PageRow>
  );
}

const OPENS_IN = [
  { value: "here", label: "Edit here" },
  { value: "live", label: "Office for the web" },
] as const;
type OpensIn = (typeof OPENS_IN)[number]["value"];
export const OPENS_LINE: Record<OpensIn, string> = { here: "Office files open here", live: "Office files open in Office for the web" };

/**
 * Where a shared Office file of this library opens until he picks for the file itself (docs/agents/work-office-live.md
 * "The control"): Edit here (TempCode's own editor), or Office for the web (Word, Excel or PowerPoint for the web).
 */
function useOpensIn(link: Link, libraryId: string | null): OpensIn | null {
  const read = useHostRead(libraryId ? link : null, () => link.request<{ mode: OpensIn }>("work.office.live.libraryDefault", { libraryId }), libraryId ?? "");
  return read.value?.mode ?? null;
}

/** A library's own settings: where its Office files open, and its web address. Save writes what changed. */
function LibraryDialog({
  link,
  library,
  title,
  onSaveWeb,
  onClose,
  error,
  setError,
}: {
  link: Link;
  library: TeamsLibrary;
  title: string;
  onSaveWeb: (web: string) => Promise<boolean>;
  onClose: (saved: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
}) {
  const opens = useOpensIn(link, library.id);
  const [mode, setMode] = useState<OpensIn | null>(null);
  const [web, setWeb] = useState(library.web ?? "");
  const [pending, setPending] = useState(false);
  const cancel = (): void => onClose(false);
  const { root, closeThen } = useClosingDialog(cancel, pending);
  const chosen = mode ?? opens;
  const modeChanged = mode !== null && mode !== opens;
  const webChanged = web.trim() !== (library.web ?? "");
  const confirm = async (): Promise<void> => {
    setPending(true);
    setError(null);
    let ok = true;
    if (modeChanged)
      ok = await link.request("work.office.live.setLibraryDefault", { libraryId: library.id, mode }).then(
        () => true,
        (err: unknown) => {
          setError(workErrorWords(err, { write: true }) || "Where its files open did not save.");
          return false;
        },
      );
    if (ok && webChanged) ok = await onSaveWeb(web.trim());
    setPending(false);
    if (ok) closeThen(() => onClose(true));
  };
  return (
    <Dialog {...root}>
      <ModalPanel onClose={() => closeThen(cancel)} title={title} size="sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (modeChanged || webChanged) void confirm();
          }}
        >
          <ModalBody>
            <Field label="Office files open in">
              {chosen ? (
                <ChoiceSelect label="Office files open in" value={chosen} options={[...OPENS_IN]} disabled={pending} onChange={(next) => setMode(next)} />
              ) : (
                <Skeleton className="h-8 w-full" />
              )}
            </Field>
            <Field label="Web link" hint="The library folder's address, from the browser's address bar in SharePoint.">
              <Input value={web} placeholder="https://…sharepoint.com/…" spellCheck={false} disabled={pending} onChange={(event) => setWeb(event.target.value)} />
            </Field>
            <ErrorLine error={error} />
          </ModalBody>
          <DialogFooter onCancel={() => closeThen(cancel)} confirmLabel="Save" pending={pending} disabled={!modeChanged && !webChanged} />
        </form>
      </ModalPanel>
    </Dialog>
  );
}

/** The Add folder field's hint, in this machine's own spelling: a mapped drive on Windows, a home folder elsewhere. */
export const folderHint = (platform: string = nativePlatform()): string => (platform === "win32" ? "J:\\Shared" : "~/Documents/…");

function FolderDialog({ onSave, onClose, error }: { onSave: (text: string) => Promise<boolean>; onClose: (saved: boolean) => void; error: string | null }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const cancel = (): void => onClose(false);
  const { root, closeThen } = useClosingDialog(cancel, pending);
  const confirm = async (): Promise<void> => {
    setPending(true);
    const ok = await onSave(text.trim());
    setPending(false);
    if (ok) closeThen(() => onClose(true));
  };
  return (
    <Dialog {...root}>
      <ModalPanel onClose={() => closeThen(cancel)} title="Add a folder" size="sm">
        <ModalBody>
          <div className="flex items-end gap-2">
            <Field label="Folder" className="flex-1">
              <Input
                autoFocus
                value={text}
                placeholder={folderHint()}
                spellCheck={false}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && text.trim() && void confirm()}
              />
            </Field>
            {!isWebMode() ? (
              <Button type="button" variant="secondary" onClick={() => void pickFolder("Add a folder").then((picked) => picked && setText(picked))}>
                Browse…
              </Button>
            ) : null}
          </div>
          <ErrorLine error={error} />
        </ModalBody>
        <DialogFooter onCancel={() => closeThen(cancel)} confirmLabel="Add" pending={pending} disabled={!text.trim()} onConfirm={() => void confirm()} />
      </ModalPanel>
    </Dialog>
  );
}
