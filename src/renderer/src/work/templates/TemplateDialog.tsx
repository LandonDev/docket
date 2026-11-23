import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasSource } from "@shared/work/canvas";
import type { FolderRef } from "@shared/work/files";
import type { Template } from "@shared/work/templates";
import { DialogFooter, ErrorLine } from "../../chrome/ConfirmDialog";
import { Modal, ModalBody, useModalClose } from "../../chrome/Modal";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { makeFrom, unhideStarters, useTemplates } from "./data";
import { FieldsForm } from "./FieldsForm";
import { folderName, hiddenLine, shelfGroups } from "./model";
import { openMade } from "./open";
import { Shelf, ShelfSkeleton } from "./Shelf";

/**
 * "New from a template" (docs/agents/work-templates.md "New from a template"):
 * the shelf's two groups as a three-column grid (two under 640px). A tile with
 * no fields makes its file, which opens in a Files tab, and the dialog closes;
 * one with fields turns this same dialog to them, with the way back. Opened on
 * one template (the shelf page's press) it starts at the fields and has no way
 * back. The footer names the folder the file is kept in only when the caller
 * gave one. Its top is fixed, so the title holds still when the step changes;
 * the step that arrives fades in over 120ms, none under reduced motion. Back
 * returns the focus and the scroll to the tile that opened the fields. A file
 * made whose open failed is kept by its template: a press on that tile, or
 * Open in its fields (read only, as sent), opens it again, never a second.
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
    // Its top is fixed (the recipe PickerDialog and the `full` size use, still rising 4px on entry), so the title never
    // moves when a step changes: the box only grows or shortens from the bottom.
    <Modal title={chosen ? chosen.name : "New from a template"} size="md" busy={making !== null} onClose={onClose} className={TOP_ANCHORED} data-templates-dialog="">
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

/** This dialog's place: a fixed top instead of the centre, with room below it for the whole box. */
export const TOP_ANCHORED = "top-[12%] translate-y-0 starting:translate-y-1 max-h-[calc(88vh-2rem)]";

/** The swap's fade, on the step that arrives; none under reduced motion. */
const ARRIVE = "flex min-h-0 flex-col transition-opacity duration-(--dur-fast) ease-(--ease-out) starting:opacity-0 motion-reduce:transition-none";

/** Focus that has not moved since the dialog opened: on nothing, on the dialog, or on the Cancel it lands on while the shelf loads. */
const unmoved = (el: Element | null): boolean => !el || el === document.body || el.getAttribute("role") === "dialog" || el.matches("[data-dialog-cancel]");

/** The dialog's one scroller (chrome/Modal.tsx). */
const scrollerOf = (el: Element | null): HTMLElement | null => el?.closest<HTMLElement>(".overflow-y-auto") ?? null;

/** A file made whose open failed: what a press on its template, or Open in its fields, opens again. */
type Made = { source: CanvasSource; title: string; values?: Record<string, string> };

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
  // Made files whose open failed, by template: kept across Back and another template, so no retry is lost
  // and a press again opens the file, never a second one.
  const [made, setMade] = useState<Readonly<Record<string, Made>>>({});
  // The tile that turned the dialog to its fields, where Back returns: the tile and the scroll.
  const [opener, setOpener] = useState<{ id: string; top: number } | null>(null);
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

  const words = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  const open = async (id: string, file: Made) => {
    try {
      await openMade({ workspaceId, source: file.source });
    } catch (err) {
      setMade((m) => ({ ...m, [id]: file }));
      setError(`${file.title} was made but did not open. ${words(err)}`);
      return;
    }
    setMade((m) => {
      const { [id]: _, ...rest } = m;
      return rest;
    });
    if (close) close(onClose);
    else onClose();
  };

  const make = async (template: Template, fields?: Record<string, string>) => {
    setMaking(template.id);
    setError(null);
    try {
      // Made already, its open failed: open that file, never a second one.
      const kept = made[template.id];
      if (kept) return await open(template.id, kept);
      let file: Made;
      try {
        const answer = await makeFrom(env, workspaceId, template.id, { ...(into ? { into } : {}), ...(fields ? { fields } : {}) });
        file = { source: answer.source, title: answer.title, ...(fields ? { values: fields } : {}) };
      } catch (err) {
        setError(words(err));
        return;
      }
      await open(template.id, file);
    } finally {
      setMaking(null);
    }
  };

  const turnTo = (t: Template) => {
    setOpener({ id: t.id, top: scrollerOf(tiles.current)?.scrollTop ?? 0 });
    setError(null);
    choose(t);
  };

  if (chosen)
    return (
      <div key="fields" data-step="fields" className={ARRIVE}>
        <FieldsForm
          key={chosen.id}
          template={chosen}
          pending={making === chosen.id}
          error={error}
          made={made[chosen.id] ? { values: made[chosen.id]!.values ?? {} } : undefined}
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
  const narrowed = ready ? hiddenLine(load.value.hidden) : null;
  return (
    <div key="tiles" data-step="tiles" className={ARRIVE}>
      <ModalBody>
        {/* A refusal or a failed open stands above the grid, where a press near its top can see it; read out as it lands. */}
        <div role="alert" className="contents">
          <ErrorLine error={error} />
        </div>
        {load.status === "loading" ? (
          <ShelfSkeleton layout="dialog" />
        ) : load.status === "error" ? (
          <EmptyState title="Templates did not load" line={load.error} action={{ label: "Retry", onClick: retry }} />
        ) : groups.length === 0 ? (
          // A shelf he narrowed says so and offers the way back, as the page does.
          <EmptyState
            title="No templates"
            {...(narrowed ? { line: narrowed, action: { label: "Show hidden", onClick: () => void unhideStarters(env, workspaceId).catch((err: unknown) => setError(words(err))) } } : {})}
          />
        ) : (
          <div ref={tiles}>
            <Shelf
              groups={groups}
              layout="dialog"
              making={making}
              focusId={opener?.id ?? null}
              onPress={(t) => {
                if (making) return;
                if (t.fields.length) turnTo(t);
                else void make(t);
              }}
            />
          </div>
        )}
      </ModalBody>
      {/* While a tile's file is made, Cancel waits with Escape and the backdrop. A long folder name wraps to be read whole. */}
      <DialogFooter note={kept ? <span className="whitespace-normal [overflow-wrap:anywhere]">Kept in {kept}</span> : undefined} onCancel={onClose} busy={making !== null} />
    </div>
  );
}
