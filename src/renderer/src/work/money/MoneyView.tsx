import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { receiptSource, type CalendarOffer, type MoneyRead } from "@shared/contract-work-money";
import { loadToast } from "../../components/ui/toaster";
import { formatDay, formatMoney, invoiceTotal, milesLine, sigOf, today, type LedgerRow, type OwedRow } from "@shared/work/money";
import { AXIS, BAR, BAR_CURSOR, ChartFrame, GRID } from "@aliax/charts/chart";
import { ChartLegend } from "@aliax/charts/legend";
import { ChartTooltipContent } from "@aliax/charts/tooltip";
import { ChevronLeft, ChevronRight, MoreHorizontal, Paperclip, Plus } from "../../chrome/icons";
import { RowsMenu, type MenuRow } from "../../chrome/menuRows";
import { ChoiceToggle } from "../../components/choice-toggle";
import { BusyLabel, Button } from "../../components/ui/button";
import { ItemButton } from "../../components/ui/item";
import { Skeleton } from "../../components/ui/skeleton";
import { StatusMark } from "../../components/ui/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../surfaces/SurfaceSkeleton";
import { Facts, splitFacts } from "../../surfaces/settings/hosts/Facts";
import { shared, useShared } from "../tasks/store";
import { ViewStateLine } from "../views/ViewStateLine";
import type { WorkViewProps } from "../views/registry";
import { atOf, markPaid, openBook, openBooks, openReceipt, useMoney, withToast } from "./api";
import { ConfirmFlow } from "./ConfirmFlow";
import { EntryDialog } from "./EntryDialog";
import { receiveFiles, takesFile } from "./receive";
import { ExportDialog } from "./ExportDialog";
import { InvoiceDialog, invoiceTitle, type InvoiceKind } from "./InvoiceDialog";
import { sendInvoice, sentAs } from "./send";
import { RateDialog } from "./RateDialog";
import { addAll, CalendarRows, ReceiptPicture, ReceiptRows, ToConfirmSection } from "./ToConfirm";
import { offerWhole, TripDialog } from "./TripDialog";
import { periodLabel, periodNow, periodOf, rowMoney, shortMoney, signedMoney, sinceWords, stepPeriod, type PeriodState, type Span } from "./model";

/**
 * A Work workspace's Money (docs/agents/work-money.md, docs/DESIGN.md "The
 * Money view"): the job's ledger read as money, one column top to bottom
 * like a document. The figures as text on one hairline row, one chart for a
 * year, flat lists, and every write in the one entry dialog.
 */

const SPANS = [
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
] as const;

/** A dialog the header or the body opened. */
export type MoneyDialog = { kind: "entry" } | { kind: "row"; row: LedgerRow } | { kind: "pick" } | { kind: "confirm"; id: string } | { kind: "trip"; offer: CalendarOffer | null } | { kind: "rate" } | { kind: "export" } | { kind: "invoice"; as: InvoiceKind };

/** What the header and the body share: the period, and the dialog open. */
const ui = shared<{ period: PeriodState; dialog: MoneyDialog | null }>({ period: periodNow(), dialog: null });
const set = (patch: Partial<ReturnType<typeof ui.get>>) => ui.set({ ...ui.get(), ...patch });
/** Each visit opens on this month. */
export const resetMoneyView = () => ui.set({ period: periodNow(), dialog: null });
/** Opens a dialog from outside the header (the preview, a later verb). */
export const openMoneyDialog = (dialog: MoneyDialog) => set({ dialog });
/** Puts the view on a period (the preview, the tests). */
export const setMoneyPeriod = (period: PeriodState) => set({ period });

