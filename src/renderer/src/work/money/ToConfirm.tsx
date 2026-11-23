import { useState, type ReactNode } from "react";
import type { CalendarOffer, MoneyRead, MoneyTripped, ToConfirm as Waiting } from "@shared/contract-work-money";
import { formatDay, formatMoney, today } from "@shared/work/money";
import { MoreHorizontal } from "../../chrome/icons";
import { Calendar, Receipt } from "../icons";
import { RowsMenu } from "../../chrome/menuRows";
import { BusyLabel, Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { loadToast } from "../../components/ui/toaster";
import { cn } from "../../lib/cn";
import { heardTrip, request, withToast } from "./api";
import { Facts } from "../../surfaces/settings/hosts/Facts";
import { TO_CONFIRM_GRID } from "./layout";
import { offerDay } from "./model";
import { usePicture } from "./receive";
import { addOffer, offerWhole } from "./TripDialog";

/**
 * To confirm (docs/DESIGN.md "The Money view"): what waits for his accept,
 * a row each, the picture small at the start, then the calendar's offers
 * under their own group name, with Add all on that line. A receipt still
 * being read says so and offers nothing; a read one opens in the entry
 * dialog on Review. Discard is in the row's menu, said back in a toast that
 * can undo it.
 */

/** A To confirm row: the picture, the words, the amount, then the verb and the menu, each on its own column (layout.ts). */
const ROW = cn("grid min-h-12 items-center gap-3 border-b border-border text-[13px] last:border-0", TO_CONFIRM_GRID);

/** "Nov 20", or "Nov 20, 2025" when it is not this year's. */
export const shortDay = (day: string, now: string = today()): string => formatDay(day, day.slice(0, 4) !== now.slice(0, 4));

/** Drops a waiting receipt (its file is kept a while), and says so with Undo. */
export async function dropWaiting(env: string, item: Pick<Waiting, "id" | "name" | "fields">, reload: () => Promise<void>): Promise<void> {
  await request(env, "work.money.drop", { id: item.id });
  void reload();
  const what = item.fields.who || item.name || "the receipt";
  void loadToast().then((toast) =>
    toast(`Discarded ${what}`, {
      action: {
        label: "Undo",
        onClick: () => withToast(() => request(env, "work.money.drop", { id: item.id, undo: true }).then(reload)),
      },
    }),
  );
}

/** Skips an offer: it is not offered again, and a toast says so with Undo. */
export async function skipOffer(env: string, workspaceId: string, offer: CalendarOffer, reload: () => Promise<void>): Promise<void> {
  await request(env, "work.money.skip", { workspaceId, eventId: offer.eventId });
  void reload();
  void loadToast().then((toast) =>
    toast(`Skipped ${offer.title}`, {
      action: { label: "Undo", onClick: () => withToast(() => request(env, "work.money.skip", { workspaceId, eventId: offer.eventId, undo: true }).then(reload)) },
    }),
  );
}

/** Adds an offer, saying a pay row that waits as a suggestion. */
async function addOne(env: string, workspaceId: string, offer: CalendarOffer): Promise<void> {
  const tripped: MoneyTripped | null = await addOffer(env, workspaceId, offer);
  heardTrip(env, workspaceId, tripped);
}

/** Add all: every whole offer, one after another. */
export async function addAll(env: string, workspaceId: string, offers: readonly CalendarOffer[]): Promise<void> {
  for (const offer of offers.filter(offerWhole)) await addOne(env, workspaceId, offer);
}

export function ToConfirmSection({ env, workspaceId, read, reload, onReview, onReviewOffer }: { env: string; workspaceId: string; read: MoneyRead; reload: () => Promise<void>; onReview: (id: string) => void; onReviewOffer: (offer: CalendarOffer) => void }) {
  const [adding, setAdding] = useState(false);
  const whole = read.calendar.filter(offerWhole).length;
  return (
    <section aria-label="To confirm" className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center">
        <h2 className="text-[13px] font-semibold text-foreground">To confirm</h2>
      </div>
      {read.toConfirm.length ? (
        <ul aria-label="Receipts" className="flex flex-col">
          {read.toConfirm.map((item) => (
            <ReceiptRow key={item.id} env={env} item={item} onReview={() => onReview(item.id)} onDiscard={() => withToast(() => dropWaiting(env, item, reload))} />
          ))}
        </ul>
      ) : null}
      {read.calendar.length ? (
        <div role="group" aria-label="From the calendar" className={cn("flex flex-col gap-1", read.toConfirm.length > 0 && "mt-2")}>
          <div className="flex min-h-6 items-center justify-between gap-2">
            <h3 className="text-xs font-medium text-muted-foreground">From the calendar</h3>
            {whole >= 2 ? (
              <Button
                variant="ghost"
                size="xs"
                className="-me-2"
                disabled={adding}
                onClick={() => {
                  setAdding(true);
                  withToast(() =>
                    addAll(env, workspaceId, read.calendar)
                      .then(reload)
                      .finally(() => setAdding(false)),
                  );
                }}
              >
                <BusyLabel busy={adding} label="Add all" />
              </Button>
            ) : null}
          </div>
          <ul className="flex flex-col">
            <CalendarRows env={env} workspaceId={workspaceId} read={read} adding={adding} onReview={onReviewOffer} reload={reload} />
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** The verb and the menu, at the row's end in their shared column; an empty slot keeps the width where there is nothing to press. */
function Actions({ children }: { children?: ReactNode }) {
  return <span className="flex items-center justify-end gap-1">{children}</span>;
}

function ReceiptRow({ env, item, onReview, onDiscard }: { env: string; item: Waiting; onReview: () => void; onDiscard: () => void }) {
  const reading = item.state === "reading";
  const name = item.fields.who || item.name || "Receipt";
  return (
    <li data-to-confirm={item.id} className={ROW}>
      <Thumb env={env} item={item} />
      {reading ? (
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <Spinner aria-hidden className="size-3.5" />
          Reading
        </span>
      ) : (
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="min-w-0 truncate text-foreground">{name}</span>
          {item.fields.date ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{shortDay(item.fields.date)}</span> : null}
        </span>
      )}
      <span className="text-end tabular-nums">{!reading && item.fields.amount ? formatMoney(item.fields.amount) : null}</span>
      {/* A receipt still being read has nothing to press. */}
      {reading ? (
        <Actions />
      ) : (
        <Actions>
          <Button variant="ghost" size="sm" onClick={onReview} aria-label={`Review ${name}`}>
            Review
          </Button>
          <RowsMenu
            label={`${name} menu`}
            align="end"
            rows={[{ kind: "item", id: "discard", label: "Discard" }]}
            onPick={(id) => id === "discard" && onDiscard()}
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label={`More for ${name}`} className="text-muted-foreground">
                <MoreHorizontal />
              </Button>
            }
          />
        </Actions>
      )}
    </li>
  );
}

/** The 32px picture at a row's start; the receipt glyph in its place while it comes or where there is none. */
function Thumb({ env, item }: { env: string; item: Waiting }) {
  const picture = usePicture(env, item.picture && item.state === "ready" ? { id: item.id } : null);
  return (
    // The image outline is a picture's: a glyph tile has none, as the calendar's tiles.
    <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center overflow-hidden rounded-md bg-muted text-muted-foreground", picture.state === "ready" && "outline-1 -outline-offset-1 outline-(--image-outline)")}>
      {picture.state === "ready" ? <img src={picture.url} alt="" draggable={false} className="size-full object-cover" onError={picture.broken} /> : <Receipt className="size-3.5" />}
    </span>
  );
}

/** A receipt's picture beside the dialog's fields: at its own height in the 320px column, 420px at most, a taller one scrolling inside the column; one quiet line with Retry when it did not load. */
export function ReceiptPicture({ env, of, name }: { env: string; of: { id: string } | { workspaceId: string; receipt: string }; name: string }) {
  const picture = usePicture(env, of);
  if (picture.state === "ready") {
    return (
      <div data-receipt-picture className="max-h-[420px] overflow-x-hidden overflow-y-auto rounded-lg outline-1 -outline-offset-1 outline-(--image-outline) [--scrollbar-inset:var(--radius-lg)]">
        <img src={picture.url} alt={name} draggable={false} className="block h-auto w-full" onError={picture.broken} />
      </div>
    );
  }
  if (picture.state === "failed") {
    return (
      <div data-receipt-picture="failed" className="flex h-[420px] w-full flex-col items-center justify-center gap-2 rounded-lg bg-muted text-muted-foreground outline-1 -outline-offset-1 outline-(--image-outline)">
        <Receipt className="size-4" />
        <p className="text-xs">The picture did not load</p>
        <Button variant="ghost" size="xs" onClick={picture.retry}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <div aria-busy="true" aria-label="Loading the picture" className="grid h-[420px] w-full place-items-center rounded-lg bg-muted outline-1 -outline-offset-1 outline-(--image-outline)">
      <Spinner aria-hidden className="text-muted-foreground" />
    </div>
  );
}

/** The calendar's offers: the day, the event, its fee and miles; Add when whole, else Review. */
function CalendarRows({ env, workspaceId, read, adding, onReview, reload }: { env: string; workspaceId: string; read: MoneyRead; adding: boolean; onReview: (offer: CalendarOffer) => void; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <>
      {read.calendar.map((offer) => {
        const whole = offerWhole(offer);
        const add = () => {
          setBusy(offer.eventId);
          withToast(() =>
            addOne(env, workspaceId, offer)
              .then(reload)
              .finally(() => setBusy(null)),
          );
        };
        return (
          <li key={offer.eventId} data-calendar-offer={offer.eventId} className={ROW}>
            <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
              <Calendar className="size-3.5" />
            </span>
            <span className="flex min-w-0 items-baseline gap-1">
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{offerDay(offer.date)}</span>
              <span className="min-w-0 truncate">{offer.title}</span>
              <Facts className="shrink-0 text-xs text-muted-foreground" parts={[offer.fee !== null ? formatMoney(offer.fee) : null, offer.miles !== null ? `${offer.miles.toLocaleString("en-US")} mi` : null]} />
            </span>
            <span />
            <Actions>
              {whole ? (
                <Button variant="ghost" size="sm" disabled={busy !== null || adding} onClick={add} aria-label={`Add ${offer.title}`}>
                  <BusyLabel busy={busy === offer.eventId} label="Add" />
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => onReview(offer)} aria-label={`Review ${offer.title}`}>
                  Review
                </Button>
              )}
              <RowsMenu
                label={`${offer.title} menu`}
                align="end"
                rows={[{ kind: "item", id: "skip", label: "Skip" }]}
                onPick={(id) => id === "skip" && withToast(() => skipOffer(env, workspaceId, offer, reload))}
                trigger={
                  <Button variant="ghost" size="icon-sm" aria-label={`More for ${offer.title}`} className="text-muted-foreground">
                    <MoreHorizontal />
                  </Button>
                }
              />
            </Actions>
          </li>
        );
      })}
    </>
  );
}
