import type { ReactNode } from "react";
import type { MoneyRead, ToConfirm as Waiting } from "@shared/contract-work-money";
import { formatDay, formatMoney } from "@shared/work/money";
import { MoreHorizontal, Receipt } from "../../chrome/icons";
import { RowsMenu } from "../../chrome/menuRows";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { loadToast } from "../../components/ui/toaster";
import { request, withToast } from "./api";
import { usePicture } from "./receive";

/**
 * To confirm (docs/DESIGN.md "The Money view"): what waits for his accept,
 * a row each, the picture small at the start. A receipt still being read
 * says so and offers nothing; a read one opens in the entry dialog on
 * Review. Discard is in the row's menu, said back in a toast.
 */

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
    <li data-to-confirm={item.id} className="flex min-h-12 items-center gap-3 border-b border-border text-[13px] last:border-0">
      <Thumb env={env} item={item} />
      {reading ? (
        <span className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
          <Spinner aria-hidden className="size-3.5" />
          Reading
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-baseline gap-1">
          <span className="min-w-0 truncate">{name}</span>
          {item.fields.date ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatDay(item.fields.date)}</span> : null}
        </span>
      )}
      {!reading && item.fields.amount ? <span className="shrink-0 tabular-nums">{formatMoney(item.fields.amount)}</span> : null}
      {reading ? null : (
        <Button variant="ghost" size="sm" onClick={onReview} aria-label={`Review ${name}`}>
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
  return url ? (
    <img src={url} alt={name} draggable={false} className="max-h-[520px] w-full rounded-lg object-contain object-top outline-1 -outline-offset-1 outline-(--image-outline)" />
  ) : (
    <div aria-busy="true" aria-label="Loading the picture" className="grid aspect-[3/4] w-full place-items-center rounded-lg bg-muted outline-1 -outline-offset-1 outline-(--image-outline)">
      <Spinner aria-hidden className="text-muted-foreground" />
    </div>
  );
}
