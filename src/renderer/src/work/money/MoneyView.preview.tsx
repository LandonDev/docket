import { useEffect, useRef } from "react";
import type { MoneyRead, ToConfirm } from "@shared/contract-work-money";
import type { Period } from "@shared/work/money";
import { Receipt } from "../../chrome/icons";
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

type State = "empty" | "month" | "year" | "owed" | "loading" | "failed" | "columns" | "dialog" | "confirm" | "drop" | "dialog-picture";
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
      return Promise.resolve(readOf(period, paid, { toConfirm: TO_CONFIRM }));
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

export function MoneyPreview({ state: s = "month", height }: { state?: State; height?: number }) {
  const portals = useRef<HTMLDivElement>(null);
  state = s;
  reads = 0;
  setMoneyPeriod({ span: s === "year" ? "year" : "month", year: 2026, month: 11 });
  if (s === "dialog") openMoneyDialog({ kind: "row", row: NOVEMBER[0] });
  if (s === "dialog-picture") openMoneyDialog({ kind: "confirm", id: "a" });
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
  // A dialog draws in a portal, outside what a static render keeps: a copy of it is kept in here as it settles.
  useEffect(() => {
    const host = portals.current;
    if (!s.startsWith("dialog") || !host) return;
    const copy = () => host.replaceChildren(...[...document.body.children].filter((el) => !el.contains(host)).map((el) => el.cloneNode(true)));
    const watch = new MutationObserver((changes) => {
      if (changes.some((c) => !host.contains(c.target))) copy();
    });
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    copy();
    return () => watch.disconnect();
  }, [s]);
  return (
    <div className="relative flex min-h-[560px] w-full flex-col bg-background" style={height || /^(empty|loading|failed)$/.test(s) ? { height: height ?? 560 } : undefined}>
      <div className="@container/viewhead flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4 text-[13px]">
        <Receipt className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-foreground">Money</span>
        <span className="flex-1" />
        <Head {...props} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <View {...props} />
      </div>
      {/* A static shot is one frame: the dialog's entry would be caught on its way in. */}
      <style>{"[data-money-shot] *, [data-money-shot] *::before { transition: none !important; }"}</style>
      <div ref={portals} data-money-shot />
    </div>
  );
}
