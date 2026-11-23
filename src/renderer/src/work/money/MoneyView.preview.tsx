import { useEffect, useRef, type RefObject } from "react";
import type { MoneyRead, ToConfirm } from "@shared/contract-work-money";
import type { Period } from "@shared/work/money";
import { Receipt } from "../../chrome/icons";
import type { CanvasItem, CanvasKind } from "@shared/work";
import { openMenus } from "../../chrome/menuRows";
import { defineChunk } from "../../lib/lazyChunk";
import { CanvasSeat } from "../canvas/CanvasSeat";
import type { CanvasKindDef } from "../canvas/kind";
import { CANVAS } from "../canvas/registry";
import { applyCanvasPush, resetCanvasStore } from "../canvas/store";
import "./itemVerb";
import { registry, type Link } from "../../lib/connection";
import { Head, View, openMoneyDialog, setMoneyPeriod } from "./MoneyView";
import { ALL_ROWS, EMPTY_READ, NOVEMBER, RECEIPT_SVG, readOf } from "./money.fixtures";

/**
 * The Money view over one fixed host, for `bun run ui:preview
 * src/renderer/src/work/money/MoneyView.preview.tsx#MoneyPreview --props '{"state":"month"}'`:
 * a referee's November (`month`), his year (`year`), money still open
 * (`owed`), a job with no ledger (`empty`), the read on its way (`loading`),
 * a read that failed over the last one (`failed`), a ledger whose headers he
 * changed (`columns`), and the entry dialog open on a row (`dialog`).
 * Made-up data; rendered by nothing in the app.
 */

type State = "empty" | "month" | "year" | "owed" | "loading" | "failed" | "columns" | "dialog" | "confirm" | "drop" | "dialog-picture" | "dialog-trip" | "dialog-export" | "dialog-invoice" | "dialog-rate" | "dialog-request" | "dialog-new" | "menu-add" | "menu-more" | "item-verb";
let state: State = "month";
let reads = 0;

const RECEIPT_B64 = typeof btoa === "function" ? btoa(RECEIPT_SVG) : "";
// A static page cannot reach a blob URL: the one picture this preview serves is shown as data.
if (typeof URL !== "undefined") URL.createObjectURL = () => `data:image/svg+xml;base64,${RECEIPT_B64}`;

const waiting = (id: string, over: Partial<ToConfirm>): ToConfirm => ({ id, state: "ready", source: "drop", name: `${id}.jpg`, picture: true, fields: { amount: null, date: null, who: null, category: null }, at: 1, ...over });
const TO_CONFIRM: ToConfirm[] = [
  waiting("a", { fields: { amount: 4210, date: "2026-11-20", who: "Corner Fuel", category: "Mileage" } }),
  waiting("b", { name: "IMG_2231.jpg", fields: { amount: 2875, date: "2026-11-22", who: null, category: null } }),
  waiting("c", { state: "reading", name: "scan-0112.pdf" }),
];

const CALENDAR = [
  { eventId: "e1", date: "2026-11-21", title: "Varsity at Harrison HS", place: "Harrison HS", fee: 7500, miles: 24, measured: true },
  { eventId: "e2", date: "2026-11-22", title: "JV doubleheader at Millbrook", place: "Millbrook HS", fee: 6500, miles: 38, measured: true },
  { eventId: "e3", date: "2026-11-22", title: "Freshman at Oak Ridge", place: "Oak Ridge MS", fee: null, miles: 41, measured: false },
];

const paid = ALL_ROWS.map((r) => ({ ...r, status: "Paid" as const }));

function answer(period: Period): Promise<MoneyRead> {
  reads++;
  switch (state) {
    case "empty":
      return Promise.resolve(EMPTY_READ(period));
    case "loading":
      return new Promise(() => {});
    case "failed":
      return reads > 1 ? Promise.reject(new Error("The box did not answer in 10 seconds")) : Promise.resolve(readOf(period, paid));
    case "columns":
      return Promise.resolve(readOf(period, paid, { problems: [{ kind: "columns", missing: ["In", "Out"] }] }));
    case "confirm":
    case "dialog-picture":
    case "dialog-trip":
      return Promise.resolve(readOf(period, paid, { toConfirm: TO_CONFIRM, calendar: CALENDAR }));
    case "owed":
    case "dialog":
      return Promise.resolve(readOf(period));
    default:
      return Promise.resolve(readOf(period, paid));
  }
}

