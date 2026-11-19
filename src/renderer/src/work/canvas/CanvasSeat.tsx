import type { ReactNode } from "react";
import type { CanvasKind } from "@shared/work";
import type { MenuRow } from "../../chrome/menuRows";
import { addContextChip } from "./chips";
import type { Session } from "../../lib/session";
import { SplitShell, useSplit } from "../../surfaces/threads/SplitShell";
import { CanvasPane, useKindModule } from "./CanvasPane";
import { CanvasMore, CanvasTabs } from "./CanvasTabs";
import { sayError, useFrame } from "./frame";
import type { CanvasKindDef, CanvasSelection } from "./kind";
import { CANVAS } from "./registry";
import { closeItem, reorderItems, selectItem, setFolded, useCanvas, useKeptState } from "./store";

/** The item's share of the pane while the thread shows: it takes the room, and the thread keeps its 360px. */
export const ITEM_SPLIT = 70;

/**
 * A Work thread's view with its canvas beside it (docs/DESIGN.md "The canvas
 * pane"): the thread's open items at the left under their tab row, the
 * thread at the right, one toggle that folds the thread away. With no item
 * open the thread fills the pane as it always did, in the same place in the
 * tree, so an item arriving never remounts the transcript.
 */
export function CanvasSeat({
  session,
  held,
  kinds = CANVAS,
  children,
}: {
  session: Pick<Session, "id" | "environmentId">;
  /** The thread's paused row, shown under the tab row while the thread is folded (chatSlots `heldRowOf`). */
  held?: ReactNode;
  /** The registry; a test's or a preview's own kinds in its place. */
  kinds?: Record<CanvasKind, CanvasKindDef>;
  /** The thread's own view. */
  children: ReactNode;
}) {
  const { id: sessionId, environmentId } = session;
  const view = useCanvas(environmentId, sessionId);
  const split = useSplit(ITEM_SPLIT);
  const shown = view.items.find((item) => item.id === view.selected) ?? view.items[0] ?? null;
  const { feeds, shell } = useFrame(environmentId, sessionId, shown);
  const module = useKindModule((shown ? kinds[shown.kind] : kinds.document).chunk);
  const TabEnd = shown ? module?.TabEnd : undefined;
  const [kept, keep] = useKeptState(shown?.id ?? "");

  const close = (itemId: string): void => void closeItem(environmentId, sessionId, itemId).catch((error: unknown) => sayError(error, "Couldn't close the item"));
  const ask = (selection: CanvasSelection): void => {
    addContextChip(sessionId, selection.chip);
    shell.selection(null);
    window.getSelection()?.removeAllRanges();
    setFolded(sessionId, false);
    // The composer takes the caret once the thread is back in its slot.
    requestAnimationFrame(() => split.rootRef.current?.querySelector<HTMLElement>("[data-chat] [data-composer-input]")?.focus());
  };

  const review = feeds.review && feeds.review.count > 0 ? feeds.review : null;
  const rows: MenuRow[] = [
    ...(review
      ? ([
          { kind: "item", id: "accept-all", label: "Accept all" },
          { kind: "item", id: "reject-all", label: "Reject all" },
          { kind: "sep" },
        ] satisfies MenuRow[])
      : []),
    { kind: "item", id: "close", label: "Close" },
    ...(view.items.length > 1 ? ([{ kind: "item", id: "close-others", label: "Close others" }] satisfies MenuRow[]) : []),
  ];
  const pick = (id: string): void => {
    if (!shown) return;
    if (id === "close") close(shown.id);
    if (id === "close-others") view.items.filter((item) => item.id !== shown.id).forEach((item) => close(item.id));
    if (review && (id === "accept-all" || id === "reject-all")) {
      const accept = id === "accept-all";
      review[accept ? "accept" : "reject"]("all").catch((error: unknown) => sayError(error, accept ? "Couldn't accept the changes" : "Couldn't reject the changes"));
    }
  };

  return (
    <SplitShell
      hasBoard={shown !== null}
      collapsed={view.folded}
      onToggleChat={(open) => setFolded(sessionId, !open)}
      splitState={split}
      held={held}
      lead={
        shown ? (
          <CanvasTabs
            items={view.items}
            selected={shown.id}
            detail={feeds.detail}
            onSelect={(itemId) => selectItem(sessionId, itemId)}
            onClose={close}
            kinds={kinds}
            onReorder={(order) => void reorderItems(environmentId, sessionId, order).catch((error: unknown) => sayError(error, "Couldn't move the tab"))}
          />
        ) : undefined
      }
      actions={
        shown ? (
          <CanvasMore rows={rows} onPick={pick}>
            {TabEnd ? <TabEnd item={shown} source={shown.source} env={environmentId} state={kept} setState={keep} shell={shell} /> : null}
          </CanvasMore>
        ) : undefined
      }
      board={shown ? <CanvasPane key={shown.id} item={shown} environmentId={environmentId} feeds={feeds} shell={shell} onAsk={ask} kinds={kinds} /> : null}
      chat={children}
    />
  );
}
