import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { receiptSource, type CalendarOffer, type MoneyProblem, type MoneyRead } from "@shared/contract-work-money";
import { loadToast } from "../../components/ui/toaster";
import { formatDay, formatMoney, invoiceTotal, isReceiptName, milesLine, RECEIPT_EXTS, sigOf, today, undatedWords, type LedgerRow, type OwedRow } from "@shared/work/money";
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
import { atOf, heard, markPaid, openBook, openBooks, openReceipt, useMoney, withToast } from "./api";
import { ConfirmFlow } from "./ConfirmFlow";
import { EntryDialog } from "./EntryDialog";
import { CATEGORY_GRID, ENTRIES_TAIL, OWED_GRID } from "./layout";
import { filingToast, receiveFiles, sortFiles } from "./receive";
import { ExportDialog } from "./ExportDialog";
import { InvoiceDialog, invoiceTitle, type InvoiceKind } from "./InvoiceDialog";
import { sendInvoice, sentAs } from "./send";
import { RateDialog } from "./RateDialog";
import { ReceiptPicture, ToConfirmSection } from "./ToConfirm";
import { TripDialog } from "./TripDialog";
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

/**
 * What the header and the body share: the period, the dialog open, and per job what it is known to be.
 * `bare`: true while the job has no money and nothing waits, or its ledger cannot be read as money; false once
 * it is known to have some; absent until the first read lands. `landed`: the view holds a read of its period, so
 * a dialog that draws from it (Entry…, Trip…, Mileage rate…) can open.
 */
const ui = shared<{ period: PeriodState; dialog: MoneyDialog | null; bare: Record<string, boolean>; landed: Record<string, boolean> }>({ period: periodNow(), dialog: null, bare: {}, landed: {} });
const set = (patch: Partial<ReturnType<typeof ui.get>>) => ui.set({ ...ui.get(), ...patch });
/** Each visit opens on this month. */
export const resetMoneyView = () => ui.set({ ...ui.get(), period: periodNow(), dialog: null });
/** Opens a dialog from outside the header (the preview, a later verb). */
export const openMoneyDialog = (dialog: MoneyDialog) => set({ dialog });
/** Puts the view on a period (the preview, the tests). */
export const setMoneyPeriod = (period: PeriodState) => set({ period });

