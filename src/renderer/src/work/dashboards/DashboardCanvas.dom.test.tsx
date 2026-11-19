// @vitest-environment jsdom
/**
 * The dashboard kind in the real canvas pane, with a host that keeps one
 * page's view: figures on one row, the chart, a flat table, "as of" once in
 * the bar, a figure opening where it came from, a proposed block stepped
 * from the bar, the stale page, an empty one and a read that failed.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardView, DashFrom } from "@shared/contract-work-dashboards";
import type { CanvasItem } from "@shared/work";
import { openMenus } from "../../chrome/menuRows";
import { defineChunk } from "../../lib/lazyChunk";
import { CANVAS } from "../canvas/registry";
import { canvasItem, fakeHost } from "../canvas/testkit";
import type { CanvasBodyProps, CanvasKindDef } from "../canvas/kind";
import type { DashHost } from "./host";
import { axis, isTimeSeries } from "./DashboardCanvas";

const host = vi.hoisted(() => ({
  current: null as ReturnType<typeof import("../canvas/testkit").fakeHost> | null,
  pushes: new Set<(push: never) => void>(),
  opens: new Set<() => void>(),
}));
vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "local",
    connected: true,
    request: (method: string, params?: Record<string, unknown>) => host.current!.link.request(method, params),
    onPush: (listener: (push: never) => void) => (host.pushes.add(listener), () => host.pushes.delete(listener)),
    onOpen: (listener: () => void) => (host.opens.add(listener), () => host.opens.delete(listener)),
    onClose: () => () => undefined,
  };
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf: () => link, onLink: (listener: (l: typeof link, event: string) => void) => (listener(link, "added"), () => undefined) } };
});
import { CanvasSeat } from "../canvas/CanvasSeat";
import { resetCanvasStore } from "../canvas/store";

const SHEET = { at: "lifeos", table: "sheets", id: "s1" } as const;
const from = (range: string, counts: string): DashFrom => ({ sheet: SHEET, sheetTitle: "Invoices 2026", range, counts });

function page(over: Partial<DashboardView> = {}): DashboardView {
  return {
    itemId: "",
    rev: 1,
    title: "Unify receivables",
    asOf: new Date(2026, 10, 19, 7, 4).getTime(),
    stale: false,
    failed: null,
    blocks: [
      {
        id: "b1",
        kind: "figures",
        figures: [
          { id: "f1", label: "Outstanding", sub: "4 invoices", format: "money", from: { ...from("Invoices!E2:E48", "Amount, summed where Status is not Paid"), agg: "sum" }, value: "$7,420" },
          { id: "f2", label: "Overdue", sub: "$6,170", format: "number", from: { ...from("Invoices!F2:F48", "Invoices whose Status is Overdue"), agg: "count" }, value: "3" },
          { id: "f3", label: "Balance", format: "text", from: { service: "Stripe", counts: "Balance on the account" }, value: "$2,180" },
        ],
      },
      { id: "b2", kind: "chart", title: "Paid by month", format: "money", from: { ...from("Invoices!B2:B7", "Paid each month"), labels: "Invoices!A2:A7" }, bars: [{ label: "Oct", value: 10400 }, { label: "Nov", value: 12300 }] },
      { id: "b3", kind: "table", title: "Overdue invoices", from: from("Invoices!A1:C4", "Overdue invoices"), head: ["Invoice", "Client", "Amount"], rows: [["1042", "Rivera Dental", "1,850"]], numeric: [false, false, true] },
    ],
    ...over,
  };
}

function fakeDashHost(start: DashboardView) {
  let v = start;
  return {
    open: vi.fn(async () => v),
    refresh: vi.fn(async () => (v = { ...v, stale: false, asOf: v.asOf! + 60_000 })),
    review: vi.fn(async (which: { ids: string[] } | "all", verdict: "accept" | "reject") => {
      v = { ...v, blocks: v.blocks.flatMap((b) => (b.proposed && (which === "all" || which.ids.includes(b.id)) ? (verdict === "accept" ? [{ ...b, proposed: undefined }] : []) : [b])) };
      return v;
    }),
    openSheet: vi.fn(async () => undefined),
    watch: () => () => undefined,
  } satisfies DashHost;
}

let dashHost: ReturnType<typeof fakeDashHost>;
let item: CanvasItem;
let n = 0;
function kinds(): Record<string, CanvasKindDef> {
  const module = import("./DashboardCanvas").then((m) => ({
    Body: (props: CanvasBodyProps) => <m.Body {...(props as CanvasBodyProps<undefined>)} host={dashHost} />,
    Bar: (props: CanvasBodyProps) => <m.Bar {...(props as CanvasBodyProps<undefined>)} host={dashHost} />,
  }));
  return { ...CANVAS, dashboard: { ...CANVAS.dashboard, chunk: defineChunk(`test-dash-${Math.random()}`, () => module) } };
}
function open(start: DashboardView) {
  item = canvasItem(`dash${++n}`, { kind: "dashboard", title: "Unify receivables", source: { at: "thread" } });
  dashHost = fakeDashHost({ ...start, itemId: item.id });
  host.current = fakeHost([item], host as never);
  return render(
    <CanvasSeat session={{ id: "t1", environmentId: "local" }} kinds={kinds() as never}>
      <div />
    </CanvasSeat>,
  );
}
const found = (selector: string): Promise<HTMLElement> =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(selector);
    expect(el).not.toBeNull();
    return el!;
  });

beforeEach(async () => {
  Element.prototype.scrollIntoView ??= () => undefined;
  localStorage.clear();
  resetCanvasStore();
  await new Promise<void>((done) => openMenus(done));
});
afterEach(cleanup);

describe("the dashboard kind", () => {
  it("reads as a page: figures on one row, one chart, a flat table, and as of said once in the bar", async () => {
    open(page());
    const body = await found("[data-dashboard]");
    expect([...body.querySelectorAll("[data-figure]")].map((f) => f.textContent)).toEqual(["Outstanding$7,4204 invoices", "Overdue3$6,170", "Balance$2,180"]);
    expect(screen.getByRole("img", { name: "Paid by month: Oct $10.4K, Nov $12.3K" })).toBeTruthy();
    expect(body.querySelector("table")?.textContent).toContain("Rivera Dental");
    const asOf = await found("[data-dash-asof]");
    expect(asOf.textContent).toMatch(/^As of /);
    expect(document.body.textContent?.match(/As of/g)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(dashHost.refresh).toHaveBeenCalledTimes(1));
  });

  it("opens a figure's source: the sheet, the range, what it counts, and the way to it", async () => {
    open(page());
    await found("[data-dashboard]");
    fireEvent.click(screen.getByRole("button", { name: "Outstanding: $7,420. Where it comes from" }));
    const source = await found("[data-figure-source]");
    expect(source.textContent).toContain("Invoices 2026");
    expect(source.textContent).toContain("Invoices!E2:E48");
    expect(source.textContent).toContain("Amount, summed where Status is not Paid");
    fireEvent.click(screen.getByRole("button", { name: "Open in the sheet" }));
    await waitFor(() => expect(dashHost.openSheet).toHaveBeenCalledWith(SHEET, "Invoices 2026"));
  });

  it("holds a proposed block for his Accept, stepped from the bar where as of would be", async () => {
    const base = page();
    open({ ...base, blocks: [...base.blocks, { id: "b4", kind: "text", text: "Rivera Dental pays slowest.", proposed: { by: "agent:env:t1", at: 1 } }] });
    const block = await found('[data-block="b4"]');
    expect(block.className).toContain("bg-(--add-bg)");
    await waitFor(() => expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy());
    expect(document.querySelector("[data-dash-asof]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(dashHost.review).toHaveBeenCalledWith({ ids: ["b4"] }, "accept"));
    await found("[data-dash-asof]");
  });

  it("dims the page when a sheet moved, says a failed read once, and asks for a number when empty", async () => {
    open(page({ stale: true }));
    const body = await found("[data-dashboard]");
    expect(body.getAttribute("data-stale")).toBe("true");
    expect(body.querySelector(".bg-\\(--chart-neutral-stale\\)")).not.toBeNull();
    expect(body.querySelector("[data-figure] button span")?.className).toContain("text-muted-foreground");
    cleanup();
    open(page({ failed: "Invoices!Z9 is not a range" }));
    await waitFor(() => expect(screen.getByText("Couldn't read the figures")).toBeTruthy());
    cleanup();
    open(page({ blocks: [], asOf: null }));
    await waitFor(() => expect(screen.getByText("Ask for a number")).toBeTruthy());
  });

  it("stresses the current bar only on a run of periods", async () => {
    const base = page();
    const chart = { ...base.blocks[1], bars: [{ label: "Valorant", value: 4 }, { label: "Marvel Rivals", value: 0 }] } as (typeof base.blocks)[number];
    open({ ...base, blocks: [base.blocks[0], chart] });
    const body = await found("[data-dashboard]");
    expect(body.querySelector('[data-bar="now"]')).toBeNull();
    cleanup();
    open(page());
    const months = await found("[data-dashboard]");
    expect(months.querySelectorAll('[data-bar="now"]')).toHaveLength(1);
  });

  it("says a page out of date in the bar, before its as of", async () => {
    open(page({ stale: true }));
    const asOf = await found("[data-dash-asof]");
    expect(asOf.textContent).toMatch(/^Out of dateAs of /);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(document.querySelector("[data-dash-asof]")?.textContent).toMatch(/^As of /));
  });

  it("holds a bone in the bar while the page loads, and says a failed open on the state line with Retry", async () => {
    open(page());
    let fail: (e: Error) => void = () => undefined;
    dashHost.open.mockImplementationOnce(() => new Promise((_, no) => (fail = no)));
    await found("[data-dash-bar-bone]");
    expect(document.querySelector("[data-dashboard-loading]")).not.toBeNull();
    await waitFor(() => expect(dashHost.open).toHaveBeenCalled());
    fail(new Error("The sheet is gone"));
    await waitFor(() => expect(screen.getByText("Couldn't open this dashboard")).toBeTruthy());
    expect(document.querySelector("[data-dashboard-loading]")).toBeNull();
    expect(document.querySelector("[data-dash-bar-bone]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await found("[data-dashboard]");
    expect(screen.queryByText("Couldn't open this dashboard")).toBeNull();
  });
});

describe("the chart's axis", () => {
  it("steps in three round steps whose top clears the largest bar, whole steps for whole numbers", () => {
    expect(axis(12300, true)).toEqual({ step: 5000, top: 15000 });
    expect(axis(9800, true)).toEqual({ step: 5000, top: 15000 });
    expect(axis(5, true)).toEqual({ step: 2, top: 6 });
    expect(axis(3, true)).toEqual({ step: 1, top: 3 });
    expect(axis(2, true)).toEqual({ step: 1, top: 3 });
    expect(axis(0.6, false).step).toBeCloseTo(0.2);
    expect(axis(0, true)).toEqual({ step: 1, top: 3 });
  });

  it("knows a run of periods from categories", () => {
    expect(isTimeSeries(["Oct", "Nov"])).toBe(true);
    expect(isTimeSeries(["June", "July", "August"])).toBe(true);
    expect(isTimeSeries(["Q1 2026", "Q2 2026"])).toBe(true);
    expect(isTimeSeries(["2025", "2026"])).toBe(true);
    expect(isTimeSeries(["2026-10", "2026-11"])).toBe(true);
    expect(isTimeSeries(["Valorant", "Marvel Rivals"])).toBe(false);
    expect(isTimeSeries(["Nov"])).toBe(false);
  });
});
