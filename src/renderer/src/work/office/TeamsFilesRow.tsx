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
  const [round, setRound] = useState(0);
  const read = useHostRead(link, () => link!.request<Libraries>("work.office.filesLibraries", {}), String(round));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const save = async (roots: TeamsRoot[], key: string): Promise<boolean> => {
    setBusy(key);
    setError(null);
    try {
      read.set(await link!.request<Libraries>("work.office.filesSetRoots", { roots }));
      return true;
    } catch (err) {
      setError(errorText(err));
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
        <PageRow key={row.folder} title={row.title} description={row.folder}>
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
          onClose={() => {
            setDialog(null);
            setRound((n) => n + 1);
          }}
          onSave={(text) => (dialog.kind === "add" ? save(withRoot(value.roots, text, {}), "add") : save(withRoot(value.roots, dialog.library.path, { web: text || undefined }), dialog.library.path))}
          error={error}
        />
      ) : null}
    </>
  );
}

function FolderDialog({ kind, initial, onSave, onClose, error }: { kind: "add" | "web"; initial: string; onSave: (text: string) => Promise<boolean>; onClose: () => void; error: string | null }) {
  const [text, setText] = useState(initial);
  const [pending, setPending] = useState(false);
  const { root, closeThen } = useClosingDialog(onClose, pending);
  const add = kind === "add";
  const confirm = async (): Promise<void> => {
    setPending(true);
    const ok = await onSave(text.trim());
    setPending(false);
    if (ok) closeThen(onClose);
  };
  return (
    <Dialog {...root}>
      <ModalPanel onClose={() => closeThen(onClose)} title={add ? "Add a Teams folder" : "Web link"} description={add ? "A folder OneDrive syncs that was not found." : "Paste the channel's Files → Copy link."} size="sm">
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
        <DialogFooter onCancel={() => closeThen(onClose)} confirmLabel={add ? "Add" : "Save"} pending={pending} disabled={add && !text.trim()} onConfirm={() => void confirm()} />
      </ModalPanel>
    </Dialog>
  );
}
