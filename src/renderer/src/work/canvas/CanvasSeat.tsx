import { lazy, Suspense, useState, type ReactNode } from "react";
import type { CanvasKind, ContextChip } from "@shared/work";
import { Check, File, FolderOpen, X } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Progress } from "../../components/ui/progress";
import { Spinner } from "../../components/ui/spinner";
import type { MenuRow } from "../../chrome/menuRows";
import { addContextChip } from "./chips";
import type { Session } from "../../lib/session";
import { SplitShell, useSplit, type ChatToggleWords } from "../../surfaces/threads/SplitShell";
import { CanvasPane, useKindModule } from "./CanvasPane";
import { CanvasMore, CanvasTabs } from "./CanvasTabs";
import { sayError, useFrame } from "./frame";
import type { CanvasKindDef, CanvasSelection } from "./kind";
import { useOpening, type Opening } from "./fileDrop";
import { itemVerbsFor } from "./itemVerbs";
import { CANVAS, kindDefOf } from "./registry";
import { closeItem, reorderItems, selectItem, setFolded, useCanvas, useKeptState } from "./store";

/** Google's Picker, loaded when asked for (work/google). */
const PickDialog = lazy(() => import("../google/PickDialog").then((m) => ({ default: m.PickDialog })));

/** A kind's own row in More is named apart from the frame's, and a pillar's verb apart from both. */
const KIND_ROW = "kind:";
const VERB_ROW = "verb:";

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
  onAsk,
  chatToggle,
  children,
}: {
  session: Pick<Session, "id" | "environmentId">;
  /** The thread's paused row, shown under the tab row while the thread is folded (chatSlots `heldRowOf`). */
  held?: ReactNode;
  /** The registry; a test's or a preview's own kinds in its place. */
  kinds?: Record<CanvasKind, CanvasKindDef>;
  /** Ask, for a pane with no composer beside it (the Mail view's): the chip goes where this says, not into a thread of the pane. */
  onAsk?: (chip: ContextChip) => void;
  /** The toggle's word and glyph when `children` is not a thread. */
  chatToggle?: ChatToggleWords;
  /** The thread's own view. */
  children: ReactNode;
}) {
  const { id: sessionId, environmentId } = session;
  const view = useCanvas(environmentId, sessionId);
  const split = useSplit(ITEM_SPLIT);
  const shown = view.items.find((item) => item.id === view.selected) ?? view.items[0] ?? null;
  // Ask, from the selection bar or a kind's own menu: the chip goes in, the thread unfolds, and its composer takes the caret once it is back in its slot.
  const putChip = (chip: ContextChip): void => {
    if (onAsk) {
      window.getSelection()?.removeAllRanges();
      return onAsk(chip);
    }
    addContextChip(sessionId, chip);
    window.getSelection()?.removeAllRanges();
    setFolded(sessionId, false);
    requestAnimationFrame(() => split.rootRef.current?.querySelector<HTMLElement>("[data-chat] [data-composer-input]")?.focus());
  };
  const { feeds, shell } = useFrame(environmentId, sessionId, shown, putChip);
  const module = useKindModule((shown ? kindDefOf(kinds, shown.kind) : kinds.document).chunk);
  const TabEnd = shown ? module?.TabEnd : undefined;
  const [kept, keep] = useKeptState(shown?.id ?? "");
  const [picking, setPicking] = useState(false);
  // A file from outside is said in the pane until it lands, items or none.
  const opening = useOpening(sessionId);
  const board = shown !== null || opening !== null;

  const close = (itemId: string): void => void closeItem(environmentId, sessionId, itemId).catch((error: unknown) => sayError(error, "Couldn't close the item"));
  const ask = (selection: CanvasSelection): void => {
    shell.selection(null);
    putChip(selection.chip);
  };

  const review = feeds.review && feeds.review.count > 0 ? feeds.review : null;
  const own = feeds.more ?? [];
  // A pillar's verbs for this item (canvas/itemVerbs.ts), after the pane's own rows and before Close.
  const verbs = shown ? itemVerbsFor(shown, shown.kind) : [];
  // The kind's own verbs first, then the verbs on every pending change, then the tab's.
  const rows: MenuRow[] = [
    ...own.map((entry): MenuRow => ({ kind: "item", id: KIND_ROW + entry.id, label: entry.label, icon: entry.icon, disabled: entry.disabled })),
    ...(own.length > 0 ? ([{ kind: "sep" }] satisfies MenuRow[]) : []),
    ...(review
      ? ([
          { kind: "item", id: "accept-all", label: "Accept all", icon: Check, disabled: review.held || review.verdictsHeld },
          { kind: "item", id: "reject-all", label: "Reject all", icon: X, disabled: review.held || review.verdictsHeld },
          { kind: "sep" },
        ] satisfies MenuRow[])
      : []),
    // A pane with no thread (the Mail view's) holds what its mail opens, and nothing else.
    ...(onAsk
      ? []
      : ([
          { kind: "item", id: "open-file", label: "Open file…", icon: File },
          { kind: "item", id: "google-open", label: "Open from Google…", icon: FolderOpen },
          { kind: "sep" },
        ] satisfies MenuRow[])),
    ...verbs.map((verb): MenuRow => ({ kind: "item", id: VERB_ROW + verb.id, label: verb.label, icon: verb.icon })),
    ...(verbs.length > 0 ? ([{ kind: "sep" }] satisfies MenuRow[]) : []),
    { kind: "item", id: "close", label: "Close", icon: X },
    ...(view.items.length > 1 ? ([{ kind: "item", id: "close-others", label: "Close others", icon: X }] satisfies MenuRow[]) : []),
  ];
  const pick = (id: string): void => {
    if (!shown) return;
    const entry = id.startsWith(KIND_ROW) ? own.find((e) => KIND_ROW + e.id === id) : undefined;
    if (entry) {
      Promise.resolve()
        .then(() => entry.run())
        .catch((error: unknown) => sayError(error, `Couldn't ${entry.label.charAt(0).toLowerCase()}${entry.label.slice(1)}`));
      return;
    }
    const verb = id.startsWith(VERB_ROW) ? verbs.find((v) => VERB_ROW + v.id === id) : undefined;
    if (verb) {
      Promise.resolve()
        .then(() => verb.run(shown, { environmentId }))
        .catch((error: unknown) => sayError(error, `Couldn't ${verb.label.charAt(0).toLowerCase()}${verb.label.slice(1)}`));
      return;
    }
    if (id === "google-open") setPicking(true);
    if (id === "open-file") void import("./openOutside").then(({ pickAndOpen }) => pickAndOpen({ at: "thread", sessionId })).catch((error: unknown) => sayError(error, "Couldn't open the file"));
    if (id === "close") close(shown.id);
    if (id === "close-others") view.items.filter((item) => item.id !== shown.id).forEach((item) => close(item.id));
    if (review && !review.held && !review.verdictsHeld && (id === "accept-all" || id === "reject-all")) {
      const accept = id === "accept-all";
      review[accept ? "accept" : "reject"]("all").catch((error: unknown) => sayError(error, accept ? "Couldn't accept the changes" : "Couldn't reject the changes"));
    }
  };

  return (
    <>
      {picking ? (
        <Suspense fallback={null}>
          <PickDialog env={environmentId} sessionId={sessionId} onClose={() => setPicking(false)} />
        </Suspense>
      ) : null}
      <SplitShell
        hasBoard={board}
        collapsed={view.folded}
        onToggleChat={(open) => setFolded(sessionId, !open)}
        splitState={split}
        // Under the thread's 360px and the item's 320px, the item keeps the pane and the open thread lies over it, under the tab row and its toggle.
        narrowFold
        chatToggle={chatToggle}
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
        board={
          board ? (
            <>
              {shown ? <CanvasPane key={shown.id} item={shown} environmentId={environmentId} feeds={feeds} shell={shell} onAsk={ask} kinds={kinds} tabbed={view.items.length > 1} /> : null}
              {opening ? <OpeningState opening={opening} docked={shown !== null} /> : null}
            </>
          ) : null
        }
        chat={children}
      />
    </>
  );
}