export function Head({ env, workspace, sector }: WorkViewProps) {
  const { period } = useShared(ui);
  const unit = period.span;
  const addRows: MenuRow[] = [
    { kind: "item", id: "receipt", label: "Receipt…" },
    { kind: "item", id: "entry", label: "Entry…" },
    { kind: "item", id: "trip", label: "Trip…" },
    { kind: "item", id: "invoice", label: "Invoice…" },
    // A purchase request asks Purdue leave to buy: only a Purdue job has one.
    ...(sector === "purdue" ? [{ kind: "item" as const, id: "request", label: "Purchase request…" }] : []),
  ];
  const moreRows: MenuRow[] = [
    { kind: "item", id: "ledger", label: "Open ledger" },
    { kind: "item", id: "mileage", label: "Open mileage log" },
    { kind: "sep" },
    { kind: "item", id: "export", label: "Export…" },
    { kind: "item", id: "rate", label: "Mileage rate…" },
  ];
  return (
    <>
      <ChoiceToggle label="Show" value={unit} options={SPANS} onChange={(span: Span) => set({ period: { ...period, span } })} />
      <div className="flex items-center">
        <Button variant="ghost" size="icon-sm" aria-label={`Previous ${unit}`} onClick={() => set({ period: stepPeriod(period, -1) })}>
          <ChevronLeft />
        </Button>
        <span data-money-period className="w-[120px] truncate text-center text-[13px] tabular-nums">
          {periodLabel(period)}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label={`Next ${unit}`} onClick={() => set({ period: stepPeriod(period, 1) })}>
          <ChevronRight />
        </Button>
      </div>
      <RowsMenu
        label="Add"
        align="end"
        rows={addRows}
        onPick={(id) => {
          if (id === "entry") set({ dialog: { kind: "entry" } });
          else if (id === "receipt") set({ dialog: { kind: "pick" } });
          else if (id === "trip") set({ dialog: { kind: "trip", offer: null } });
          else if (id === "invoice" || id === "request") set({ dialog: { kind: "invoice", as: id === "request" ? "request" : "invoice" } });
        }}
        trigger={
          <Button variant="ghost" size="sm">
            <Plus />
            Add
          </Button>
        }
      />
      <RowsMenu
        label="More"
        align="end"
        rows={moreRows}
        onPick={(id) => {
          if (id === "ledger" || id === "mileage") withToast(() => openBook(env, workspace.id, id));
          else if (id === "rate") set({ dialog: { kind: "rate" } });
          else if (id === "export") set({ dialog: { kind: "export" } });
        }}
        trigger={
          <Button variant="ghost" size="icon-sm" aria-label="More">
            <MoreHorizontal />
          </Button>
        }
      />
    </>
  );
}

