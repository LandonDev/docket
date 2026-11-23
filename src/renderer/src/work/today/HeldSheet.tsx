import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { X } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Sheet, SheetClose, SheetContent } from "../../components/ui/sheet";
import { cn } from "../../lib/cn";
import { useEnvironments } from "../../lib/connection";
import { DUR } from "../../lib/ease";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { workOpenPort } from "../../lib/workSwitch";
import { shell } from "../../stores/shell";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { HeldDetail, rememberOutboxTab } from "../outbox/OutboxView";
import { outboxNow, useOutbox, type HostItem } from "../outbox/store";
import { heldKey, placeOf } from "./held";
import { advanceHeld, leave, openHeld, todayNow, useTodayState } from "./store";

/**
 * A held item whole, over Today (docs/DESIGN.md "Today"): a sheet from the
 * right whose body is the Outbox's own detail, with its Send, Edit, Discard
 * and grant menu and its rule that Send waits until the whole item is on
 * screen. Today adds no way to send. After a press the sheet shows the next
 * held item, so a morning's presses are one run; after the last it closes.
 * When it closes, focus goes back to the page's list: to the row that
 * opened it, or the row that took its place.
 */
export function HeldSheet() {
  const { held: key, heldDone: done, leaving, closing, gone } = useTodayState();
  const waiting = useOutbox().waiting;
  const workspaces = useWorkspaces();
  const environments = useEnvironments();
  // The item shown stays while the sheet leaves, so its exit is the item's, never an empty panel's.
  const [shownKey, setShownKey] = useState(key);
  useEffect(() => {
    if (key) setShownKey(key);
  }, [key]);
  const at = waiting.findIndex((item) => heldKey(item) === (key ?? shownKey));
  const item = waiting[at] ?? null;
  // What still waits: the host's list without the items his press already took. The list drops a sent item only
  // when its reload is back, a beat after the sheet has moved on, and the run's count must not wait for it.
  const left = waiting.filter((i) => {
    const k = heldKey(i);
    return !leaving.has(k) && !closing.has(k) && !gone.has(k);
  }).length;
  // The order he sees, kept for the press: the host's list may drop the item before its answer is back.
  useLayoutEffect(() => {
    if (at !== -1) runOrder = waiting.map(heldKey);
  }, [at, waiting]);
  // The place as the item's row names it (held.ts `placeOf`).
  const workspace = (i: HostItem): string => placeOf(i, (environmentId, workspaceId) => workspaces.find((w) => w.environmentId === environmentId && w.id === workspaceId)?.name) ?? "A Work workspace";
  const host = (i: HostItem): string => environments.find((e) => e.id === i.environmentId)?.name ?? "A host";
  return (
    <Sheet open={key !== null} onOpenChange={(open) => (open ? undefined : openHeld(null))}>
      <SheetContent side="right" width={520} showCloseButton={false} aria-label={item ? item.summary : "Held item"} data-today-held finalFocus={listStop}>
        <HeldSheetBody
          item={item}
          left={left}
          done={done}
          workspace={item ? workspace(item) : ""}
          host={item ? host(item) : ""}
          close={
            <SheetClose aria-label="Close" render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" />}>
              <X />
            </SheetClose>
          }
        />
      </SheetContent>
    </Sheet>
  );
}

/**
 * Where focus goes when the sheet closes: the page's own stop (the row that
 * opened it may have left by then), or the page itself once it has no row
 * left to stop on.
 */
const listStop = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-today] [data-roving-key][tabindex="0"]') ?? document.querySelector<HTMLElement>('[data-work-place="today"]');

/**
 * What the sheet holds: its place in the run and Close over the Outbox's own
 * detail. The run counts forward by its own steps: `done` items decided
 * since the sheet opened, then this one, of those and the `left` that still
 * wait ("2 of 3"), whenever the host's list catches up.
 */
