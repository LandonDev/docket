import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasSource } from "@shared/work/canvas";
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
 * gave one. The swap between the two is a 120ms fade, none under reduced motion,
 * in a frame that keeps the tiles' height; Back returns the focus and the scroll
 * to the tile that opened the fields. A file made whose open failed is opened
 * again on the next press, never made twice.
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

/** Focus that has not moved since the dialog opened: on nothing, on the dialog, or on the Cancel it lands on while the shelf loads. */
const unmoved = (el: Element | null): boolean => !el || el === document.body || el.getAttribute("role") === "dialog" || el.matches("[data-dialog-cancel]");

/** The dialog's one scroller (chrome/Modal.tsx). */
const scrollerOf = (el: Element | null): HTMLElement | null => el?.closest<HTMLElement>(".overflow-y-auto") ?? null;

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
  // A file made whose open failed, by template: a press again opens it and never makes a second.
  const [made, setMade] = useState<{ id: string; source: CanvasSource; title: string } | null>(null);
  // The tile that turned the dialog to its fields, where Back returns: the tile, the scroll, the frame's height.
  const [opener, setOpener] = useState<{ id: string; top: number; height: number } | null>(null);
  const tiles = useRef<HTMLDivElement | null>(null);
  const jobName = useWorkspaces().find((w) => w.id === workspaceId)?.name ?? "This job";
  const ready = load.status === "ready";

  // The shelf arrived and he has not moved: the first tile takes the focus, so the arrows work at once.
  useEffect(() => {
    if (!ready || chosen || opener) return;
    if (unmoved(document.activeElement)) tiles.current?.querySelector<HTMLElement>("[data-tile-open]")?.focus({ preventScroll: true });
  }, [ready, chosen, opener]);

  // Back: the tile that opened the fields takes the focus again, at the scroll it was left at.
  useLayoutEffect(() => {
    if (chosen || !opener || !tiles.current) return;
    const scroller = scrollerOf(tiles.current);
    if (scroller) scroller.scrollTop = opener.top;
    tiles.current.querySelector<HTMLElement>(`[data-tile="${CSS.escape(opener.id)}"] [data-tile-open]`)?.focus({ preventScroll: true });
  }, [chosen, opener]);

  const open = async (file: { id: string; source: CanvasSource; title: string }) => {
    try {
      await openMade({ workspaceId, source: file.source });
    } catch (err) {
      setMade(file);
      setError(`${file.title} was made but did not open. ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    setMade(null);
    if (close) close(onClose);
    else onClose();
  };

  const make = async (template: Template, fields?: Record<string, string>) => {
    setMaking(template.id);
    setError(null);
    try {
      // Made already, its open failed: open that file, never a second one.
      if (made?.id === template.id) await open(made);
      else {
        let file: { id: string; source: CanvasSource; title: string };
        try {
          const answer = await makeFrom(env, workspaceId, template.id, { ...(into ? { into } : {}), ...(fields ? { fields } : {}) });
          file = { id: template.id, source: answer.source, title: answer.title };
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          return;
        }
        await open(file);
      }
    } finally {
      setMaking(null);
    }
  };

  const turnTo = (t: Template) => {
    const box = tiles.current?.closest<HTMLElement>("[data-step]");
    const scroller = scrollerOf(tiles.current);
    // Never taller than the scroller shows, or the fields' footer would sit below its fold.
    const height = Math.min(box?.offsetHeight ?? 0, scroller?.clientHeight || Infinity);
    setOpener({ id: t.id, top: scroller?.scrollTop ?? 0, height });
    setError(null);
    choose(t);
  };

  if (chosen)
    return (
      // The frame keeps the tiles' height, so the dialog does not jump: the fields at the top, the footer at the bottom.
      <div key="fields" data-step="fields" className={ARRIVE} style={opener?.height ? { minHeight: opener.height } : undefined}>
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
  const groups = ready ? shelfGroups(load.value.templates, jobName) : [];
  return (
    <div key="tiles" data-step="tiles" className={ARRIVE}>
      <ModalBody>
        {load.status === "loading" ? (
          <ShelfSkeleton layout="dialog" />
        ) : load.status === "error" ? (
          <EmptyState title="Templates did not load" line={load.error} action={{ label: "Retry", onClick: retry }} />
        ) : groups.length === 0 ? (
          <EmptyState title="No templates" />
        ) : (
          <div ref={tiles}>
            <Shelf
              groups={groups}
              layout="dialog"
              making={making}
              focusId={opener?.id ?? null}
              onPress={(t) => {
                if (making) return;
                if (t.fields.length && made?.id !== t.id) turnTo(t);
                else void make(t);
              }}
            />
          </div>
        )}
        <div role="alert" className="contents">
          <ErrorLine error={error} />
        </div>
      </ModalBody>
      {/* While a tile's file is made, Cancel waits with Escape and the backdrop. A long folder name wraps to be read whole. */}
      <DialogFooter note={kept ? <span className="whitespace-normal [overflow-wrap:anywhere]">Kept in {kept}</span> : undefined} onCancel={onClose} busy={making !== null} />
    </div>
  );
}