const link = {
  environmentId: "box",
  profile: "box",
  connected: true,
  onOpen: () => () => {},
  onClose: () => () => {},
  onPush: () => () => {},
  request<T>(method: string, params: { from: string; to: string }): Promise<T> {
    if (method === "work.money.read") return answer({ from: params.from, to: params.to }) as Promise<T>;
    if (method === "work.money.picture") return Promise.resolve({ mime: "image/svg+xml", name: "receipt.svg", size: RECEIPT_SVG.length, parts: 1, dataBase64: RECEIPT_B64 } as T);
    if (method === "work.money.invoiceNext")
      return Promise.resolve(
        (state === "dialog-request" ? { number: "12", from: null, dueDays: 14 } : { number: "1042", from: { name: "Ridgeline Officiating", address: "12 Elm St, Harlan", pay: "Check" }, dueDays: 30 }) as T,
      );
    if (method === "work.canvas.fetch") return Promise.resolve({ size: RECEIPT_SVG.length } as T);
    if (method === "work.money.state") return Promise.resolve({ host: "box", jobs: [{ workspaceId: "ws", name: "Refereeing", sector: "ref", made: true }] } as T);
    return Promise.reject(new Error(`no ${method}`));
  },
} as unknown as Link;
Object.assign(registry, { primary: () => link, linkOf: () => link, link: () => link });

// A static render has no layout: the chart's container is given the column's width, so recharts draws its bars.
if (typeof HTMLElement !== "undefined") {
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return this.classList.contains("recharts-responsive-container") ? ({ width: 784, height: 200, top: 0, left: 0, right: 784, bottom: 200, x: 0, y: 0, toJSON: () => ({}) } as DOMRect) : rect.call(this);
  };
}

const props = { env: "box", workspace: { id: "ws", environmentId: "box", name: "Refereeing", kind: "work", sector: "ref" } as never, sector: "ref" as const, lifeos: {} as never, startThread: () => {} };
const purdue = { ...props, workspace: { id: "ws", environmentId: "box", name: "Esports", kind: "work", sector: "purdue" } as never, sector: "purdue" as const };

// The menus' own chunk, loaded before the first render, so a menu state can open the real one.
openMenus();

/**
 * A portal (a dialog, a menu) draws outside what a static render keeps: a copy of it is kept in `host` as it
 * settles. A menu's floating position is measured from a layout jsdom does not have, so the copy is set at
 * `place` under its trigger.
 */
function usePortalCopy(host: RefObject<HTMLDivElement | null>, on: boolean, place?: { top: number; right?: number; left?: number }) {
  useEffect(() => {
    const into = host.current;
    if (!on || !into) return;
    const copy = () => {
      into.replaceChildren(...[...document.body.children].filter((el) => !el.contains(into)).map((el) => el.cloneNode(true)));
      const menu = into.querySelector<HTMLElement>("[role=menu]")?.parentElement;
      if (menu && place) menu.setAttribute("style", `position:absolute;top:${place.top}px;${place.left !== undefined ? `left:${place.left}px` : `right:${place.right ?? 0}px`};z-index:50`);
      // Opened by a scripted click, the menu marks its first row as if from the keyboard: a pointer's open marks none.
      for (const row of into.querySelectorAll("[data-highlighted]")) row.removeAttribute("data-highlighted");
    };
    const watch = new MutationObserver((changes) => {
      if (changes.some((c) => !into.contains(c.target))) copy();
    });
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    copy();
    return () => watch.disconnect();
  }, [host, on, place]);
}

/** Presses a header control once the view has painted, as his click would. */
function usePress(selector: string | null) {
  useEffect(() => {
    if (!selector) return;
    const t = setTimeout(() => document.querySelector<HTMLElement>(selector)?.click(), 40);
    return () => clearTimeout(t);
  }, [selector]);
}

const MENU_PLACE = { "menu-add": { top: 44, right: 44 }, "menu-more": { top: 44, right: 8 } } as const;

export function MoneyPreview({ state: s = "month", height }: { state?: State; height?: number }) {
  if (s === "item-verb") return <ItemVerbPreview />;
  return <MoneyFrame s={s} height={height} />;
}

