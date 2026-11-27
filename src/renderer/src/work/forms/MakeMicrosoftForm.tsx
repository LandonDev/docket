import { useMemo, useState, type ReactNode } from "react";
import type { FormBody } from "@shared/contract-work-forms";
import type { MsFormView } from "@shared/contract-work-msforms";
import type { FilePlace } from "@shared/work/files";
import { fromOurQuestion } from "@shared/work/msforms";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { FieldRow } from "../../chrome/DialogField";
import { Modal, ModalBody } from "../../chrome/Modal";
import { ChoiceSelect } from "../../components/choice-select";
import { Region } from "../../components/bones";
import { registry } from "../../lib/connection";
import { workErrorWords } from "../../lib/workErrorWords";
import type { MoreEntry } from "../canvas/kind";
import { openFileTab } from "../files/store";
import { Export } from "../icons";
import { MAKE_MS, useLibraryPlaces, useMsformsOffered } from "../msforms/offer";

/**
 * Make this a Microsoft form (docs/agents/work-forms.md "Make this a Microsoft form"): our form's row of the pane's
 * More, where the workspace's host makes Microsoft forms, and the dialog it opens. He picks a Teams or OneDrive
 * place; his press makes the form there at once with this form's title and questions (`work.msforms.make`, our
 * types as Forms' own: `fromOurQuestion`), then opens it in its Files tab. Our form stays as it is.
 */

/** A place as the picker names it: its group, then its name. */
const placeLabel = (p: FilePlace): string => (p.group && p.group !== p.name ? `${p.group}, ${p.name}` : p.name);

export function useMakeMicrosoftForm({ env, workspaceId, body }: { env: string; workspaceId: string | null; body: FormBody | null }): { row: MoreEntry | null; dialog: ReactNode } {
  const offered = useMsformsOffered(env, workspaceId);
  const [open, setOpen] = useState(false);
  const ready = offered && !!workspaceId && !!body?.questions.length;
  const row = useMemo<MoreEntry | null>(() => (ready ? { id: "msform", label: "Make this a Microsoft form", icon: Export, run: () => setOpen(true) } : null), [ready]);
  return { row, dialog: open && ready && workspaceId && body ? <MakeMicrosoftFormDialog env={env} workspaceId={workspaceId} body={body} onClose={() => setOpen(false)} /> : null };
}

export function MakeMicrosoftFormDialog({ env, workspaceId, body, onClose }: { env: string; workspaceId: string; body: FormBody; onClose(): void }) {
  const places = useLibraryPlaces(env, workspaceId, true);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const place = places?.find((p) => p.id === picked) ?? places?.[0] ?? null;

  const make = async (): Promise<void> => {
    if (making || !place || place.root.at !== "file") return;
    setMaking(true);
    setError(null);
    try {
      const view = await registry.linkOf(env).request<MsFormView>(
        "work.msforms.make",
        {
          workspaceId,
          folder: { at: "file", host: place.root.host, path: place.root.path },
          title: body.title.slice(0, 90),
          ...(body.description.trim() ? { description: body.description.slice(0, 1000) } : {}),
          questions: body.questions.slice(0, 100).map(fromOurQuestion),
        },
        { timeoutMs: MAKE_MS },
      );
      onClose();
      await openFileTab(env, workspaceId, { ref: { at: "msform", host: env, workspaceId, formId: view.formId, tenant: view.tenant }, name: view.title });
    } catch (err) {
      setError(workErrorWords(err) || "Couldn't make the form in Forms");
      setMaking(false);
    }
  };

  return (
    <Modal title="Make a Microsoft form" onClose={onClose} busy={making}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void make();
        }}
      >
        <ModalBody>
          <Region loading={!places} label="Loading the folders" bones={FolderBones}>
            {places?.length ? (
              <FieldRow label="Folder">
                <ChoiceSelect label="Folder" value={place?.id ?? ""} options={places.map((p) => ({ value: p.id, label: placeLabel(p) }))} onChange={setPicked} disabled={making} />
              </FieldRow>
            ) : places ? (
              <p className="text-[13px] leading-5 text-muted-foreground">No Teams or OneDrive folder is on this computer.</p>
            ) : null}
          </Region>
          <ErrorLine error={error} />
        </ModalBody>
        <DialogFooter onCancel={onClose} confirmLabel="Make" disabled={!place} pending={making} />
      </form>
    </Modal>
  );
}

/** The folder's row at rest, with one folder in it: its bones while the places are read. */
function FolderBones() {
  return (
    <FieldRow label="Folder">
      <ChoiceSelect label="Folder" value="sample:place" options={[{ value: "sample:place", label: "Purdue RecWell, Esports" }]} onChange={() => undefined} />
    </FieldRow>
  );
}
