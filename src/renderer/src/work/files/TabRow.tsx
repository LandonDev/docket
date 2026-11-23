import { useCallback, useEffect, useRef, type DragEvent, type KeyboardEvent, type ReactElement, type WheelEvent } from "react";
import type { FileTab } from "@shared/contract-work-files";
import { kindOfEntry } from "@shared/work/files";
import { PanelLeft, Plus, X } from "../../chrome/icons";
import { RowsContextMenu, type MenuRow } from "../../chrome/menuRows";
import { Tip, useTruncated } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { reveal } from "../../components/ui/reveal";
import { OVERFLOW_FADE, useOverflowEdges } from "../../hooks/useOverflowEdges";
import { useSortable } from "../../hooks/useSortable";
import { shortcutFor } from "../../lib/settings";
import { KindGlyph } from "./KindGlyph";
import { setDragLabel, setSideOver } from "./rowParts";

/**
 * The Files place's tab row (docs/DESIGN.md "The Files place"): the workspace's open tabs on the canvas tab row's
 * shape, 36px on `sidebar`. A tab is a folder he is browsing or a file open as itself; each is led by its kind's
 * 14px glyph, muted as every tab row's is. The close control shows on the tab under the pointer and on the selected
 * one; a middle click closes too. Past what fits, the tabs shrink to their glyph and then scroll under a faded
 * edge. The sidebar's toggle starts the row and a quiet + ends it; neither moves.
 */

/** How long a drag rests on a folder's tab before the tab comes forward. */
export const TAB_SPRING_MS = 600;

const tabId = (id: string): string => `files-tab-${id}`;
export const filesPanelId = (id: string): string => `files-panel-${id}`;

/** Mouse wheels only emit deltaY; turn it sideways. Trackpad swipes keep native scrolling. */
function wheelToX(event: WheelEvent<HTMLDivElement>): void {
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY;
}

