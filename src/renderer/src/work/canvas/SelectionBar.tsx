import { useEffect, useMemo, useRef } from "react";
import { LazyPopover } from "../../chrome/menuRows";
import { Button } from "../../components/ui/button";
import { Kbd } from "../../components/ui/kbd";
import { IS_MAC } from "../../lib/platform";
import { Ask } from "../icons";
import type { CanvasSelection } from "./kind";

/** Ask's key, as its cap reads: ⌘L on macOS, Ctrl+L elsewhere. */
export const ASK_KEY = IS_MAC ? "⌘L" : "Ctrl+L";

/**
 * The bar over a selection in any canvas kind (docs/DESIGN.md "The canvas
 * pane"): Ask first, then the kind's own controls. Ask puts the selection in
 * the thread's composer as a chip; nothing answers inside the canvas. Built
 * as the transcript's selection menu is: the popover's fill, 4px inside it,
 * 24px ghost buttons.
 */
export function SelectionBar({ selection, onAsk, onDismiss }: { selection: CanvasSelection | null; onAsk(selection: CanvasSelection): void; onDismiss(): void }) {
  const live = useRef({ selection, onAsk, onDismiss });
  live.current = { selection, onAsk, onDismiss };

  // The key works wherever the caret is while a selection is fed: it is the selection's, not the bar's.
  useEffect(() => {
    if (!selection) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "l" || event.altKey || event.shiftKey || (IS_MAC ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return;
      const now = live.current.selection;
      if (!now) return;
      event.preventDefault();
      live.current.onAsk(now);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selection]);

  // The last selection keeps the bar whole while it fades out.
  const shown = useRef(selection);
  if (selection) shown.current = selection;
  const last = shown.current;
  const anchor = useMemo(() => (last ? { getBoundingClientRect: () => last.rect } : null), [last]);

  return (
    <LazyPopover
      anchor={anchor}
      open={!!selection}
      onOpenChange={(open) => {
        if (!open) live.current.onDismiss();
      }}
      side="top"
      align="start"
      label="Selection"
      initialFocus={false}
      finalFocus={false}
      className="w-auto flex-row p-1"
    >
      {last ? <SelectionTools selection={last} onAsk={onAsk} /> : null}
    </LazyPopover>
  );
}

/** The bar's own row: Ask with its key, then the kind's controls after a hairline. */
export function SelectionTools({ selection, onAsk }: { selection: CanvasSelection; onAsk(selection: CanvasSelection): void }) {
  return (
    <div role="toolbar" aria-label="Selection" data-canvas-selection-bar className="flex items-center gap-0.5">
      {/* The popover's 12px corner less its 4px inset: the button's 8px. */}
      <Button variant="ghost" size="xs" className="rounded-lg text-[13px]" onMouseDown={(event) => event.preventDefault()} onClick={() => onAsk(selection)}>
        <Ask className="size-3.5" />
        Ask
        <Kbd size="sm" className="ms-0.5">
          {ASK_KEY}
        </Kbd>
      </Button>
      {selection.tools ? (
        <>
          <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
          {selection.tools}
        </>
      ) : null}
    </div>
  );
}