function MoneyFrame({ s, height }: { s: State; height?: number }) {
  const portals = useRef<HTMLDivElement>(null);
  const view = s === "dialog-request" ? purdue : props;
  state = s;
  reads = 0;
  setMoneyPeriod({ span: s === "year" ? "year" : "month", year: 2026, month: 11 });
  if (s === "dialog") openMoneyDialog({ kind: "row", row: NOVEMBER[0] });
  if (s === "dialog-picture") openMoneyDialog({ kind: "confirm", id: "a" });
  if (s === "dialog-trip") openMoneyDialog({ kind: "trip", offer: CALENDAR[2] });
  if (s === "dialog-export") openMoneyDialog({ kind: "export" });
  if (s === "dialog-invoice") openMoneyDialog({ kind: "invoice", as: "invoice" });
  if (s === "dialog-request") openMoneyDialog({ kind: "invoice", as: "request" });
  if (s === "dialog-rate") openMoneyDialog({ kind: "rate" });
  if (s === "dialog-new") openMoneyDialog({ kind: "entry" });
  usePress(s === "menu-add" ? "[data-money-head] [aria-haspopup=menu]:not([aria-label=More])" : s === "menu-more" ? "[data-money-head] [aria-label=More]" : null);
  usePortalCopy(portals, s.startsWith("dialog") || s.startsWith("menu"), s === "menu-add" || s === "menu-more" ? MENU_PLACE[s] : undefined);
  useEffect(() => {
    // The failed state: a second read, asked as the window comes forward, fails over the first.
    if (s !== "failed") return;
    const t = setTimeout(() => window.dispatchEvent(new window.Event("focus")), 30);
    return () => clearTimeout(t);
  }, [s]);
  // The drop state: a file held over the view, as a drag from the desktop keeps saying.
  useEffect(() => {
    if (s !== "drop") return;
    const over = () => {
      const view = document.querySelector("[data-money-view]");
      if (!view) return;
      const event = new window.Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [], dropEffect: "none" } });
      view.dispatchEvent(event);
    };
    over();
    const t = setInterval(over, 100);
    return () => clearInterval(t);
  }, [s]);
  return (
    <div className="relative flex min-h-[560px] w-full flex-col bg-background" style={height || /^(empty|loading|failed)$/.test(s) ? { height: height ?? 560 } : undefined}>
      <div data-money-head className="@container/viewhead flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4 text-[13px]">
        <Receipt className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-foreground">Money</span>
        <span className="flex-1" />
        <Head {...view} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <View {...view} />
      </div>
      {/* A static shot is one frame: the dialog's entry would be caught on its way in. */}
      <style>{"[data-money-shot] *, [data-money-shot] *::before { transition: none !important; }"}</style>
      <div ref={portals} data-money-shot />
    </div>
  );
}

/**
 * `item-verb`: the real canvas pane (CanvasSeat) beside a thread, a mail's PDF open in it, and its More menu
 * open: File as receipt in its place after the pane's own rows and before Close. The PDF's body is a page
 * drawn in place of the PDF kind.
 */
/** Under the item pane's More, its right edge on the button's: the pane takes 70% of the 816px frame. */
const ITEM_MENU_PLACE = { top: 44, left: 232 };

function ItemVerbPreview() {
  const portals = useRef<HTMLDivElement>(null);
  resetCanvasStore();
  const sessionId = "preview-money-item";
  const item: CanvasItem = {
    id: `${sessionId}-pdf`,
    sessionId,
    workspaceId: "ws",
    kind: "pdf" as CanvasKind,
    title: "Corner Fuel receipt.pdf",
    source: { at: "mail", threadId: "m1", messageId: "x1", partId: "2", name: "Corner Fuel receipt.pdf", contentType: "application/pdf" },
    state: "open",
    position: 0,
    rev: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  const body = {
    Body: () => (
      <div className="grid h-full place-items-center bg-(--stage) p-6">
        <img src={`data:image/svg+xml;base64,${RECEIPT_B64}`} alt="" className="h-auto w-[240px] outline-1 -outline-offset-1 outline-(--image-outline)" />
      </div>
    ),
  };
  const chunk = defineChunk("preview-money-item-pdf", () => Promise.resolve(body));
  void chunk.load();
  const kinds: Record<CanvasKind, CanvasKindDef> = { ...CANVAS, pdf: { ...CANVAS.pdf, chunk: chunk as never } };
  applyCanvasPush({ sessionId, items: [item], opened: item.id });
  usePress("[data-money-seat] [data-canvas-tabs] [aria-label=More], [data-money-seat] [aria-label=More]");
  usePortalCopy(portals, true, ITEM_MENU_PLACE);
  return (
    <div data-money-seat className="relative flex h-[560px] w-full overflow-hidden bg-background">
      <CanvasSeat session={{ id: sessionId, environmentId: "box" }} kinds={kinds}>
        <div className="flex min-h-0 flex-1 flex-col justify-end p-4 text-[13px] text-muted-foreground">The thread</div>
      </CanvasSeat>
      <div ref={portals} data-money-shot />
    </div>
  );
}