export function Head({ env, workspace, sector }: WorkViewProps) {
  // The period is drawn only once the job is KNOWN to have money or something waiting: never before the first read lands, never on a job with none, never in a columns fault.
  const { period, bare: bareOf, landed: landedOf } = useShared(ui);
  const bare = bareOf[workspace.id] !== false;
  // Until a read of the period has landed (loading, or the first read failed), a dialog that draws from it could not open: its row waits.
  const waiting = landedOf[workspace.id] !== true;
  const unit = period.span;
  const addRows: MenuRow[] = [
    { kind: "item", id: "receipt", label: "Receipt…" },
    { kind: "item", id: "entry", label: "Entry…", disabled: waiting },
    { kind: "item", id: "trip", label: "Trip…", disabled: waiting },
    { kind: "item", id: "invoice", label: "Invoice…" },
    // A purchase request asks Purdue leave to buy: only a Purdue job has one.
    ...(sector === "purdue" ? [{ kind: "item" as const, id: "request", label: "Purchase request…" }] : []),
  ];
  const moreRows: MenuRow[] = [
    { kind: "item", id: "ledger", label: "Open ledger" },
    { kind: "item", id: "mileage", label: "Open mileage log" },
    { kind: "sep" },
    { kind: "item", id: "export", label: "Export…" },
    { kind: "item", id: "rate", label: "Mileage rate…", disabled: waiting },
  ];
  return (
    <>
      {/* A job with no money has no period to step through. */}
      {bare ? null : <ChoiceToggle label="Show" value={unit} options={SPANS} onChange={(span: Span) => set({ period: { ...period, span } })} />}
      {bare ? null : (
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
      )}
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
  // `read` is this period's own answer, or null until it lands: never another period's figures under this label.
  const read = load.read;
  const close = () => set({ dialog: null });
  const root = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const columns = read?.problems.find((p): p is ColumnsProblem => p.kind === "columns") ?? null;
  const bare = read !== null && !columns && isEmpty(read);
  // What the header may draw: known bare (no money, or a columns fault) or known to have money.
  const headBare = read !== null && (bare || columns !== null);
  useEffect(() => {
    if (ui.get().landed[workspace.id] !== (read !== null)) set({ landed: { ...ui.get().landed, [workspace.id]: read !== null } });
  }, [read, workspace.id]);
  useEffect(() => {
    if (read !== null && ui.get().bare[workspace.id] !== headBare) set({ bare: { ...ui.get().bare, [workspace.id]: headBare } });
  }, [headBare, read, workspace.id]);

  // Add → Receipt…: the system's picker, for several at once.
  useEffect(() => {
    if (dialog?.kind !== "pick") return;
    set({ dialog: null });
    picker.current?.click();
  }, [dialog]);

  const receive = (files: File[]) => {
    if (!files.length) return;
    const { taken, left } = sortFiles(files);
    if (left) void loadToast().then((toast) => toast(left));
    if (!taken.length) return;
    void filingToast(taken.length, () => receiveFiles({ env, workspaceId: workspace.id, host: read?.root.host ?? null }, taken), (refused) => refused)
      .then(() => reload())
      .catch(() => {});
  };
  const receiveRef = useRef(receive);
  receiveRef.current = receive;

  // A picture pasted into the view (or with nothing focused) is a receipt; a paste into a field, a grid or an editor anywhere else keeps its meaning.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as Node | null;
      const mine = target === document.body || (target !== null && root.current?.contains(target));
      if (!mine || (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=dialog]"))) return;
      // The paste's whole list goes to the one intake, so a file Money leaves out is said, as for a drop or a pick.
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      receiveRef.current(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // A file dropped anywhere on the view, its 40px header too, is a receipt: the view's region takes the drop before the frame's
  // own handler (which would start a thread with it) hears of it. Outside the frame (a preview, a test) the view's own element.
  useEffect(() => {
    const zone = root.current?.closest<HTMLElement>("[data-file-opens]") ?? root.current;
    if (!zone) return;
    let quiet: ReturnType<typeof setTimeout> | null = null;
    const carries = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onOver = (event: DragEvent) => {
      if (!carries(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setOver(true);
      // A drag that leaves the window says nothing more: a quiet spell ends the wash.
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => setOver(false), 350);
    };
    const onDrop = (event: DragEvent) => {
      if (!carries(event)) return;
      event.preventDefault();
      if (quiet) clearTimeout(quiet);
      setOver(false);
      receiveRef.current(Array.from(event.dataTransfer?.files ?? []));
    };
    zone.addEventListener("dragover", onOver);
    zone.addEventListener("drop", onDrop);
    return () => {
      if (quiet) clearTimeout(quiet);
      zone.removeEventListener("dragover", onOver);
      zone.removeEventListener("drop", onDrop);
    };
  }, []);

  const toConfirm = read ? <ToConfirmSection env={env} workspaceId={workspace.id} read={read} reload={reload} onReview={(id) => set({ dialog: { kind: "confirm", id } })} onReviewOffer={(offer) => set({ dialog: { kind: "trip", offer } })} /> : null;
  let body: ReactNode;
  if (!read) body = load.error ? null : <MoneySkeleton />;
  else if (columns) body = waits(read) ? <Column>{toConfirm}</Column> : null;
  else if (bare) body = <EmptyState title="No money yet" line="Drop a receipt here." action={{ label: "Add entry", onClick: () => set({ dialog: { kind: "entry" } }) }} />;
  else body = <Ledger env={env} workspaceId={workspace.id} read={read} label={periodLabel(period)} year={period.span === "year"} reload={reload} toConfirm={waits(read) ? toConfirm : null} />;

  return (
    <div ref={root} data-money-view className="flex h-full min-h-0 flex-col">
      {load.error ? <ViewStateLine word="Money did not load" detail={load.error} onRetry={reload} /> : null}
      {columns ? (
        columns.twice?.length ? (
          // Two columns of one name: which holds his figures cannot be said, so nothing is read until he renames or removes one.
          <ProblemLine word="The ledger's columns changed" detail={`Two ${columns.twice.join(" and two ")} columns: rename or remove one in the ledger`} action="Open ledger" onPress={() => openBook(env, workspace.id, "ledger")} />
        ) : columns.renamed.length ? (
          // His figures may sit under a header Money does not know: the fix is his, naming it back; Restore would add an empty column beside them.
          <ProblemLine word="The ledger's columns changed" detail={renamedWords(columns.missing, columns.renamed)} action="Open ledger" onPress={() => openBook(env, workspace.id, "ledger")} />
        ) : columns.waits ? (
          // The read says the headers wait as a suggestion in the sheet: the press is where he accepts them, not Restore again. Once he
          // rejects it there, the next read says nothing waits and Restore columns is back.
          <ProblemLine word="The ledger's columns changed" detail="Restored as a suggestion: accept it in the ledger" action="Open ledger" onPress={() => openBook(env, workspace.id, "ledger")} />
        ) : (
          <ProblemLine
            word="The ledger's columns changed"
            detail={missingWords(columns.missing)}
            action="Restore columns"
            // Answered as a suggestion, the next read carries `waits`: the line says so and holds Open ledger; no toast says it twice.
            onPress={() => openBooks(env, workspace.id, true).then(() => reload())}
          />
        )
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {body}
        {over ? (
          <div data-money-wash className="absolute inset-0 z-20 grid place-items-center bg-background/80">
            <span className="rounded-lg bg-background px-3 py-1.5 text-[13px] text-foreground">File as receipt</span>
          </div>
        ) : null}
      </div>
      <input
        ref={picker}
        type="file"
        accept={RECEIPT_ACCEPT}
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
          picture={dialog.row.receipt && isReceiptName(dialog.row.receipt) ? <ReceiptPicture env={env} of={{ workspaceId: workspace.id, receipt: dialog.row.receipt }} name={dialog.row.receipt} /> : undefined}
          footerStart={sentAs(dialog.row.receipt) ? <SendRow env={env} workspaceId={workspace.id} read={read} row={dialog.row} onSent={close} /> : undefined}
          onClose={close}
          onSaved={() => void reload()}
        />
      ) : null}
      {read && dialog?.kind === "trip" ? (
        <TripDialog env={env} workspaceId={workspace.id} offer={dialog.offer} day={today() >= span.from && today() < span.to ? today() : span.from} onClose={close} onSaved={() => void reload()} />
      ) : null}
      {/* Bound to the year it opened for: the read of that period seeds it, and it submits that year. */}
      {read && dialog?.kind === "rate" ? <RateDialog key={read.rate.year} env={env} workspaceId={workspace.id} rate={read.rate} onClose={close} onSaved={() => void reload()} /> : null}
      {dialog?.kind === "invoice" ? (
        <InvoiceDialog
          env={env}
          workspaceId={workspace.id}
          kind={dialog.as}
          onClose={close}
          onCreated={(kept, invoice) => {
            void reload();
            const title = invoiceTitle(invoice.kind, invoice.number);
            // One press, one toast: on a ledger others can open, the created toast carries the row's wait as its second line.
            const waits = !!kept.acted && "suggested" in kept.acted && !!kept.acted.suggested;
            if (kept.acted && "changed" in kept.acted) heard(env, workspace.id, kept.acted);
            const file = kept.source;
            const receipt = kept.receipt ?? `${title}.pdf`;
            void loadToast().then((toast) =>
              toast(`${title} created`, {
                ...(waits ? { description: INVOICE_WAITS } : {}),
                ...(file ? { action: { label: "Send…", onClick: () => sendInvoice(env, workspace.id, file, receipt, invoice.kind, invoice.number, formatMoney(invoiceTotal(invoice.lines))) } } : {}),
              }),
            );
          }}
        />
      ) : null}
      {dialog?.kind === "export" ? <ExportDialog env={env} workspaceId={workspace.id} year={period.year} onClose={close} /> : null}
      {read && dialog?.kind === "confirm" ? <ConfirmFlow env={env} workspaceId={workspace.id} read={read} first={dialog.id} onClose={close} reload={reload} /> : null}
    </div>
  );
}

type ColumnsProblem = Extract<MoneyProblem, { kind: "columns" }>;
type MileageProblem = Extract<MoneyProblem, { kind: "mileage" }>;
type UndatedProblem = Extract<MoneyProblem, { kind: "undated" }>;

/** The mileage log's fault in its place: "The mileage log has no Miles column, so its trips are not counted." */
export function mileageWords(p: MileageProblem): string {
  if (p.reason === "outside") return "The mileage log leads outside this job's folder, so its trips are not counted.";
  if (p.reason === "unreadable") return "The mileage log could not be read, so its trips are not counted.";
  if (p.reason === "twice") return `The mileage log has two ${p.missing.join(" and two ")} columns, so its trips are not counted.`;
  const what = p.missing.length > 1 ? `${p.missing.slice(0, -1).join(", ")} or ${p.missing[p.missing.length - 1]}` : (p.missing[0] ?? "Miles");
  return `The mileage log has no ${what} column, so its trips are not counted.`;
}

/** The created toast's second line when the invoice's row waits as a suggestion. */
export const INVOICE_WAITS = "Its row waits in the ledger for you to accept.";

/** "No Out column: Spent may be it, name it back in the ledger": what is gone, and where his figures likely are, a fragment like its siblings. */
export function renamedWords(missing: readonly string[], renamed: readonly string[]): string {
  const where = renamed.length === 1 ? renamed[0] : `${renamed.slice(0, -1).join(", ")} or ${renamed[renamed.length - 1]}`;
  return `${missingWords(missing)}: ${where} may be it, name it back in the ledger`;
}

/** The picker offers what Money files: the one list, as extensions. */
const RECEIPT_ACCEPT = ["image/*", "application/pdf", ...RECEIPT_EXTS.map((e) => `.${e}`)].join(",");

/** "No In or Out column", "No Date column", "No Date, In or Out column": what the ledger lacks, in its own words. */
export function missingWords(missing: readonly string[]): string {
  if (missing.length <= 1) return `No ${missing[0] ?? "needed"} column`;
  return `No ${missing.slice(0, -1).join(", ")} or ${missing[missing.length - 1]} column`;
}

/** Send… in a row's dialog, for a row whose kept file is an invoice or a purchase request: the job's Mail composer, filled, the PDF to attach from Files. */
function SendRow({ env, workspaceId, read, row, onSent }: { env: string; workspaceId: string; read: MoneyRead; row: LedgerRow; onSent: () => void }) {
  const sent = row.receipt ? sentAs(row.receipt) : null;
  if (!sent) return null;
  return (
    <Button
      variant="ghost"
      className="-ms-2.5"
      onClick={() => {
        sendInvoice(env, workspaceId, receiptSource(read.root, row.receipt), row.receipt, sent.kind, sent.number, formatMoney(row.in || row.out));
        onSent();
      }}
    >
      Send…
    </Button>
  );
}

/** Something waits for his accept: receipts, or the calendar's offers. */
const waits = (read: MoneyRead): boolean => read.toConfirm.length > 0 || read.calendar.length > 0;

/** "No money yet": the job has never had money (`any`: a row or a trip in any period), and nothing waits either (the first drop on a new job is seen). */
export const isEmpty = (read: MoneyRead): boolean => !waits(read) && !read.any;

/** The view's one column, scrolling. */
function Column({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 overflow-x-hidden overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-4 py-4">{children}</div>
    </div>
  );
}

function Ledger({ env, workspaceId, read, label, year, reload, toConfirm }: { env: string; workspaceId: string; read: MoneyRead; label: string; year: boolean; reload: () => Promise<void>; toConfirm: ReactNode }) {
  const [category, setCategory] = useState<string | null>(null);
  // A category of another period does not narrow this one.
  const narrowed = category && read.byCategory.some((c) => c.category.toLowerCase() === category.toLowerCase()) ? category : null;
  const mileage = read.problems.find((p): p is MileageProblem => p.kind === "mileage") ?? null;
  const undated = read.problems.find((p): p is UndatedProblem => p.kind === "undated") ?? null;
  const rows = narrowed ? read.rows.filter((r) => (r.category || "Other").toLowerCase() === narrowed.toLowerCase()) : read.rows;
  return (
    <Column>
      {toConfirm}
      <Figures read={read} />
      {year ? <ByMonth read={read} /> : null}
      {read.byCategory.length ? (
        <Section title="By category">
          <ByCategory read={read} selected={narrowed} onPick={(c) => setCategory(c === narrowed ? null : c)} />
        </Section>
      ) : null}
      {read.owed.length ? <Owed env={env} workspaceId={workspaceId} owed={read.owed} reload={reload} /> : null}
      <Section
        title={narrowed ? `Entries in ${narrowed}` : "Entries"}
        action={
          narrowed ? (
            <Button variant="ghost" size="xs" className="-me-2" onClick={() => setCategory(null)}>
              Clear
            </Button>
          ) : null
        }
      >
        {rows.length ? <Entries env={env} workspaceId={workspaceId} read={read} rows={rows} /> : <p className="text-[13px] text-muted-foreground">Nothing in {label}</p>}
        {undated ? (
          // Money in no month and no year: no sum above counts it, so it is said, with the one press that mends it.
          <p data-money-undated className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-muted-foreground">
            <span>{undatedWords(undated.rows)}</span>
            <Button variant="link" className="h-auto p-0 text-[13px] font-normal text-foreground" onClick={() => withToast(() => openBook(env, workspaceId, "ledger"))}>
              Open ledger
            </Button>
          </p>
        ) : null}
      </Section>
      {mileage ? (
        // The log cannot be read, so its miles are not the truth: one quiet line in the miles line's place, never a zero.
        <Section title="Mileage">
          <p data-mileage-problem className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-muted-foreground">
            <span>{mileageWords(mileage)}</span>
            {mileage.reason !== "outside" ? (
              <Button variant="link" className="h-auto p-0 text-[13px] font-normal text-foreground" onClick={() => withToast(() => openBook(env, workspaceId, "mileage"))}>
                Open mileage log
              </Button>
            ) : null}
          </p>
        </Section>
      ) : read.miles.miles > 0 ? (
        <Section title="Mileage">
          <Facts parts={splitFacts(milesLine(read.miles))} className="text-[13px] text-muted-foreground" />
        </Section>
      ) : null}
    </Column>
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

/**
 * The year's bars: no bar below the axis, so a month whose in or out is below zero (a refund he typed) draws that bar at nothing.
 * The true sums ride beside the bars' (`sums`): the hover says the month's figure as the ledger has it, sign and all.
 */
export const byMonthBars = (months: readonly { month: number; in: number; out: number }[]) =>
  months.map((m) => ({ month: MONTH_SHORT[m.month - 1], in: Math.max(0, m.in), out: Math.max(0, m.out), sums: { in: m.in, out: m.out } }));

/** The hover's rows with each bar's true sum in place of its height ("Out -$20.00" for a month of only a refund). */
export const trueRows = (payload: TooltipProps["payload"]): TooltipProps["payload"] =>
  payload?.map((e) => {
    const sums = (e.payload as { sums?: Record<string, number> } | undefined)?.sums;
    const key = String(e.dataKey ?? "");
    return sums && key in sums ? { ...e, value: sums[key] } : e;
  });

function ByMonth({ read }: { read: MoneyRead }) {
  const data = byMonthBars(read.byMonth);
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
                <ChartTooltipContent active={props.active} payload={trueRows(props.payload as TooltipProps["payload"])} label={props.label as TooltipProps["label"]} valueFormatter={formatMoney} />
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
            <ItemButton aria-pressed={on} onClick={() => onPick(c.category)} className={cn("grid h-8 items-center gap-4 px-2 py-0 text-[13px] hover:bg-muted", CATEGORY_GRID, on && "bg-muted")}>
              <span className="truncate">{c.category}</span>
              <span className="flex h-2 items-center">
                <span className="h-2 rounded-e bg-(--chart-neutral)" style={{ width: `${Math.max(1, Math.round(c.share * 100))}%` }} />
              </span>
              <span className="text-end tabular-nums">{signedMoney(c.amount)}</span>
              <span />
            </ItemButton>
          </li>
        );
      })}
    </ul>
  );
}

// ── owed ─────────────────────────────────────────────────────────────

/**
 * An open row's words. A cost to be paid back leads with what it was for, the seller after it in muted (he paid
 * the diner; the job owes him), or with no For the seller and "to be paid back"; any other, who then what for.
 */
export function owedWords(r: Pick<OwedRow, "who" | "what" | "reimburse">): { lead: string; after: string | null } {
  if (r.reimburse) return r.what ? { lead: r.what, after: r.who || null } : { lead: r.who || "Entry", after: "to be paid back" };
  return { lead: r.who || "Entry", after: r.what || null };
}

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
              const words = owedWords(r);
              return (
                <li key={key} data-owed-row={r.row} className={cn("grid min-h-10 items-center gap-4 border-b border-border text-[13px] last:border-0", OWED_GRID)}>
                  <span className="flex min-w-0 items-baseline gap-1">
                    <span className="max-w-full shrink-0 truncate text-foreground">{words.lead}</span>
                    {words.after ? <span className="min-w-0 truncate text-muted-foreground">{words.after}</span> : null}
                  </span>
                  <span className="text-end text-xs text-muted-foreground tabular-nums">{sinceWords(r.since)}</span>
                  <span className="text-end tabular-nums">{formatMoney(r.amount)}</span>
                  {r.both ? (
                    // One status covers both sides of this row: Paid here would settle the other too, so it is settled in the sheet.
                    <Button variant="ghost" size="sm" className="justify-self-end" onClick={() => withToast(() => openBook(env, workspaceId, "ledger"))} aria-label={`Open ledger: ${words.lead}`}>
                      Open ledger
                    </Button>
                  ) : (
                    <Button variant="ghost" size="sm" className="justify-self-end" disabled={paying !== null} onClick={() => pay(r)} aria-label={`Paid: ${words.lead}`}>
                      <BusyLabel align="end" busy={paying === key} label="Paid" />
                    </Button>
                  )}
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

/**
 * Entries' table and its columns, which the loading bones share so nothing slides when the read lands: a fixed layout, so the
 * columns stand where the header puts them whatever the rows hold. Amount is 112px always: a rare row with money both ways
 * breaks its two figures onto two lines in its own cell, so it grows taller and no row's Who is cut to a letter.
 */
const ENTRIES_TABLE = "-mx-2 w-[calc(100%+1rem)] table-fixed";

function EntriesHead() {
  return (
    <TableHeader>
      <TableRow>
        <TableHead className="w-24 first:pl-2">Date</TableHead>
        <TableHead>Who</TableHead>
        <TableHead className="w-[26%]">Category</TableHead>
        <TableHead className="w-28 text-end">Amount</TableHead>
        <TableHead className={cn("last:pr-2", ENTRIES_TAIL)}>
          <span className="sr-only">Receipt</span>
        </TableHead>
      </TableRow>
    </TableHeader>
  );
}

function Entries({ env, workspaceId, read, rows }: { env: string; workspaceId: string; read: MoneyRead; rows: LedgerRow[] }) {
  const open = (row: LedgerRow) => set({ dialog: { kind: "row", row } });
  return (
    <Table className={ENTRIES_TABLE}>
      <EntriesHead />
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.row}:${sigOf(row)}`} data-money-row={row.row} className="relative focus-within:bg-muted hover:bg-muted">
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
            <TableCell className={cn("text-end", row.in && row.out ? "whitespace-normal" : null)}>
              {/* One form for every row, the dialog's: a row with money both ways reads "+$30.00 and $20.00", on two lines where it must. */}
              {rowMoney(row)}
            </TableCell>
            <TableCell className="last:pr-2 text-end">
              {row.receipt ? (
                <Button variant="ghost" size="icon-xs" aria-label="Open receipt" className="relative z-10 text-muted-foreground" onClick={() => withToast(() => openReceipt(env, workspaceId, read, row.receipt))}>
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

/** The figures' labels over bones, then Entries' heading and own table with a bone in each cell (only what the read fills is a bone): the amount ends on money's one edge (layout.ts), and nothing moves as the read lands. */
function MoneySkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading money" className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-4 py-4">
      <div className="flex gap-x-8 border-b border-border pb-4">
        {["In", "Out", "Net"].map((label) => (
          <div key={label} className="flex flex-col">
            <span className="text-xs text-muted-foreground">{label}</span>
            <Skeleton className="my-0.5 h-5 w-24" />
          </div>
        ))}
      </div>
      <section className="flex flex-col gap-2">
        <div className="flex min-h-6 items-center">
          <h2 className="text-[13px] font-semibold text-foreground">Entries</h2>
        </div>
        <Table className={ENTRIES_TABLE}>
          <EntriesHead />
          <TableBody>
            {[72, 56, 64, 48, 60, 52].map((w, i) => (
              <TableRow key={i} data-money-bone>
                <TableCell className="first:pl-2">
                  <Skeleton className="h-3 w-12" />
                </TableCell>
                <TableCell className="max-w-0">
                  <Skeleton className="h-3" style={{ width: `${w}%` }} />
                </TableCell>
                <TableCell className="max-w-0">
                  <Skeleton className="h-3" style={{ width: `${w - 12}%` }} />
                </TableCell>
                <TableCell>
                  <Skeleton className="ms-auto h-3 w-16" />
                </TableCell>
                <TableCell className="last:pr-2" />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
