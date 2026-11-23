import { useState, type ReactNode } from "react";
import type { CalendarOffer, MoneyRead, ToConfirm as Waiting } from "@shared/contract-work-money";
import { formatDay, formatMoney } from "@shared/work/money";
import { MoreHorizontal } from "../../chrome/icons";
import { Calendar, Receipt } from "../icons";
import { RowsMenu } from "../../chrome/menuRows";
import { BusyLabel, Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { loadToast } from "../../components/ui/toaster";
import { request, withToast } from "./api";
import { Facts } from "../../surfaces/settings/hosts/Facts";
import { offerDay } from "./model";
import { usePicture } from "./receive";
import { addOffer, offerWhole } from "./TripDialog";

/**
 * To confirm (docs/DESIGN.md "The Money view"): what waits for his accept,
 * a row each, the picture small at the start. A receipt still being read
 * says so and offers nothing; a read one opens in the entry dialog on
 * Review. Discard is in the row's menu, said back in a toast.
 */

/** A To confirm row: the picture, the words, the amount, the verb and the menu, each on its own column so the rows line up. */
const TO_CONFIRM_ROW = "grid min-h-12 grid-cols-[2rem_minmax(0,1fr)_6rem_4.5rem_1.75rem] items-center gap-3 border-b border-border text-[13px] last:border-0";

export function ToConfirmSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-foreground">{title}</h2>
        {action}
      </div>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

/** Drops a waiting receipt, and its file. */
export async function dropWaiting(env: string, item: Pick<Waiting, "id" | "name" | "fields">): Promise<void> {
  await request(env, "work.money.drop", { id: item.id });
  const what = item.fields.who || item.name || "the receipt";
  void loadToast().then((toast) => toast(`Discarded ${what}`));
}

export function ReceiptRows({ env, read, onReview, reload }: { env: string; read: MoneyRead; onReview: (id: string) => void; reload: () => Promise<void> }) {
  return (
    <>
      {read.toConfirm.map((item) => (
        <ReceiptRow key={item.id} env={env} item={item} onReview={() => onReview(item.id)} onDiscard={() => withToast(() => dropWaiting(env, item).then(reload))} />
      ))}
    </>
  );
}

function ReceiptRow({ env, item, onReview, onDiscard }: { env: string; item: Waiting; onReview: () => void; onDiscard: () => void }) {
  const reading = item.state === "reading";
  const name = item.fields.who || item.name || "Receipt";
  return (
    <li data-to-confirm={item.id} className={TO_CONFIRM_ROW}>
      <Thumb env={env} item={item} />
      {reading ? (
        <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
          <Spinner aria-hidden className="size-3.5" />
          Reading
        </span>
      ) : (
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="min-w-0 truncate text-foreground">{name}</span>
          {item.fields.date ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatDay(item.fields.date)}</span> : null}
        </span>
      )}
      <span className="text-end tabular-nums">{!reading && item.fields.amount ? formatMoney(item.fields.amount) : null}</span>
      {reading ? (
        <span />
      ) : (
        <Button variant="ghost" size="sm" className="justify-self-end" onClick={onReview} aria-label={`Review ${name}`}>
          Review
        </Button>
      )}
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
    </li>
  );
}

/** The 32px picture at a row's start; the receipt glyph in its place while it comes or where there is none. */
function Thumb({ env, item }: { env: string; item: Waiting }) {
  const url = usePicture(env, item.picture && item.state === "ready" ? { id: item.id } : null);
  return (
    <span aria-hidden className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-md bg-muted text-muted-foreground outline-1 -outline-offset-1 outline-(--image-outline)">
      {url ? <img src={url} alt="" draggable={false} className="size-full object-cover" /> : <Receipt className="size-3.5" />}
    </span>
  );
}

/** A receipt's picture beside the dialog's fields: the whole page at the column's width. */
export function ReceiptPicture({ env, of, name }: { env: string; of: { id: string } | { workspaceId: string; receipt: string }; name: string }) {
  const url = usePicture(env, of);
  // The picture at its own height in the 320px column, 420px at most; a taller one scrolls inside the column.
  return url ? (
    <div data-receipt-picture className="max-h-[420px] overflow-x-hidden overflow-y-auto rounded-lg outline-1 -outline-offset-1 outline-(--image-outline) [--scrollbar-inset:var(--radius-lg)]">
      <img src={url} alt={name} draggable={false} className="block h-auto w-full" />
    </div>
  ) : (
    <div aria-busy="true" aria-label="Loading the picture" className="grid h-[420px] w-full place-items-center rounded-lg bg-muted outline-1 -outline-offset-1 outline-(--image-outline)">
      <Spinner aria-hidden className="text-muted-foreground" />
    </div>
  );
}

/** Skips an offer: it is not offered again. */
export const skipOffer = (env: string, workspaceId: string, offer: CalendarOffer): Promise<unknown> => request(env, "work.money.skip", { workspaceId, eventId: offer.eventId });

/** Add all: every whole offer, one after another. */
export async function addAll(env: string, workspaceId: string, offers: readonly CalendarOffer[]): Promise<void> {
  for (const offer of offers.filter(offerWhole)) await addOffer(env, workspaceId, offer);
}

/** The calendar's offers after the receipts: the day, the event, its fee and miles; Add when whole, else Review. */
export function CalendarRows({ env, workspaceId, read, adding, onReview, reload }: { env: string; workspaceId: string; read: MoneyRead; adding: boolean; onReview: (offer: CalendarOffer) => void; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <>
      {read.calendar.map((offer) => {
        const whole = offerWhole(offer);
        const add = () => {
          setBusy(offer.eventId);
          withToast(() =>
            addOffer(env, workspaceId, offer)
              .then(reload)
              .finally(() => setBusy(null)),
          );
        };
        return (
          <li key={offer.eventId} data-calendar-offer={offer.eventId} className={TO_CONFIRM_ROW}>
            <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
              <Calendar className="size-3.5" />
            </span>
            <span className="flex min-w-0 items-baseline gap-1">
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{offerDay(offer.date)}</span>
              <span className="min-w-0 truncate">{offer.title}</span>
              <Facts className="shrink-0 text-xs text-muted-foreground" parts={[offer.fee !== null ? formatMoney(offer.fee).replace(/\.00$/, "") : null, offer.miles !== null ? `${offer.miles.toLocaleString("en-US")} mi` : null]} />
            </span>
            <span />
            {whole ? (
              <Button variant="ghost" size="sm" className="justify-self-end" disabled={busy !== null || adding} onClick={add} aria-label={`Add ${offer.title}`}>
                <BusyLabel busy={busy === offer.eventId} label="Add" />
              </Button>
            ) : (
              <Button variant="ghost" size="sm" className="justify-self-end" onClick={() => onReview(offer)} aria-label={`Review ${offer.title}`}>
                Review
              </Button>
            )}
            <RowsMenu
              label={`${offer.title} menu`}
              align="end"
              rows={[{ kind: "item", id: "skip", label: "Skip" }]}
              onPick={(id) => id === "skip" && withToast(() => skipOffer(env, workspaceId, offer).then(reload))}
              trigger={
                <Button variant="ghost" size="icon-sm" aria-label={`More for ${offer.title}`} className="text-muted-foreground">
                  <MoreHorizontal />
                </Button>
              }
            />
          </li>
        );
      })}
    </>
  );
}
