import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode, type WheelEvent } from "react";
import type { CanvasItem, CanvasKind } from "@shared/work";
import { MoreHorizontal } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { TruncateTip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { OVERFLOW_FADE, useOverflowEdges } from "../../hooks/useOverflowEdges";
import { useSortable } from "../../hooks/useSortable";
import type { CanvasKindDef } from "./kind";
import { CANVAS } from "./registry";

/**
 * The canvas pane's tab row (docs/DESIGN.md "The canvas pane"): the open
 * items as tabs in the strip's chip shape, each led by its kind's glyph. One
 * item alone is named as a split view's title is, with one muted fact after
 * it. The row is the lead of the split view's header (SplitShell `lead`), so
 * More and the conversation toggle end it. Past what fits, the tabs shrink to
 * their glyph and then scroll, as the title strip's settled row does: no bar,
 * a faded edge where there is more, a mouse wheel turned sideways, and the
 * selected tab brought into view. More and the toggle never move.
 */

/** A tab's element id and its panel's: the tab names the panel (`aria-controls`), the panel takes its name from the tab. */
export const canvasTabId = (itemId: string): string => `canvas-tab-${itemId}`;
export const canvasPanelId = (itemId: string): string => `canvas-panel-${itemId}`;

/** Mouse wheels only emit deltaY; turn it sideways. Trackpad swipes keep native scrolling. (The title strip's `wheelToX`.) */
function wheelToX(event: WheelEvent<HTMLDivElement>): void {
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY;
}
export function CanvasTabs({
  items,
  selected,
  detail,
  onSelect,
  onClose,
  onReorder,
  kinds = CANVAS,
}: {
  items: readonly CanvasItem[];
  selected: string | null;
  /** One muted fact after a lone item's name. */
  detail?: string | null;
  onSelect(itemId: string): void;
  onClose(itemId: string): void;
  onReorder(order: string[]): void;
  /** The registry; a test's or a preview's own kinds in its place. */
  kinds?: Record<CanvasKind, CanvasKindDef>;
}) {
  const ids = items.map((item) => item.id);
  const sortable = useSortable(ids, onReorder);
  const edges = useOverflowEdges<HTMLDivElement>();
  const list = useRef<HTMLDivElement | null>(null);
  const setList = useCallback(
    (el: HTMLDivElement | null) => {
      list.current = el;
      edges(el);
    },
    [edges],
  );
  // The selected tab comes into view when it changes, and when a tab opens or closes beside it.
  useEffect(() => {
    if (!selected) return;
    list.current?.querySelector<HTMLElement>(`[data-canvas-tab="${CSS.escape(selected)}"]`)?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [selected, items.length]);
  if (items.length === 1) {
    const [item] = items;
    const Glyph = kinds[item.kind].icon;
    return (
      <div data-canvas-title className="flex min-w-0 flex-1 items-center gap-2 px-1.5">
        <Glyph className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 items-baseline gap-2">
          <TruncateTip text={item.title}>
            <span data-view-title className="min-w-0 truncate text-sm font-semibold text-foreground">
              {item.title}
            </span>
          </TruncateTip>
          {detail ? (
            <span data-view-detail className="min-w-0 truncate text-xs text-muted-foreground">
              {detail}
            </span>
          ) : null}
        </div>
      </div>
    );
  }
  // One tab stop: the arrows move along the row and show the tab they land on.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const at = ids.indexOf(selected ?? "");
    const to =
      event.key === "ArrowRight" ? at + 1 : event.key === "ArrowLeft" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : -1;
    if (to < 0 || to >= ids.length || to === at) return;
    event.preventDefault();
    onSelect(ids[to]);
    event.currentTarget.querySelector<HTMLElement>(`[data-canvas-tab="${CSS.escape(ids[to])}"]`)?.focus();
  };
  return (
    <div
      ref={setList}
      role="tablist"
      aria-label="Open items"
      aria-orientation="horizontal"
      data-canvas-tabs
      className={`scrollbar-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden overscroll-none ${OVERFLOW_FADE}`}
      onKeyDown={onKeyDown}
      onWheel={wheelToX}
    >
      {items.map((item, index) => {
        const Glyph = kinds[item.kind].icon;
        const active = item.id === selected;
        const dragging = sortable.draggingId === item.id;
        const moving = sortable.draggingId !== null && sortable.toIndex === index && sortable.fromIndex !== null;
        const lineStart = moving && sortable.toIndex! < sortable.fromIndex!;
        const lineEnd = moving && sortable.toIndex! > sortable.fromIndex!;
        return (
          <div key={item.id} ref={(el) => sortable.setItemRef(item.id, el)} className={`relative flex max-w-60 min-w-9 shrink ${dragging ? "z-10" : ""}`}>
            {lineStart ? <div className="pointer-events-none absolute inset-y-1 -left-0.5 z-20 w-0.5 rounded-full bg-accent" /> : null}
            {lineEnd ? <div className="pointer-events-none absolute inset-y-1 -right-0.5 z-20 w-0.5 rounded-full bg-accent" /> : null}
            <Button
              variant="ghost"
              role="tab"
              id={canvasTabId(item.id)}
              // Only the shown item's panel is drawn, so only its tab names one.
              aria-controls={active ? canvasPanelId(item.id) : undefined}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              data-canvas-tab={item.id}
              data-dragging={dragging || undefined}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                onSelect(item.id);
                sortable.onItemPointerDown(item.id, event);
              }}
              onClick={(event) => {
                // A pointer selected on its press; this is Enter and Space.
                if (event.detail === 0) onSelect(item.id);
              }}
              onAuxClick={(event) => {
                if (event.button === 1) onClose(item.id);
              }}
              className="h-7 w-full min-w-0 shrink touch-none justify-start gap-2 rounded-md px-2 text-[13px] font-normal text-muted-foreground hover:bg-foreground/5 hover:text-foreground aria-selected:bg-muted aria-selected:text-foreground aria-selected:transition-none data-dragging:opacity-50"
            >
              <Glyph className="size-3.5" />
              <TruncateTip text={item.title}>
                <span className="min-w-0 truncate">{item.title}</span>
              </TruncateTip>
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** More, at the tab row's end: the verbs on every pending change, then on the tabs. */
export function CanvasMore({ rows, onPick, children }: { rows: readonly MenuRow[]; onPick(id: string): void; children?: ReactNode }) {
  return (
    <>
      {children}
      <RowsMenu
        label="More"
        align="end"
        rows={rows}
        onPick={onPick}
        tip={{ label: "More" }}
        trigger={
          <Button variant="ghost" size="icon-sm" aria-label="More">
            <MoreHorizontal />
          </Button>
        }
      />
    </>
  );
}
