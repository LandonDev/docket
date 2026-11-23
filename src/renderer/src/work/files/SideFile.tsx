import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { filesPaneOf, type CanvasItem, type CanvasKind } from "@shared/work";
import { kindOfEntry } from "@shared/work/files";
import { X } from "../../chrome/icons";
import { Tip, TruncateTip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { useSashKeys } from "../../hooks/useSashKeys";
import { suppressTextSelection } from "../../lib/drag";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { CanvasPane } from "../canvas/CanvasPane";
import { sayError, useFrame } from "../canvas/frame";
import { ItemSkeleton } from "../canvas/ItemBones";
import type { CanvasKindDef, CanvasSelection, SavedAction } from "../canvas/kind";
import { KindGlyph } from "./KindGlyph";
import { SaveActions, SaveLine } from "./SaveLine";

/**
 * The second file of a tab (docs/DESIGN.md "The Files place", two files side by side): Open to the Side puts it at
 * the right of the tab's own file with a hairline sash between. It has a 32px head of its own (its kind's glyph,
 * its name, where saving stands, and its own close), then its kind's bar and body as in a tab. It is in no tab of
 * its own, and closing it leaves the tab as it was.
 */

/** Each half keeps at least this much. */
export const SIDE_MIN = 320;

/** The side's width in a body of `body` px: half by default, each half at least `SIDE_MIN`; 0 where there is no room for two. */
export function sideWidth(body: number, kept: number | null): number {
  if (body <= 0) return kept ?? 0;
  if (body < SIDE_MIN * 2) return 0;
  return Math.round(Math.max(SIDE_MIN, Math.min(body - SIDE_MIN, kept ?? body / 2)));
}

export function SidePane({
  workspace,
  side,
  item,
  width,
  kinds,
  onClose,
  onAsk,
}: {
  workspace: Pick<WorkspaceMeta, "id" | "environmentId" | "path">;
  side: { itemId: string; key: string; name: string };
  /** the side's item; null until the pane's list has come */
  item: CanvasItem | null;
  /** its width beside the tab's own file; 0: there is no room for two, and it takes the body alone */
  width: number;
  kinds?: Record<CanvasKind, CanvasKindDef>;
  onClose(): void;
  /** Ask on a selection in it: the chat docks beside the tab */
  onAsk?(selection: CanvasSelection): void;
}) {
  const { feeds, shell } = useFrame(workspace.environmentId, filesPaneOf(workspace.id), item);
  const [running, setRunning] = useState<string | null>(null);
  const run = (action: SavedAction): void => {
    if (running) return;
    setRunning(action.id);
    void Promise.resolve()
      .then(() => action.run())
      .catch((err: unknown) => sayError(err, `${action.label} did not work`))
      .finally(() => setRunning(null));
  };
  const name = side.name || item?.title || "File";
  return (
    <section data-files-side={side.key} aria-label={name} className={`flex min-h-0 min-w-0 flex-col bg-background ${width ? "shrink-0" : "flex-1"}`} style={width ? { width } : undefined}>
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border ps-3 pe-1">
        <KindGlyph kind={kindOfEntry(name).kind} />
        <TruncateTip text={name}>
          <h3 className="min-w-0 shrink truncate text-[13px] leading-5 font-medium text-foreground">{name}</h3>
        </TruncateTip>
        <div className="min-w-0 flex-1">{feeds.saved ? <SaveLine line={feeds.saved} where={null} /> : null}</div>
        {feeds.saved?.actions?.length ? <SaveActions actions={feeds.saved.actions} busy={running} onRun={run} /> : null}
        <Tip label="Close">
          <Button variant="ghost" size="icon-xs" data-files-side-close aria-label={`Close ${name}`} className="shrink-0 text-muted-foreground" onClick={onClose}>
            <X />
          </Button>
        </Tip>
      </header>
      {item ? (
        <CanvasPane
          key={item.id}
          item={item}
          environmentId={workspace.environmentId}
          feeds={feeds}
          shell={shell}
          {...(kinds ? { kinds } : {})}
          onAsk={(selection: CanvasSelection) => {
            shell.selection(null);
            window.getSelection()?.removeAllRanges();
            onAsk?.(selection);
          }}
        />
      ) : (
        <ItemSkeleton />
      )}
    </section>
  );
}

/**
 * The hairline between a tab's two files, the canvas split's sash: an 8px grab, the arrows step 2% of the body
 * (Shift 10%), a double-click goes back to half, Escape during a drag goes back to where it began.
 */
export function SideSash({ width, body, onWidth }: { width: number; body: number; onWidth(width: number | null): void }) {
  const [dragging, setDragging] = useState(false);
  const clamp = (next: number): number => sideWidth(body, next);
  const keys = useSashKeys({
    label: "Resize the two files",
    orientation: "vertical",
    value: width,
    min: SIDE_MIN,
    max: Math.max(SIDE_MIN, body - SIDE_MIN),
    getSpan: () => body,
    direction: -1,
    onChange: (next) => onWidth(clamp(next)),
    onReset: () => onWidth(null),
  });
  const start = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointer = event.pointerId;
    const from = { x: event.clientX, width };
    handle.setPointerCapture?.(pointer);
    setDragging(true);
    const restore = suppressTextSelection();
    document.body.style.cursor = "col-resize";
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId === pointer) onWidth(clamp(from.width - (ev.clientX - from.x)));
    };
    const end = (back: boolean): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", key, true);
      try {
        handle.releasePointerCapture?.(pointer);
      } catch {
        /* already released */
      }
      restore();
      document.body.style.cursor = "";
      setDragging(false);
      if (back) onWidth(from.width);
    };
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId === pointer) end(false);
    };
    const key = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      end(true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
  };
  return (
    <div
      {...keys}
      data-files-side-sash
      onPointerDown={start}
      className={`relative z-10 w-px shrink-0 cursor-col-resize outline-none focus-visible:bg-accent ${dragging ? "bg-foreground/12" : "bg-border hover:bg-foreground/7"}`}
    >
      {/* The hairline is the sash; this widens the grab to 8px. */}
      <span className="absolute inset-y-0 -inset-x-1" />
    </div>
  );
}