export function HeldSheetBody({ item, left, done = 0, workspace, host, close }: { item: HostItem | null; left: number; done?: number; workspace: string; host: string; close: ReactNode }) {
  const key = item ? heldKey(item) : null;
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border ps-8 pe-6">
        {/* Where he is in the run, as a question card says it; one item alone says nothing. */}
        <span data-today-run className="min-w-0 flex-1 truncate text-xs tabular-nums text-muted-foreground">{item && done + left > 1 ? `${done + 1} of ${done + left}` : null}</span>
        {close}
      </div>
      <ItemBody key={key ?? "none"} label={item?.summary} late={done > 0}>
        {item ? (
          <HeldDetail
            key={heldKey(item)}
            item={item}
            workspace={workspace}
            host={host}
            alone
            onOpenSession={(sessionId) => {
              openHeld(null);
              shell.closeViews();
              workOpenPort.get()?.(sessionId);
            }}
            onPressed={afterPress}
            onReview={() => {
              openHeld(null);
              rememberOutboxTab("sent");
              shell.openOutbox();
            }}
          />
        ) : (
          <EmptyState title="No longer waiting" line="Another press or device decided it." />
        )}
      </ItemBody>
    </>
  );
}

/**
 * An item's body in the sheet. One that took the sheet after a press
 * (`late`) fades in over `--dur-base` and takes the focus, so the keyboard
 * reads it from its top (the ring shows where it went). Until the fade is
 * over what it holds is inert, to the pointer and to the keys alike: the
 * second click of a double click, or a key held down, never lands on the
 * next item's Send. Where no fade runs it is free at once.
 */
function ItemBody({ label, late, children }: { label: string | undefined; late: boolean; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [arriving, setArriving] = useState(late);
  useLayoutEffect(() => {
    if (!late) return;
    box.current?.focus({ preventScroll: true });
    // No fade to wait for (a browser that runs none): free at once.
    if (box.current && getComputedStyle(box.current).transitionDuration.split(",").every((d) => parseFloat(d) === 0)) setArriving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as it takes the sheet
  }, []);
  useEffect(() => {
    if (!late) return;
    // The fade's own end frees it; the timer is for an end that never comes (the sheet hidden mid-fade).
    const timer = setTimeout(() => setArriving(false), DUR.base * 1000 + 60);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as it takes the sheet
  }, []);
  return (
    <div
      ref={box}
      tabIndex={-1}
      aria-label={label}
      data-today-arriving={arriving ? "" : undefined}
      onTransitionEnd={(event) => event.target === box.current && event.propertyName === "opacity" && setArriving(false)}
      // The ring follows the sheet's own lower corners, which clip it.
      className={cn("focus-ring flex min-h-0 flex-1 flex-col rounded-b-2xl", late && "transition-opacity duration-(--dur-base) ease-(--ease-out) starting:opacity-0")}
    >
      <div inert={arriving ? true : undefined} className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </div>
  );
}

/**
 * After his press the item leaves the list: the next one down takes the
 * sheet, else the one before, else the sheet closes. Only while that item is
 * still what the sheet shows: a reply that lands after he closed it, or
 * opened another, moves nothing. The order is the one he saw, so a list the
 * host refreshed while the press was out still hands the sheet on.
 */
function afterPress(item: HostItem): void {
  const key = heldKey(item);
  // The row leaves by his own act: it fades and the rows under it glide up, whenever the host's list drops it.
  leave(key);
  const now = todayNow();
  if (now.held !== key) return;
  // What still waits is the host's list without what his presses already took: the list may still hold an item he
  // sent a moment ago, and the sheet must never go back to it.
  const still = outboxNow()
    .waiting.map(heldKey)
    .filter((k) => !now.leaving.has(k) && !now.closing.has(k) && !now.gone.has(k));
  advanceHeld(nextHeld(key, runOrder, still));
}

/** The keys of the held items in the order the sheet last showed them. */
let runOrder: string[] = [];

/** The item that takes the sheet after `key` is decided: the next still waiting in the order he saw, else the nearest before it. */
export function nextHeld(key: string, order: readonly string[], waiting: readonly string[]): string | null {
  const still = new Set(waiting);
  still.delete(key);
  const at = order.indexOf(key);
  if (at === -1) return null;
  return order.slice(at + 1).find((k) => still.has(k)) ?? order.slice(0, at).reverse().find((k) => still.has(k)) ?? null;
}