export function View({ env, workspace }: WorkViewProps) {
  const { period, dialog } = useShared(ui);
  const span = useMemo(() => periodOf(period), [period]);
  const [load, reload] = useMoney(env, workspace.id, span);
  useEffect(() => resetMoneyView, []);
  const read = load.read;
  const close = () => set({ dialog: null });
  const picker = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const quiet = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Add → Receipt…: the system's picker, for several at once.
  useEffect(() => {
    if (dialog?.kind !== "pick") return;
    set({ dialog: null });
    picker.current?.click();
  }, [dialog]);

  const receive = (files: File[]) => {
    const taken = files.filter(takesFile);
    if (!taken.length) return;
    void receiveFiles({ env, workspaceId: workspace.id, host: read?.root.host ?? null }, taken).then((refused) => {
      void reload();
      if (refused.length) void loadToast().then((toast) => toast.error(refused.join("\n")));
    });
  };
  const receiveRef = useRef(receive);
  receiveRef.current = receive;

  // A picture pasted anywhere in the view, but into a field or a dialog, is a receipt.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, [contenteditable=true], [role=dialog]")) return;
      const files = Array.from(event.clipboardData?.files ?? []).filter((f) => /^image\//.test(f.type));
      if (!files.length) return;
      event.preventDefault();
      receiveRef.current(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
  useEffect(() => () => void (quiet.current && clearTimeout(quiet.current)), []);

  // The view takes a dropped file itself, so the frame's drop never starts a thread with it.
  const carries = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const onDragOver = (event: DragEvent) => {
    if (!carries(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setOver(true);
    // A drag that leaves the window says nothing more: a quiet spell ends the wash.
    if (quiet.current) clearTimeout(quiet.current);
    quiet.current = setTimeout(() => setOver(false), 350);
  };
  const onDrop = (event: DragEvent) => {
    if (!carries(event)) return;
    event.preventDefault();
    setOver(false);
    receive(Array.from(event.dataTransfer.files));
  };

  let body: ReactNode;
  if (!read) body = load.error ? null : <MoneySkeleton />;
  else if (isEmpty(read)) body = <EmptyState title="No money yet" line="Drop a receipt here." action={{ label: "Add entry", onClick: () => set({ dialog: { kind: "entry" } }) }} />;
  else body = <Ledger env={env} workspaceId={workspace.id} read={read} label={periodLabel(period)} year={period.span === "year"} reload={reload} />;

  return (
    <div data-money-view className="flex h-full min-h-0 flex-col" onDragOver={onDragOver} onDrop={onDrop}>
      {load.error ? <ViewStateLine word="Money did not load" detail={load.error} onRetry={reload} /> : null}
      {read?.problems.map((p) =>
        p.kind === "columns" ? (
          <ProblemLine
            key="columns"
            word="The ledger's columns changed"
            detail={`Missing ${p.missing.join(", ")}`}
            action="Restore columns"
            onPress={() => openBooks(env, workspace.id, true).then(reload)}
          />
        ) : null,
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {body}
        {over ? (
          <div data-money-wash className="absolute inset-0 z-20 grid place-items-center bg-background/80 text-[13px] text-muted-foreground">
            File as receipt
          </div>
        ) : null}
      </div>
      <input
        ref={picker}
        type="file"
        accept="image/*,application/pdf"
        multiple
        hidden
        aria-label="Receipts"
        onChange={(e) => {
          receive(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      {read && dialog?.kind === "entry" ? <EntryDialog key="new" env={env} workspaceId={workspace.id} read={read} mode="new" onClose={close} onSaved={() => void reload()} /> : null}
      {read && dialog?.kind === "row" ? (
        <EntryDialog
          key={`row-${dialog.row.row}`}
          env={env}
          workspaceId={workspace.id}
          read={read}
          mode="edit"
          row={dialog.row}
          picture={dialog.row.receipt && /\.(pdf|jpe?g|png|heic|webp|gif)$/i.test(dialog.row.receipt) ? <ReceiptPicture env={env} of={{ workspaceId: workspace.id, receipt: dialog.row.receipt }} name={dialog.row.receipt} /> : undefined}
          footerStart={sentAs(dialog.row.receipt) ? <SendRow env={env} workspaceId={workspace.id} read={read} row={dialog.row} onSent={close} /> : undefined}
          onClose={close}
          onSaved={() => void reload()}
        />
      ) : null}
      {read && dialog?.kind === "trip" ? (
        <TripDialog env={env} workspaceId={workspace.id} offer={dialog.offer} day={today() >= span.from && today() < span.to ? today() : span.from} onClose={close} onSaved={() => void reload()} />
      ) : null}
      {read && dialog?.kind === "rate" ? <RateDialog env={env} workspaceId={workspace.id} rate={read.rate} onClose={close} onSaved={() => void reload()} /> : null}
      {dialog?.kind === "invoice" ? (
        <InvoiceDialog
          env={env}
          workspaceId={workspace.id}
          kind={dialog.as}
          onClose={close}
          onCreated={(kept, invoice) => {
            void reload();
            const title = invoiceTitle(invoice.kind, invoice.number);
            const file = kept.source;
            void loadToast().then((toast) =>
              toast(`${title} created`, file ? { action: { label: "Send…", onClick: () => withToast(() => sendInvoice(env, workspace.id, file, invoice.kind, invoice.number, formatMoney(invoiceTotal(invoice.lines)))) } } : undefined),
            );
          }}
        />
      ) : null}
      {dialog?.kind === "export" ? <ExportDialog env={env} workspaceId={workspace.id} year={period.year} onClose={close} /> : null}
      {read && dialog?.kind === "confirm" ? <ConfirmFlow env={env} workspaceId={workspace.id} read={read} first={dialog.id} onClose={close} reload={reload} /> : null}
    </div>
  );
}

/** Send… in a row's dialog, for a row whose kept file is an invoice or a purchase request: the composer, filled, and the PDF in Files. */
function SendRow({ env, workspaceId, read, row, onSent }: { env: string; workspaceId: string; read: MoneyRead; row: LedgerRow; onSent: () => void }) {
  const sent = row.receipt ? sentAs(row.receipt) : null;
  if (!sent) return null;
  return (
    <Button variant="ghost" onClick={() => withToast(() => sendInvoice(env, workspaceId, receiptSource(read.root, row.receipt), sent.kind, sent.number, formatMoney(row.in || row.out)).then(onSent))}>
      Send…
    </Button>
  );
}

/** A job with no ledger, or a ledger with nothing in it at all. */
export const isEmpty = (read: MoneyRead): boolean => !read.made || (read.sellers.length === 0 && read.rows.length === 0 && read.owed.length === 0 && read.toConfirm.length === 0 && read.calendar.length === 0);

function Ledger({ env, workspaceId, read, label, year, reload }: { env: string; workspaceId: string; read: MoneyRead; label: string; year: boolean; reload: () => Promise<void> }) {
  const [category, setCategory] = useState<string | null>(null);
  // A category of another period does not narrow this one.
  const narrowed = category && read.byCategory.some((c) => c.category.toLowerCase() === category.toLowerCase()) ? category : null;
  const rows = narrowed ? read.rows.filter((r) => (r.category || "Other").toLowerCase() === narrowed.toLowerCase()) : read.rows;
  return (
    <div className="h-full min-h-0 overflow-x-hidden overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-4 py-4">
        {read.toConfirm.length || read.calendar.length ? (
          <ToConfirm env={env} workspaceId={workspaceId} read={read} reload={reload} />
        ) : null}
        <Figures read={read} />
        {year ? <ByMonth read={read} /> : null}
        {read.byCategory.length ? (
          <Section title="By category">
            <ByCategory read={read} selected={narrowed} onPick={(c) => setCategory(c === narrowed ? null : c)} />
          </Section>
        ) : null}
        {read.owed.length ? (
          <Owed env={env} workspaceId={workspaceId} owed={read.owed} reload={reload} />
        ) : null}
        <Section
          title={narrowed ? `Entries in ${narrowed}` : "Entries"}
          action={
            narrowed ? (
              <Button variant="ghost" size="xs" onClick={() => setCategory(null)}>
                Clear
              </Button>
            ) : null
          }
        >
          {rows.length ? (
            <Entries env={env} workspaceId={workspaceId} read={read} rows={rows} />
          ) : (
            <p className="text-[13px] text-muted-foreground">Nothing in {label}</p>
          )}
        </Section>
        {read.miles.miles > 0 ? (
          <Section title="Mileage">
            <Facts parts={splitFacts(milesLine(read.miles))} className="text-[13px] text-muted-foreground" />
          </Section>
        ) : null}
      </div>
    </div>
  );
}

function ToConfirm({ env, workspaceId, read, reload }: { env: string; workspaceId: string; read: MoneyRead; reload: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const whole = read.calendar.filter(offerWhole).length;
  return (
    <ToConfirmSection
      title="To confirm"
      action={
        whole >= 2 ? (
          <Button
            variant="ghost"
            size="xs"
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
        ) : null
      }
    >
      <ReceiptRows env={env} read={read} onReview={(id) => set({ dialog: { kind: "confirm", id } })} reload={reload} />
      <CalendarRows env={env} workspaceId={workspaceId} read={read} adding={adding} onReview={(offer) => set({ dialog: { kind: "trip", offer } })} reload={reload} />
    </ToConfirmSection>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// ── the figures ──────────────────────────────────────────────────────

function Figures({ read }: { read: MoneyRead }) {
  const { sums } = read;
  return (
    <div data-money-figures className="flex flex-wrap items-start gap-x-8 gap-y-3 border-b border-border pb-4">
      <Figure label="In" cents={sums.in} />
      <Figure label="Out" cents={sums.out} />
      <Figure label="Net" cents={sums.net} />
      {sums.owedToHim || sums.heOwes ? (
        <div className="ms-auto flex gap-x-8">
          {sums.owedToHim ? <Figure label="Owed to you" cents={sums.owedToHim} /> : null}
          {sums.heOwes ? <Figure label="You owe" cents={sums.heOwes} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function Figure({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base leading-6 font-semibold tracking-[-0.01em] tabular-nums">{formatMoney(cents)}</span>
    </div>
  );
}

// ── the year's chart ─────────────────────────────────────────────────

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
type TooltipProps = Parameters<typeof ChartTooltipContent>[0];

function ByMonth({ read }: { read: MoneyRead }) {
  const data = read.byMonth.map((m) => ({ month: MONTH_SHORT[m.month - 1], in: m.in, out: m.out }));
  return (
    <Section title="In and out by month">
      <div>
        <ChartLegend
          items={[
            { label: "In", color: "var(--chart-1)" },
            { label: "Out", color: "var(--chart-2)" },
          ]}
        />
        <ChartFrame label="In and out by month">
          <BarChart data={data} barGap={2} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
            <CartesianGrid {...GRID} />
            <XAxis {...AXIS} dataKey="month" interval={0} />
            <YAxis {...AXIS} width={48} tickFormatter={shortMoney} />
            <ChartTooltip
              cursor={BAR_CURSOR}
              isAnimationActive={false}
              content={(props) => (
                <ChartTooltipContent active={props.active} payload={props.payload as TooltipProps["payload"]} label={props.label as TooltipProps["label"]} valueFormatter={formatMoney} />
              )}
            />
            <Bar {...BAR} dataKey="in" name="In" fill="var(--chart-1)" />
            <Bar {...BAR} dataKey="out" name="Out" fill="var(--chart-2)" />
          </BarChart>
        </ChartFrame>
      </div>
    </Section>
  );
}

// ── by category ──────────────────────────────────────────────────────

function ByCategory({ read, selected, onPick }: { read: MoneyRead; selected: string | null; onPick: (category: string) => void }) {
  return (
    <ul className="-mx-2 flex flex-col">
      {read.byCategory.map((c) => {
        const on = selected?.toLowerCase() === c.category.toLowerCase();
        return (
          <li key={c.category}>
            <ItemButton
              aria-pressed={on}
              onClick={() => onPick(c.category)}
              className={cn("grid h-8 grid-cols-[minmax(0,12rem)_minmax(0,1fr)_7rem] items-center gap-4 px-2 py-0 text-[13px] hover:bg-muted", on && "bg-muted")}
            >
              <span className="truncate">{c.category}</span>
              <span className="flex h-2 items-center">
                <span className="h-2 rounded-e bg-(--chart-neutral)" style={{ width: `${Math.max(1, Math.round(c.share * 100))}%` }} />
              </span>
              <span className="text-end tabular-nums">{signedMoney(c.amount)}</span>
            </ItemButton>
          </li>
        );
      })}
    </ul>
  );
}

// ── owed ─────────────────────────────────────────────────────────────

function Owed({ env, workspaceId, owed, reload }: { env: string; workspaceId: string; owed: OwedRow[]; reload: () => Promise<void> }) {
  const [paying, setPaying] = useState<string | null>(null);
  const pay = (row: OwedRow) => {
    const key = `${row.row}:${row.way}`;
    setPaying(key);
    withToast(() =>
      markPaid(env, workspaceId, atOf(row))
        .then(() => reload())
        .finally(() => setPaying(null)),
    );
  };
  const groups = [
    { title: "Owed to you", rows: owed.filter((r) => r.way === "toHim") },
    { title: "You owe", rows: owed.filter((r) => r.way === "byHim") },
  ].filter((g) => g.rows.length);
  return (
    <>
      {groups.map((g) => (
        <Section key={g.title} title={g.title}>
          <ul className="flex flex-col">
            {g.rows.map((r) => {
              const key = `${r.row}:${r.way}`;
              return (
                <li key={key} className="grid min-h-8 grid-cols-[minmax(0,1fr)_7rem_5rem_auto] items-center gap-4 border-b border-border text-[13px] last:border-0">
                  <span className="flex min-w-0 items-baseline gap-1">
                    <span className="shrink-0 truncate">{r.who || "Someone"}</span>
                    {r.what ? <span className="min-w-0 truncate text-muted-foreground">{r.what}</span> : null}
                  </span>
                  <span className="text-end tabular-nums">{formatMoney(r.amount)}</span>
                  <span className="text-end text-xs text-muted-foreground tabular-nums">{sinceWords(r.since)}</span>
                  <Button variant="ghost" size="xs" disabled={paying !== null} onClick={() => pay(r)} aria-label={`Paid: ${r.who}`}>
                    <BusyLabel busy={paying === key} label="Paid" />
                  </Button>
                </li>
              );
            })}
          </ul>
        </Section>
      ))}
    </>
  );
}

// ── entries ──────────────────────────────────────────────────────────

function Entries({ env, workspaceId, read, rows }: { env: string; workspaceId: string; read: MoneyRead; rows: LedgerRow[] }) {
  const open = (row: LedgerRow) => set({ dialog: { kind: "row", row } });
  return (
    <Table className="-mx-2 w-[calc(100%+1rem)]">
      <TableHeader>
        <TableRow>
          <TableHead className="w-24 first:pl-2">Date</TableHead>
          <TableHead>Who</TableHead>
          <TableHead className="w-[30%]">Category</TableHead>
          <TableHead className="w-28 text-end">Amount</TableHead>
          <TableHead className="w-10 last:pr-2">
            <span className="sr-only">Receipt</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.row}:${sigOf(row)}`} data-money-row={row.row} className="relative hover:bg-muted">
            <TableCell className="first:pl-2">
              <Button
                variant="link"
                aria-label={`${row.who || "Entry"}, ${rowMoney(row)}${row.date ? `, ${formatDay(row.date)}` : ""}`}
                onClick={() => open(row)}
                className="static h-auto p-0 font-normal text-muted-foreground tabular-nums hover:no-underline after:absolute after:inset-0 after:content-['']"
              >
                {row.date ? formatDay(row.date, false) : ""}
              </Button>
            </TableCell>
            <TableCell className="max-w-0 truncate">{row.who}</TableCell>
            <TableCell className="max-w-0 truncate text-muted-foreground">{row.category}</TableCell>
            <TableCell className="text-end">{rowMoney(row)}</TableCell>
            <TableCell className="last:pr-2 text-end">
              {row.receipt ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Open receipt"
                  className="relative z-10 text-muted-foreground"
                  onClick={() => withToast(() => openReceipt(env, workspaceId, read, row.receipt))}
                >
                  <Paperclip />
                </Button>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── states ───────────────────────────────────────────────────────────

/** A fault the ledger has, in the view's state line's shape, with the one press that mends it. */
function ProblemLine({ word, detail, action, onPress }: { word: string; detail: string; action: string; onPress: () => Promise<unknown> }) {
  const [running, setRunning] = useState(false);
  return (
    <div data-view-state="problem" role="status" className="sticky top-0 z-10 flex min-h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1 text-[13px] leading-5">
      <StatusMark state="failed" word={word} detail={detail} className="min-w-0 flex-1" />
      <Button
        variant="ghost"
        size="xs"
        disabled={running}
        onClick={() => {
          setRunning(true);
          withToast(() => onPress().finally(() => setRunning(false)));
        }}
      >
        <BusyLabel busy={running} label={action} />
      </Button>
    </div>
  );
}

function MoneySkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading money" className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-4 py-4">
      <div className="flex gap-x-8 border-b border-border pb-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col">
            <Skeleton className="my-0.5 h-3 w-8" />
            <Skeleton className="my-0.5 h-5 w-24" />
          </div>
        ))}
      </div>
      <div className="flex flex-col">
        <Skeleton className="mb-3 h-3.5 w-16" />
        {[72, 56, 64, 48, 60, 52].map((w, i) => (
          <div key={i} className="flex h-10 items-center gap-6 border-b border-border last:border-0">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3" style={{ width: `${w / 2}%` }} />
            <Skeleton className="ms-auto h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