/** An upload under this size opens with the spinner alone: it is over before a bar would mean anything. */
export const BAR_FROM_BYTES = 4 * 1024 * 1024;

/**
 * A file from outside on its way into the pane: the spinner and its name, the upload's bar once it is big enough to take
 * a while, and Cancel. In an empty pane it is the pane's one content, centred; beside an item it is a 36px row at the
 * pane's foot, under the item, so the item stays readable while a big file goes up.
 */
function OpeningState({ opening, docked }: { opening: Opening; docked: boolean }) {
  const { name, sent, total, cancel } = opening;
  const what = (
    <span aria-live="polite" className={`flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground ${docked ? "flex-1" : ""}`}>
      <Spinner className="size-3.5 shrink-0" />
      <span className="truncate">Opening {name}</span>
    </span>
  );
  const bar = total >= BAR_FROM_BYTES ? <Progress value={(sent / total) * 100} aria-label={`Uploading ${name}`} className={docked ? "w-24 shrink-0" : "w-full"} /> : null;
  const stop = (
    <Button variant="ghost" size="xs" onClick={cancel}>
      Cancel
    </Button>
  );
  return docked ? (
    <div data-file-opening className="flex h-9 shrink-0 items-center gap-3 border-t border-border bg-background pr-2 pl-3">
      {what}
      {bar}
      {stop}
    </div>
  ) : (
    <div data-file-opening className="grid min-h-0 flex-1 place-items-center">
      <div className="flex w-64 max-w-[calc(100%-32px)] flex-col items-center gap-3">
        {what}
        {bar}
        {stop}
      </div>
    </div>
  );
}
