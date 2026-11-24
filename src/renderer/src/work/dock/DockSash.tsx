import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { useSashKeys } from "../../hooks/useSashKeys";
import { suppressTextSelection } from "../../lib/drag";
import { clampDock, DOCK_SIZE, dockMost } from "./shapes";

/**
 * The hairline between a dock and what it sits beside, the canvas split's sash (SplitShell): an 8px grab, the arrows
 * step 2% of the body (Shift 10%), a double-click goes back to 360px, Escape during a drag goes back to where it
 * began. The width is the window's; it is written when the drag ends. `beside` is the room the other side keeps;
 * `name` marks it (`data-<name>-sash`).
 */
export function DockSash({ name, width, body, beside, onWidth }: { name: string; width: number; body: number; beside: number; onWidth(width: number, done: boolean): void }) {
  const [dragging, setDragging] = useState(false);
  const keys = useSashKeys({
    label: "Resize the chat",
    orientation: "vertical",
    value: width,
    min: DOCK_SIZE.min,
    max: dockMost(body, beside),
    getSpan: () => body,
    direction: -1,
    onChange: (next) => onWidth(clampDock(next, body, beside), true),
    onReset: () => onWidth(DOCK_SIZE.width, true),
  });
  const start = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointer = event.pointerId;
    const from = { x: event.clientX, width };
    let last = width;
    handle.setPointerCapture?.(pointer);
    setDragging(true);
    const restore = suppressTextSelection();
    document.body.style.cursor = "col-resize";
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointer) return;
      last = clampDock(from.width - (ev.clientX - from.x), body, beside);
      onWidth(last, false);
    };
    const end = (to: number): void => {
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
      onWidth(to, true);
    };
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId === pointer) end(last);
    };
    const key = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      end(from.width);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", key, true);
  };
  return (
    <div
      {...keys}
      {...{ [`data-${name}-sash`]: "" }}
      onPointerDown={start}
      className={`relative z-10 w-px shrink-0 cursor-col-resize outline-none focus-visible:bg-accent ${dragging ? "bg-foreground/12" : "bg-border hover:bg-foreground/7"}`}
    >
      {/* The hairline is the sash; this widens the grab to 8px. */}
      <span className="absolute inset-y-0 -inset-x-1" />
    </div>
  );
}
