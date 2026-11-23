import { useState } from "react";
import type { FolderRef } from "@shared/work/files";
import type { Template } from "@shared/work/templates";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { makeFrom, useTemplates } from "./data";
import { FieldsForm } from "./FieldsForm";
import { folderName, shelfGroups } from "./model";
import { openMade } from "./open";
import { Shelf, ShelfSkeleton } from "./Shelf";

/**
 * "New from a template" (docs/agents/work-templates.md "New from a template"):
 * the shelf's two groups as a three-column grid (two under 640px). A tile with
 * no fields makes its file, which opens in a Files tab, and the dialog closes;
 * one with fields turns this same dialog to them, with the way back. Opened on
 * one template (the shelf page's press) it starts at the fields and has no way
 * back. The footer names the folder the file is kept in only when the caller
 * gave one. The swap between the two is a 120ms fade, none under reduced motion.
 */
export function TemplateDialog({
  env,
  workspaceId,
  into,
  intoName,
  template,
  onClose,
}: {
  env: string;
  workspaceId: string;
  into?: FolderRef;
  intoName?: string;
  /** Start at this template's fields. */
  template?: Template;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<Template | null>(template ?? null);
  const [making, setMaking] = useState<string | null>(null);
  return (
    <Modal title={chosen ? chosen.name : "New from a template"} size="md" busy={making !== null} onClose={onClose} data-templates-dialog="">
      <TemplateSteps
        env={env}
        workspaceId={workspaceId}
        into={into}
        intoName={intoName}
        chosen={chosen}
        fromTiles={!template}
        making={making}
        setMaking={setMaking}
        choose={setChosen}
        onClose={onClose}
      />
    </Modal>
  );
}

/** The swap's fade, on the step that arrives; none under reduced motion. */
const ARRIVE = "flex min-h-0 flex-col transition-opacity duration-(--dur-fast) ease-(--ease-out) starting:opacity-0 motion-reduce:transition-none";

export function TemplateSteps({
  env,
  workspaceId,
  into,
  intoName,
  chosen,
  fromTiles,
  making,
  setMaking,
  choose,
  onClose,
}: {
  env: string;
  workspaceId: string;
  into?: FolderRef;
  intoName?: string;
  chosen: Template | null;
  fromTiles: boolean;
  making: string | null;
  setMaking: (id: string | null) => void;
  choose: (template: Template | null) => void;
  onClose: () => void;
}) {
  const close = useModalClose();
  const [load, retry] = useTemplates(env, workspaceId);
  const [error, setError] = useState<string | null>(null);
  const jobName = useWorkspaces().find((w) => w.id === workspaceId)?.name ?? "This job";

  const make = async (template: Template, fields?: Record<string, string>) => {
    setMaking(template.id);
    setError(null);
    try {
      const made = await makeFrom(env, workspaceId, template.id, { ...(into ? { into } : {}), ...(fields ? { fields } : {}) });
      await openMade({ workspaceId, source: made.source });
      setMaking(null);
      if (close) close(onClose);
      else onClose();
    } catch (err) {
      setMaking(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (chosen)
    return (
      <div key="fields" className={ARRIVE}>
        <FieldsForm
          template={chosen}
          pending={making === chosen.id}
          error={error}
          onBack={
            fromTiles
              ? () => {
                  setError(null);
                  choose(null);
                }
              : undefined
          }
          onCancel={onClose}
          onCreate={(fields) => void make(chosen, fields)}
        />
      </div>
    );

  const kept = into ? folderName(into, intoName) : null;
  const groups = load.status === "ready" ? shelfGroups(load.value.templates, jobName) : [];
  return (
    <div key="tiles" className={ARRIVE}>
      <ModalBody>
        {load.status === "loading" ? (
          <ShelfSkeleton layout="dialog" />
        ) : load.status === "error" ? (
          <EmptyState title="Templates did not load" line={load.error} action={{ label: "Retry", onClick: retry }} />
        ) : groups.length === 0 ? (
          <EmptyState title="No templates" />
        ) : (
          <Shelf
            groups={groups}
            layout="dialog"
            making={making}
            onPress={(t) => {
              if (making) return;
              if (t.fields.length) {
                setError(null);
                choose(t);
              } else void make(t);
            }}
          />
        )}
        <ErrorLine error={error} />
      </ModalBody>
      <DialogFooter note={kept ? `Kept in ${kept}` : undefined} onCancel={onClose} />
    </div>
  );
}
