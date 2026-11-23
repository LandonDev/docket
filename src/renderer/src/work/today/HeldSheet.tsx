import { useEffect, useState, type ReactNode } from "react";
import { X } from "../../chrome/icons";
import { Button } from "../../components/ui/button";
import { Sheet, SheetClose, SheetContent } from "../../components/ui/sheet";
import { useEnvironments } from "../../lib/connection";
import { useWorkspaces } from "../../lib/tcserver/workspaces";
import { workOpenPort } from "../../lib/workSwitch";
import { shell } from "../../stores/shell";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { WORK_CHATS_KEY } from "../outbox/model";
import { HeldDetail, rememberOutboxTab } from "../outbox/OutboxView";
import { outboxNow, useOutbox, type HostItem } from "../outbox/store";
import { heldKey } from "./held";
import { leave, openHeld, todayNow, useTodayState } from "./store";

/**
 * A held item whole, over Today (docs/DESIGN.md "Today"): a sheet from the
 * right whose body is the Outbox's own detail, with its Send, Edit, Discard
 * and grant menu and its rule that Send waits until the whole item is on
 * screen. Today adds no way to send. After a press the sheet shows the next
 * held item, so a morning's presses are one run; after the last it closes.
 */
export function HeldSheet() {
  const key = useTodayState().held;
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
  const workspace = (i: HostItem): string =>
    !i.workspaceId || i.workspaceId === WORK_CHATS_KEY ? "Work Chats" : (workspaces.find((w) => w.environmentId === i.environmentId && w.id === i.workspaceId)?.name ?? "A Work workspace");
  const host = (i: HostItem): string => environments.find((e) => e.id === i.environmentId)?.name ?? "A host";
  return (
    <Sheet open={key !== null} onOpenChange={(open) => (open ? undefined : openHeld(null))}>
      <SheetContent side="right" width={520} showCloseButton={false} aria-label={item ? item.summary : "Held item"} data-today-held>
        <HeldSheetBody
          item={item}
          at={at}
          count={waiting.length}
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

/** What the sheet holds: its place in the run and Close over the Outbox's own detail. */
export function HeldSheetBody({ item, at, count, workspace, host, close }: { item: HostItem | null; at: number; count: number; workspace: string; host: string; close: ReactNode }) {
  return (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border ps-8 pe-2">
        {/* Where he is in the run, as a question card says it; one item alone says nothing. */}
        <span className="min-w-0 flex-1 truncate text-xs tabular-nums text-muted-foreground">{item && count > 1 ? `${at + 1} of ${count}` : null}</span>
        {close}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
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
      </div>
    </>
  );
}

/**
 * After his press the item leaves the list: the next one down takes the
 * sheet, else the one before, else the sheet closes. Only while that item is
 * still what the sheet shows: a reply that lands after he closed it, or
 * opened another, moves nothing.
 */
function afterPress(item: HostItem): void {
  const key = heldKey(item);
  // The row leaves by his own act: it fades and the rows under it glide up, whenever the host's list drops it.
  leave(key);
  if (todayNow().held !== key) return;
  const waiting = outboxNow().waiting;
  const at = waiting.findIndex((x) => heldKey(x) === key);
  const next = at === -1 ? null : (waiting[at + 1] ?? waiting[at - 1] ?? null);
  openHeld(next ? heldKey(next) : null);
}