export function TabRow({
  tabs,
  selected,
  sidebarOpen,
  onSidebar,
  onSelect,
  onClose,
  onCloseMany,
  onReopen,
  drop,
  side,
  onReorder,
  onNew,
}: {
  tabs: readonly FileTab[];
  selected: string | null;
  sidebarOpen: boolean;
  onSidebar(): void;
  onSelect(tabId: string): void;
  onClose(tabId: string): void;
  /** Close Other Tabs and Close Tabs to the Right, from a tab's menu; absent, the menu offers neither */
  onCloseMany?(tabIds: string[]): void;
  /** opens the tab last closed again; absent while none was closed */
  onReopen?(): void;
  /** rows dragged onto a folder's tab: whether it takes them, and the drop */
  drop?: { at: string | null; over(tabId: string, event: DragEvent): boolean; leave(tabId: string): void; drop(tabId: string, event: DragEvent): void };
  /**
   * Two files in one tab: `into` answers the file tab a file tab can go to the side of (null where there is none),
   * `move` puts it there. From a tab's menu, and by dragging the tab down onto the right half of the file shown.
   */
  side?: { into(tabId: string): FileTab | null; move(tabId: string): void };
  onReorder(order: string[]): void;
  onNew(): void;
}) {
  const ids = tabs.map((tab) => tab.id);
  // A folder's tab comes forward when a drag rests on it, so the folder can be dropped into.
  const spring = useRef<{ tab: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const rest = (tabId: string | null): void => {
    if (spring.current?.tab === tabId) return;
    if (spring.current) clearTimeout(spring.current.timer);
    spring.current = tabId === null ? null : { tab: tabId, timer: setTimeout(() => onSelect(tabId), TAB_SPRING_MS) };
  };
  useEffect(() => () => rest(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  // A file tab dragged down onto the right half of the file shown goes to that side: the drop is no reorder.
  const sideDrag = useRef(false);
  const sortable = useSortable(ids, (order) => (sideDrag.current ? undefined : onReorder(order)));
  const carry = (tabId: string, pointerId: number): void => {
    const into = side?.into(tabId);
    if (!side || !into) return;
    const over = (ev: PointerEvent): boolean => {
      const rect = document.getElementById(filesPanelId(tabId))?.querySelector("[data-files-body]")?.getBoundingClientRect();
      return !!rect && ev.clientY > rect.top + 24 && ev.clientY < rect.bottom && ev.clientX > rect.left + rect.width / 2 && ev.clientX < rect.right;
    };
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      const on = over(ev);
      sideDrag.current = on;
      setSideOver(on ? tabId : null);
      setDragLabel(on ? { text: `Open beside ${into.name || "the file"}`, x: ev.clientX, y: ev.clientY } : null);
    };
    const end = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      const on = ev.type === "pointerup" && over(ev);
      setSideOver(null);
      setDragLabel(null);
      // The reorder's own release has been heard by the next turn: until then this drop is the side's.
      setTimeout(() => (sideDrag.current = false), 0);
      if (on) side.move(tabId);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
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
    list.current?.querySelector<HTMLElement>(`[data-files-tab="${CSS.escape(selected)}"]`)?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [selected, tabs.length]);
  // One tab stop: the arrows move along the row and show the tab they land on.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest("[data-files-tab-close]")) return;
    const at = ids.indexOf(selected ?? "");
    const to = event.key === "ArrowRight" ? at + 1 : event.key === "ArrowLeft" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : -1;
    if (to < 0 || to >= ids.length || to === at) return;
    event.preventDefault();
    onSelect(ids[to]!);
    event.currentTarget.querySelector<HTMLElement>(`[data-files-tab="${CSS.escape(ids[to]!)}"]`)?.focus();
  };
  return (
    <div data-files-tabrow className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-sidebar px-1.5">
      <Tip label={sidebarOpen ? "Hide Sidebar" : "Show Sidebar"}>
        <Button variant="ghost" size="icon-sm" aria-label={sidebarOpen ? "Hide Sidebar" : "Show Sidebar"} aria-pressed={sidebarOpen} className="shrink-0 text-muted-foreground" onClick={onSidebar}>
          <PanelLeft />
        </Button>
      </Tip>
      <RowsContextMenu
        label="Tab"
        lazyMount
        rowsFor={(id) => {
          const at = id === null ? -1 : ids.indexOf(id);
          if (at < 0) return onReopen ? [{ kind: "item", id: "reopen", label: "Reopen Closed Tab", shortcut: shortcutFor("Files (Work)", "Reopen Closed Tab") }] : null;
          const into = id === null ? null : (side?.into(id) ?? null);
          return [
            ...(into ? ([{ kind: "item", id: "side", label: "Open to the Side", description: `Beside ${into.name || "the file shown"}` }, { kind: "sep" }] satisfies MenuRow[]) : []),
            { kind: "item", id: "close", label: "Close Tab", shortcut: shortcutFor("Files (Work)", "Close Tab") },
            ...(onCloseMany
              ? ([
                  { kind: "item", id: "others", label: "Close Other Tabs", disabled: ids.length < 2 },
                  { kind: "item", id: "right", label: "Close Tabs to the Right", disabled: at === ids.length - 1 },
                ] satisfies MenuRow[])
              : []),
            { kind: "sep" },
            { kind: "item", id: "reopen", label: "Reopen Closed Tab", shortcut: shortcutFor("Files (Work)", "Reopen Closed Tab"), disabled: !onReopen },
          ];
        }}
        onPick={(pick, id) => {
          if (pick === "reopen") return onReopen?.();
          if (id === null) return;
          if (pick === "side") return side?.move(id);
          if (pick === "close") return onClose(id);
          if (pick === "others") return onCloseMany?.(ids.filter((other) => other !== id));
          if (pick === "right") return onCloseMany?.(ids.slice(ids.indexOf(id) + 1));
        }}
      >
      <div
        ref={setList}
        role="tablist"
        aria-label="Open tabs"
        aria-orientation="horizontal"
        className={`scrollbar-none flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden overscroll-none ${OVERFLOW_FADE}`}
        onKeyDown={onKeyDown}
        onWheel={wheelToX}
      >
        {tabs.map((tab, index) => {
          const active = tab.id === selected;
          const dragging = sortable.draggingId === tab.id;
          const moving = sortable.draggingId !== null && sortable.toIndex === index && sortable.fromIndex !== null;
          const lineStart = moving && sortable.toIndex! < sortable.fromIndex!;
          const lineEnd = moving && sortable.toIndex! > sortable.fromIndex!;
          const name = tab.name || "File";
          return (
            <div
              key={tab.id}
              ref={(el) => sortable.setItemRef(tab.id, el)}
              data-menu-id={tab.id}
              data-drop-over={drop?.at === `tab:${tab.id}` || undefined}
              className={`group/dock-tab relative flex max-w-60 min-w-9 shrink rounded-md ${dragging ? "z-10" : ""} ${drop?.at === `tab:${tab.id}` ? "bg-muted" : ""}`}
              {...(drop && tab.kind === "page"
                ? {
                    onDragOver: (event: DragEvent) => {
                      if (!drop.over(tab.id, event)) return;
                      event.preventDefault();
                      if (!active) rest(tab.id);
                    },
                    onDragLeave: () => {
                      rest(null);
                      drop.leave(tab.id);
                    },
                    onDrop: (event: DragEvent) => {
                      event.preventDefault();
                      rest(null);
                      drop.drop(tab.id, event);
                    },
                  }
                : {})}
            >
              {lineStart ? <div className="pointer-events-none absolute inset-y-1 -left-0.5 z-20 w-0.5 rounded-full bg-accent" /> : null}
              {lineEnd ? <div className="pointer-events-none absolute inset-y-1 -right-0.5 z-20 w-0.5 rounded-full bg-accent" /> : null}
              <TitleTip title={name}>
                {(titleRef) => (
                  <Button
                    variant="ghost"
                    role="tab"
                    id={tabId(tab.id)}
                    aria-controls={active ? filesPanelId(tab.id) : undefined}
                    aria-selected={active}
                    tabIndex={active ? 0 : -1}
                    data-files-tab={tab.id}
                    data-tab-kind={tab.kind}
                    data-dragging={dragging || undefined}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      onSelect(tab.id);
                      sortable.onItemPointerDown(tab.id, event);
                      if (tab.kind === "file") carry(tab.id, event.pointerId);
                    }}
                    onClick={(event) => {
                      // A pointer selected on its press; this is Enter and Space.
                      if (event.detail === 0) onSelect(tab.id);
                    }}
                    onAuxClick={(event) => {
                      if (event.button === 1) onClose(tab.id);
                    }}
                    // The close control lies over the tab's end: the name stops short of it on the tab that shows one.
                    className={`h-7 w-full min-w-0 shrink touch-none justify-start gap-2 rounded-md ps-2 text-[13px] font-normal text-muted-foreground hover:bg-foreground/5 hover:text-foreground aria-selected:bg-muted aria-selected:text-foreground aria-selected:transition-none data-dragging:opacity-50 ${active ? "pe-7" : "pe-2 group-hover/dock-tab:pe-7"}`}
                  >
                    <KindGlyph kind={tab.kind === "page" ? "folder" : kindOfEntry(name).kind} tinted={false} className="size-3.5 shrink-0" />
                    <span ref={titleRef} className="min-w-0 truncate">
                      {name}
                    </span>
                  </Button>
                )}
              </TitleTip>
              <div className={`absolute end-0.5 top-0.5 ${active ? "" : reveal("dock-tab", { row: true })}`}>
                <Button variant="ghost" size="icon-xs" data-files-tab-close aria-label={`Close ${name}`} tabIndex={active ? 0 : -1} className="text-muted-foreground" onClick={() => onClose(tab.id)}>
                  <X />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      </RowsContextMenu>
      <Tip label="New Tab" shortcut={shortcutFor("Files (Work)", "New Tab")}>
        <Button variant="ghost" size="icon-sm" aria-label="New Tab" className="shrink-0 text-muted-foreground" onClick={onNew}>
          <Plus />
        </Button>
      </Tip>
    </div>
  );
}

/**
 * A tab's whole name on hover and on focus while it is cut: the tab itself is the tip's trigger, so the arrow keys'
 * focus shows it too. The tip is always there and off while the name fits, so a resize never swaps the tab under
 * the focus.
 */
function TitleTip({ title, children }: { title: string; children: (titleRef: (el: HTMLElement | null) => void) => ReactElement }) {
  const { ref, cut } = useTruncated(title);
  return (
    <Tip label={title} disabled={!cut}>
      {children(ref)}
    </Tip>
  );
}
