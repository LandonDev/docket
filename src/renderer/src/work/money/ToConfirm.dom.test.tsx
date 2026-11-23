// @vitest-environment jsdom
/**
 * Receipts in: a file dropped on the view goes to the host under one key in
 * parts, and the frame's own drop (which would start a thread with it) never
 * acts; a 5 MB file goes in three parts; Review opens what was read beside
 * its picture, and Save files it and shows the next in the same dialog;
 * Discard drops one; a receipt still being read offers no Review.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoneyRead, ToConfirm } from "@shared/contract-work-money";
import type { Period } from "@shared/work/money";

const host: { asked: { method: string; params: Record<string, unknown> }[]; read: (p: Period) => MoneyRead; answer: (method: string, params: Record<string, unknown>) => unknown } = {
  asked: [],
  read: () => {
    throw new Error("unset");
  },
  answer: () => null,
};
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    primary: () => ({ environmentId: "mac" }),
    linkOf: () => ({
      onPush: () => () => {},
      request: async (method: string, params: Record<string, unknown>) => {
        host.asked.push({ method, params });
        if (method === "work.money.read") return host.read({ from: params.from as string, to: params.to as string });
        return host.answer(method, params);
      },
    }),
  },
}));
const toast = Object.assign(vi.fn(), { error: vi.fn() });
vi.mock("../../components/ui/toaster", async (original) => ({ ...(await original<object>()), loadToast: async () => toast }));
const opened = vi.fn();
vi.mock("../canvas/openOutside", () => ({ openOutside: opened, outsideOf: (f: File) => f, pickAndOpen: vi.fn() }));

const { Head, View, setMoneyPeriod } = await import("./MoneyView");
const { FileDrops } = await import("../canvas/fileDrop");
const { receiveFile } = await import("./receive");
const { readOf } = await import("./money.fixtures");
const { MONEY_PART_BYTES } = await import("@shared/contract-work-money");

const props = { env: "box", workspace: { id: "ws", environmentId: "box", name: "Refereeing", kind: "work", sector: "ref" }, sector: "ref", lifeos: {}, startThread: () => {} } as never;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const asked = (method: string) => host.asked.filter((a) => a.method === method).map((a) => a.params);
const waiting = (id: string, over: Partial<ToConfirm> = {}): ToConfirm => ({ id, state: "ready", source: "drop", name: `${id}.jpg`, picture: true, fields: { amount: null, date: null, who: null, category: null }, at: 1, ...over });

beforeEach(() => {
  host.asked.length = 0;
  host.read = (p) => readOf(p);
  host.answer = (method, params) => {
    if (method === "work.money.receive") return { id: "w1", state: params.part === undefined || params.part === (params.parts as number) - 1 ? "reading" : "partial" };
    if (method === "work.money.accept") return { ok: true, ref: "r", row: 40 };
    if (method === "work.money.state") return { host: "box", jobs: [{ workspaceId: "ws", name: "Refereeing", sector: "ref", made: true }] };
    if (method === "work.money.picture") return { mime: "image/png", name: "x.png", size: 3, parts: 1, dataBase64: "AAAA" };
    return null;
  };
  toast.mockClear();
  opened.mockClear();
  setMoneyPeriod({ span: "month", year: 2026, month: 11 });
  URL.createObjectURL ??= () => "blob:x";
  URL.revokeObjectURL ??= () => {};
});
afterEach(cleanup);

describe("receipts in", () => {
  it("takes a dropped file itself, under one key, and the frame's drop never opens it", async () => {
    render(
      <>
        <FileDrops look={{ meta: () => null, draft: () => null, provisional: () => false } as never} />
        <div data-file-opens>
          <View {...props} />
        </div>
      </>,
    );
    await settle();
    const file = new File([new Uint8Array(10)], "fuel.jpg", { type: "image/jpeg" });
    const view = document.querySelector("[data-money-view]")!;
    fireEvent.dragOver(view, { dataTransfer: { types: ["Files"], files: [file], dropEffect: "none" } });
    expect(screen.getByText("File as receipt")).toBeTruthy();
    fireEvent.drop(view, { dataTransfer: { types: ["Files"], files: [file] } });
    await settle();
    await settle();
    expect(screen.queryByText("File as receipt")).toBeNull();
    const sent = asked("work.money.receive");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ workspaceId: "ws", name: "fuel.jpg", mime: "image/jpeg", part: 0, parts: 1, source: "drop" });
    expect(String(sent[0].key).length).toBeGreaterThanOrEqual(8);
    expect(opened).not.toHaveBeenCalled();
  });

  it("sends a 5 MB file in three parts under one key", async () => {
    const big = new Blob([new Uint8Array(5_000_000)], { type: "application/pdf" });
    await receiveFile({ env: "box", workspaceId: "ws", host: "box" }, big, "statement.pdf");
    const sent = asked("work.money.receive");
    expect(sent.map((s) => [s.part, s.parts])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    expect(new Set(sent.map((s) => s.key)).size).toBe(1);
    const sizes = sent.map((s) => atob(s.dataBase64 as string).length);
    expect(sizes).toEqual([MONEY_PART_BYTES, MONEY_PART_BYTES, 5_000_000 - 2 * MONEY_PART_BYTES]);
  });

  it("opens what was read on Review, files it on Save and shows the next in the same dialog", async () => {
    host.read = (p) =>
      readOf(p, undefined, {
        toConfirm: [
          waiting("a", { fields: { amount: 4210, date: "2026-11-20", who: "Corner Fuel", category: "Mileage" } }),
          waiting("b", { fields: { amount: 8995, date: null, who: null, category: null }, name: "scan.pdf" }),
          waiting("c", { state: "reading", name: "late.jpg" }),
        ],
      });
    render(
      <>
        <Head {...props} />
        <View {...props} />
      </>,
    );
    await settle();
    const list = within(screen.getByRole("region", { name: "To confirm" }));
    expect(list.getAllByRole("button", { name: /^Review/ })).toHaveLength(2);
    expect(list.getByText("Reading")).toBeTruthy();
    fireEvent.click(list.getByRole("button", { name: "Review Corner Fuel" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm receipt" });
    const amount = within(dialog).getByLabelText("Amount") as HTMLInputElement;
    expect(amount.value).toBe("42.10");
    expect((within(dialog).getByLabelText("Date") as HTMLInputElement).value).toBe("2026-11-20");
    expect((within(dialog).getByLabelText("Who") as HTMLInputElement).value).toBe("Corner Fuel");
    expect(within(dialog).queryByLabelText("Job")).toBeNull();
    // The picture at its own height in its column, 420px at most, scrolling inside it when taller.
    await waitFor(() => expect(dialog.querySelector("[data-receipt-picture]")).toBeTruthy());
    const picture = dialog.querySelector("[data-receipt-picture]")!;
    expect(picture.className).toContain("max-h-[420px]");
    expect(picture.className).toContain("overflow-y-auto");
    fireEvent.keyDown(amount, { key: "Enter" });
    await settle();
    expect(asked("work.money.accept")).toEqual([{ id: "a", fields: expect.objectContaining({ amount: 4210, date: "2026-11-20", who: "Corner Fuel", category: "Mileage", way: "out" }) }]);
    // The same dialog, the next receipt: what was not read is empty, and no error says so.
    const still = screen.getByRole("dialog", { name: "Confirm receipt" });
    expect(still).toBe(dialog);
    await waitFor(() => expect((within(still).getByLabelText("Amount") as HTMLInputElement).value).toBe("89.95"));
    expect((within(still).getByLabelText("Date") as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(within(still).getByLabelText("Amount"));
    expect(still.querySelector(".text-destructive")).toBeNull();
    // Nothing read, no date: Save waits for him.
    expect((within(still).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("drops a receipt from its row's menu, and says what went", async () => {
    host.read = (p) => readOf(p, undefined, { toConfirm: [waiting("a", { fields: { amount: 4210, date: null, who: "Corner Fuel", category: null } })] });
    render(<View {...props} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "More for Corner Fuel" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Discard" }));
    await settle();
    expect(asked("work.money.drop")).toEqual([{ id: "a" }]);
    expect(toast).toHaveBeenCalledWith("Discarded Corner Fuel");
  });

  it("offers no Review on a receipt still being read", async () => {
    host.read = (p) => readOf(p, undefined, { toConfirm: [waiting("c", { state: "reading", name: "late.jpg" })] });
    render(<View {...props} />);
    await settle();
    const list = within(screen.getByRole("region", { name: "To confirm" }));
    expect(list.getByText("Reading")).toBeTruthy();
    expect(list.queryByRole("button", { name: /^Review/ })).toBeNull();
  });
});
