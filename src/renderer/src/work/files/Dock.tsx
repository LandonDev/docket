import { useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import type { FileTab } from "@shared/contract-work-files";
import type { CanvasItem, ContextChip } from "@shared/work";
import { TruncateTip } from "../../components/tip";
import { Dock as DockShell, DockHeadControls } from "../dock/Dock";
import { DockSash as DockSashShell } from "../dock/DockSash";
import { addRowChips, fileSubject, type DockThread } from "./dockThread";
import { DOCK } from "./model";
import type { OpenFrom } from "./open";
import { dragging, ROWS_MIME } from "./rowParts";

/**
 * The chat docked at the right of a file tab (docs/DESIGN.md "The Files place"): the shared dock (work/dock) with a
 * 32px head, level with the kind's bar, with the thread's title ("New chat" for a draft), Open in its own tab once
 * it is a thread, and Close. Files rows dragged onto it become a file chip each in the composer, under the document
 * surface's wash while they are over it.
 */
export function Dock({
  workspace,
  tab,
  item,
  chip,
  focus,
  preset = null,
  onChipTaken,
  onClose,
}: {
  workspace: OpenFrom["workspace"];
  tab: FileTab;
  /** the tab's item; null until the pane's list has come */
  item: CanvasItem | null;
  /** chips to put in the composer once the thread is known (a selection's Ask, files asked about together) */
  chip: ContextChip | readonly ContextChip[] | null;
  /** the composer takes the caret when the dock opens */
  focus: boolean;
  /** a preview's thread, shown without asking which: nothing in the app passes it */
  preset?: DockThread | null;
  onChipTaken(): void;
  onClose(): void;
}) {
  const itemId = item?.id ?? null;
  // The item is the tab's for its life: its id stands for it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const subject = useMemo(() => (item ? fileSubject(workspace, tab, item) : null), [workspace.id, tab.id, itemId]);
  const root = useRef<HTMLElement | null>(null);
  const id = (): string => root.current?.getAttribute("data-files-dock") ?? "";
  const caret = (): void => void requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("[data-composer-input]")?.focus());

  // Rows of the list dragged here: nothing moves while they are dragged; a drop puts a chip each in the composer.
  const [rowsOver, setRowsOver] = useState(false);
  const rowsDragged = (event: ReactDragEvent): boolean => !!id() && [...event.dataTransfer.types].includes(ROWS_MIME) && !!dragging();
  const drop = {
    onDragOver: (event: ReactDragEvent) => {
      if (!rowsDragged(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setRowsOver(true);
    },
    onDragLeave: (event: ReactDragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRowsOver(false);
    },
    onDrop: (event: ReactDragEvent) => {
      setRowsOver(false);
      const now = dragging();
      if (!rowsDragged(event) || !now) return;
      event.preventDefault();
      addRowChips(id(), now.entries, now.from.place);
      caret();
    },
  };

  return (
    <DockShell
      name="files"
      workspace={workspace}
      subject={subject}
      chip={chip}
      focus={focus}
      preset={preset}
      sectionRef={root}
      section={drop}
      onChipTaken={onChipTaken}
      onClose={onClose}
      head={(head) => {
        const title = head.meta?.title || "New chat";
        return (
          <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border ps-3 pe-1">
            <TruncateTip text={title}>
              <h3 className="min-w-0 flex-1 truncate text-[13px] leading-5 font-medium text-foreground">{title}</h3>
            </TruncateTip>
            <DockHeadControls {...head} />
          </header>
        );
      }}
    >
      {rowsOver ? (
        // The document surface's wash (work/canvas/fileDrop.tsx), 12px inside the dock.
        <div
          data-rows-wash
          aria-live="polite"
          className="pointer-events-none absolute inset-3 grid place-items-center rounded-lg border border-border bg-muted/70 transition-opacity duration-(--dur-fast) ease-(--ease-out) starting:opacity-0 motion-reduce:transition-none"
        >
          <span className="text-[13px] text-muted-foreground">Drop to add to the message</span>
        </div>
      ) : null}
    </DockShell>
  );
}

/** The hairline between the file and its dock (work/dock/DockSash.tsx), the file keeping its 560px. */
export function DockSash({ width, body, onWidth }: { width: number; body: number; onWidth(width: number, done: boolean): void }) {
  return <DockSashShell name="files" width={width} body={body} beside={DOCK.file} onWidth={onWidth} />;
}
