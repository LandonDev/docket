import { useState } from "react";
import type { TeamsLibrary, TeamsRoot } from "@shared/contract-work-office";
import { Field } from "../../chrome/DialogField";
import { DialogFooter, ErrorLine, errorText } from "../../chrome/ConfirmDialog";
import { ModalBody, ModalPanel, useClosingDialog } from "../../chrome/Modal";
import { PageRow, PageRowsSkeleton } from "../../components/page";
import { SettingSwitch } from "../../components/setting-switch";
import { BusyLabel, Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import type { Link } from "../../lib/connection/link";
import { useHostRead } from "../../lib/connection/hostRead";

/**
 * Settings → Work, "Where it runs": which folders on one host count as Teams files
 * (docs/agents/work-files.md "Settings"). Each library OneDrive syncs there is found and on by
 * default; he turns one off, adds a folder it missed, or gives one its web address (a channel's
 * Files → Copy link) for Open on the web. Only this computer's own window edits its list.
 */

type Libraries = { libraries: TeamsLibrary[]; roots: TeamsRoot[]; off: string[] };

/** A library's name as the row reads it. */
export const libraryTitle = (l: Pick<TeamsLibrary, "kind" | "team" | "library">): string => (l.kind === "mine" ? "My files" : l.library ? `${l.team} ${l.library}` : l.team);

/** A folder he added himself: a library the host did not find. Off folders and found libraries are named by their team. */
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

export function TeamsFilesRow({ link, title, editable }: { link: Link | null | undefined; title: string; editable: boolean }) {
  const read = useHostRead(link, () => link!.request<Libraries>("work.office.filesLibraries", {}));
  const [busy, setBusy] = useState<string | null>(null);
  // A row's own save (a switch, Remove) says its failure on the Teams files row; a dialog's, in the dialog alone.
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: "add" } | { kind: "web"; library: TeamsLibrary } | null>(null);
  const value = read.value;
  if (!value) {
    if (!read.error) return <PageRowsSkeleton rows={1} description control="button" />;
    return (
      <PageRow title={title} error={read.error}>
        <Button variant="ghost" size="sm" onClick={read.retry}>
          Retry
        </Button>
      </PageRow>
    );
  }
  const save = async (roots: TeamsRoot[], key: string, from: "row" | "dialog" = "row"): Promise<boolean> => {
    const say = from === "dialog" ? setDialogError : setError;
    setBusy(key);
    say(null);
    try {
      read.set(await link!.request<Libraries>("work.office.filesSetRoots", { roots }));
      return true;
    } catch (err) {
      say(errorText(err));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const shown = [...value.libraries.map((l) => ({ folder: l.path, title: libraryTitle(l), library: l, on: true })), ...value.off.map((folder) => ({ folder, title: folder.split(/[\\/]/).pop() ?? folder, library: null, on: false }))];
  return (
    <>
      <PageRow title={title} description={shown.length ? undefined : "None synced"} error={error ?? undefined}>
        {editable ? (
          <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: "add" })}>
            Add folder…
          </Button>
        ) : null}
      </PageRow>
      {shown.map((row) => (
        // A folder he added shows its path; a library found by its team and channel is named well enough, its path in a tip that focus opens as hover does.
        <PageRow
          key={row.folder}
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
          description={added(row.library) ? row.folder : undefined}
        >
          {editable ? (
            <div className="flex items-center gap-2">
              {row.library && row.on ? (
                <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: "web", library: row.library! })}>
                  {row.library.web ? "Web link…" : "Add web link…"}
                </Button>
              ) : null}
              {row.library && !row.library.found ? (
                <Button variant="ghost" size="sm" disabled={busy === row.folder} onClick={() => void save(withRoot(value.roots, row.folder, null), row.folder)}>
                  <BusyLabel busy={busy === row.folder} label="Remove" />
                </Button>
              ) : (
                <SettingSwitch label={row.title} on={row.on} disabled={busy === row.folder} onChange={(on) => save(withRoot(value.roots, row.folder, { off: !on }), row.folder)} />
              )}
            </div>
          ) : null}
        </PageRow>
      ))}
      {dialog ? (
        <FolderDialog
          kind={dialog.kind}
          initial={dialog.kind === "web" ? (dialog.library.web ?? "") : ""}
          onClose={(saved) => {
            setDialog(null);
            setDialogError(null);
            // A save already holds the host's answer; otherwise ask again, keeping what is shown meanwhile.
            if (!saved) read.retry();
          }}
          onSave={(text) =>
            dialog.kind === "add" ? save(withRoot(value.roots, text, {}), "add", "dialog") : save(withRoot(value.roots, dialog.library.path, { web: text || undefined }), dialog.library.path, "dialog")
          }
          error={dialogError}
        />
      ) : null}
    </>
  );
}

function FolderDialog({ kind, initial, onSave, onClose, error }: { kind: "add" | "web"; initial: string; onSave: (text: string) => Promise<boolean>; onClose: (saved: boolean) => void; error: string | null }) {
  const [text, setText] = useState(initial);
  const [pending, setPending] = useState(false);
  const cancel = (): void => onClose(false);
  const { root, closeThen } = useClosingDialog(cancel, pending);
  const add = kind === "add";
  const confirm = async (): Promise<void> => {
    setPending(true);
    const ok = await onSave(text.trim());
    setPending(false);
    if (ok) closeThen(() => onClose(true));
  };
  return (
    <Dialog {...root}>
      <ModalPanel onClose={() => closeThen(cancel)} title={add ? "Add a Teams folder" : "Web link"} description={add ? "A folder OneDrive syncs that was not found." : "Paste the channel's Files → Copy link."} size="sm">
        <ModalBody>
          <Field label={add ? "Folder" : "Link"}>
            <Input
              autoFocus
              value={text}
              placeholder={add ? "~/Library/CloudStorage/…" : "https://…sharepoint.com/…"}
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && (add ? text.trim() : true) && void confirm()}
            />
          </Field>
          <ErrorLine error={error} />
        </ModalBody>
        <DialogFooter onCancel={() => closeThen(cancel)} confirmLabel={add ? "Add" : "Save"} pending={pending} disabled={add && !text.trim()} onConfirm={() => void confirm()} />
      </ModalPanel>
    </Dialog>
  );
}
