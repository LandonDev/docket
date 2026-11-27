// @vitest-environment jsdom
/**
 * Invoices and purchase requests: the number and due date come from the
 * host's next, the lines add up, his details are asked whole the first time
 * and are one line with Edit after, a request has its own words, Create is
 * three calls in order and nothing else (nothing is sent), and Send… fills
 * Mail's composer and opens the PDF in Files without sending.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, today } from "@shared/work/money";

const host: { asked: { method: string; params: Record<string, unknown> }[]; answer: (method: string, params: Record<string, unknown>) => unknown } = { asked: [], answer: () => null };
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    primary: () => ({ environmentId: "mac" }),
    linkOf: () => ({
      onPush: () => () => {},
      onOpen: () => () => {},
      request: async (method: string, params: Record<string, unknown>) => {
        host.asked.push({ method, params });
        return host.answer(method, params);
      },
    }),
  },
}));
const written: unknown[] = [];
vi.mock("../mail/mailto", () => ({ writeMail: (draft: unknown) => written.push(draft) }));
const toast = Object.assign(vi.fn(), { error: vi.fn(), loading: vi.fn(() => "t"), dismiss: vi.fn() });
vi.mock("../../components/ui/toaster", async (original) => ({ ...(await original<object>()), loadToast: async () => toast }));
const opened = vi.fn();
vi.mock("../../lib/workSwitch", async (original) => ({ ...(await original<object>()), openWorkView: opened }));

// The dialog's rules by the date field's value; the field itself is proven in components/ui and work/dateField.dom.test.tsx.
vi.mock("../../components/ui/date-field", async () => ({ DateField: (await import("../../work/testDateField")).DateFieldStandIn }));
const { InvoiceDialog } = await import("./InvoiceDialog");
const { sendInvoice, sentAs } = await import("./send");

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const FROM = { name: "Ridgeline Officiating", address: "12 Elm St\nHarlan", pay: "Check to Ridgeline Officiating" };
const kept = { source: { at: "file", host: "box", path: "/home/ref/Refereeing/Money/Invoices/Invoice 1042 Harlan Valley.pdf" }, receipt: "Invoices/Invoice 1042 Harlan Valley.pdf" };

let from: typeof FROM | null = FROM;
beforeEach(() => {
  host.asked.length = 0;
  written.length = 0;
  from = FROM;
  host.answer = (method) => {
    if (method === "work.money.invoiceNext") return { number: "1042", from, dueDays: 30 };
    if (method === "work.money.invoice") return { name: "Invoice 1042 Harlan Valley.pdf", html: "<h1>Invoice 1042</h1>" };
    if (method === "work.formats.print") return { name: "Invoice 1042 Harlan Valley.pdf", data: btoa("%PDF made up"), warnings: [] };
    if (method === "work.money.keep") return kept;
    return null;
  };
});
afterEach(cleanup);

async function open(kind: "invoice" | "request" = "invoice") {
  const onCreated = vi.fn();
  render(<InvoiceDialog env="box" workspaceId="ws" kind={kind} onClose={() => {}} onCreated={onCreated} />);
  await settle();
  return { dialog: screen.getByRole("dialog"), onCreated };
}

describe("an invoice", () => {
  it("while its number is asked draws its own form from a sample, unseen and inert", async () => {
    host.answer = (method) => (method === "work.money.invoiceNext" ? new Promise(() => {}) : null);
    const { dialog } = await open();
    const drawing = dialog.querySelector("[data-region][data-bones] [skullet-loading]")!;
    expect(drawing.getAttribute("aria-hidden")).toBe("true");
    expect((drawing.querySelector("[data-invoice-line] input") as HTMLInputElement).value).toBe("Varsity games");
    // No field of the sample's takes the caret, and none is his to type in.
    expect(drawing.contains(document.activeElement)).toBe(false);
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(dialog.querySelector("[data-slot=skeleton]")).toBeNull();
  });

  it("is no longer marked loading once the number lookup failed: it says why", async () => {
    host.answer = (method) => {
      if (method === "work.money.invoiceNext") throw new Error("The ledger's columns changed.");
      return null;
    };
    const { dialog } = await open();
    expect(dialog.querySelector('[aria-busy="true"]')).toBeNull();
    expect(within(dialog).queryByLabelText("Loading")).toBeNull();
    expect(dialog.textContent).toContain("The ledger's columns changed.");
  });

  it("takes its number and due date from the host's next, and adds up its lines", async () => {
    const { dialog } = await open();
    expect(host.asked[0]).toEqual({ method: "work.money.invoiceNext", params: { workspaceId: "ws", kind: "invoice" } });
    expect((within(dialog).getByLabelText("Number") as HTMLInputElement).value).toBe("1042");
    expect((within(dialog).getByLabelText("Due") as HTMLInputElement).value).toBe(addDays(today(), 30));
    fireEvent.change(within(dialog).getByLabelText("What, line 1"), { target: { value: "Varsity games" } });
    fireEvent.change(within(dialog).getByLabelText("Quantity, line 1"), { target: { value: "3" } });
    fireEvent.change(within(dialog).getByLabelText("Rate, line 1"), { target: { value: "75" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add line" }));
    fireEvent.change(within(dialog).getByLabelText("What, line 2"), { target: { value: "Mileage" } });
    fireEvent.change(within(dialog).getByLabelText("Rate, line 2"), { target: { value: "16.80" } });
    expect(dialog.querySelector("[data-invoice-total]")!.textContent).toBe("$241.80");
    expect(within(dialog).queryByRole("button", { name: "Remove line 1" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove line 2" }));
    expect(dialog.querySelector("[data-invoice-total]")!.textContent).toBe("$225.00");
  });

  /**
   * Council round 1, sitting E (R1-E6): under 30rem What printed over Quantity and its field shrank to nothing. Rounds 2
   * and 3: the numbers' labels must stand over their own fields, the dates read whole, and Tab meet the fields in the
   * order they stand. So under 30rem the shared head goes, What takes its own row first (named by its placeholder), the
   * first line's numbers carry their own labels, and Number, Date and Due take a row each.
   */
  it("in a narrow dialog labels each field where it stands, in Tab's order (its own container rule)", async () => {
    const { dialog } = await open();
    const body = dialog.querySelector(".\\@container\\/invoice")!;
    expect(body).toBeTruthy();
    const line = dialog.querySelector('[data-invoice-line="0"]')!;
    expect(line.className).toContain("@max-[30rem]/invoice:grid-cols-[64px_minmax(0,1fr)_88px_28px]");
    const what = within(dialog).getByLabelText("What, line 1");
    expect(what.className).toContain("@max-[30rem]/invoice:col-span-full");
    expect(what.className).not.toContain("order-last");
    // What comes first in the line, as Tab meets it
    const fields = [...line.querySelectorAll("input")].map((el) => el.getAttribute("aria-label"));
    expect(fields).toEqual(["What, line 1", "Quantity, line 1", "Rate, line 1"]);
    // its name shows as the placeholder only where the head has gone
    expect(what.getAttribute("placeholder")).toBe("What");
    expect(what.className).toContain("placeholder:text-transparent");
    expect(what.className).toContain("@max-[30rem]/invoice:placeholder:text-muted-foreground");
    expect(within(body as HTMLElement).getAllByText("What")[0]!.parentElement!.className).toContain("@max-[30rem]/invoice:hidden");
    // the first line's own labels, narrow only; a later line has none
    for (const name of ["Quantity", "Rate", "Amount"]) {
      const own = [...line.querySelectorAll("span")].filter((el) => el.textContent === name).pop()!;
      expect(own.className).toContain("hidden");
      expect(own.className).toContain("@max-[30rem]/invoice:block");
    }
    // Council round 4, sitting E (Sol): an empty Amount had no height, so its label sat lower than Quantity's and Rate's.
    const amount = [...line.querySelectorAll("span")].filter((el) => el.textContent === "Amount").pop()!.nextElementSibling!;
    expect(amount.textContent).toBe("");
    expect(amount.className).toContain("@max-[30rem]/invoice:min-h-8");
    expect(within(dialog).getByLabelText("Number").closest(".\\@max-\\[30rem\\]\\/invoice\\:grid-cols-1")).toBeTruthy();
  });

  it("asks his details whole the first time, and after that shows one line with Edit", async () => {
    from = null;
    const first = await open();
    expect(within(first.dialog).getByLabelText("Business name")).toBeTruthy();
    expect(within(first.dialog).getByLabelText("How to pay")).toBeTruthy();
    cleanup();
    from = FROM;
    const after = await open();
    expect(within(after.dialog).queryByLabelText("Business name")).toBeNull();
    expect(within(after.dialog).getByText("From Ridgeline Officiating")).toBeTruthy();
    fireEvent.click(within(after.dialog).getByRole("button", { name: "Edit" }));
    expect((within(after.dialog).getByLabelText("Business name") as HTMLInputElement).value).toBe("Ridgeline Officiating");
  });

  it("says a purchase request in its own words", async () => {
    from = null;
    const { dialog } = await open("request");
    expect(screen.getByRole("dialog", { name: "Purchase request" })).toBe(dialog);
    expect(host.asked[0].params).toEqual({ workspaceId: "ws", kind: "request" });
    expect(within(dialog).getByLabelText("Vendor")).toBeTruthy();
    expect(within(dialog).queryByLabelText("To")).toBeNull();
    expect(within(dialog).getByLabelText("Reason")).toBeTruthy();
    expect(within(dialog).queryByLabelText("How to pay")).toBeNull();
    // A request comes from a department, not a business.
    expect(within(dialog).getByRole("textbox", { name: "From" })).toBeTruthy();
    expect(within(dialog).queryByLabelText("Business name")).toBeNull();
  });

  it("creates in three calls, in order, and sends nothing", async () => {
    const { dialog, onCreated } = await open();
    fireEvent.change(within(dialog).getByLabelText("To"), { target: { value: "Harlan Valley Officials" } });
    fireEvent.change(within(dialog).getByLabelText("What, line 1"), { target: { value: "Varsity games" } });
    fireEvent.change(within(dialog).getByLabelText("Quantity, line 1"), { target: { value: "2" } });
    fireEvent.change(within(dialog).getByLabelText("Rate, line 1"), { target: { value: "75" } });
    host.asked.length = 0;
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await settle();
    await settle();
    expect(host.asked.map((a) => a.method)).toEqual(["work.money.invoice", "work.formats.print", "work.money.keep"]);
    const invoice = { kind: "invoice", number: "1042", to: "Harlan Valley Officials", date: today(), due: addDays(today(), 30), lines: [{ what: "Varsity games", quantity: 2, rate: 7500 }], from: FROM };
    // The page and the kept file name one Create by one key.
    expect(host.asked[0].params).toEqual({ workspaceId: "ws", key: expect.any(String), invoice });
    expect(host.asked[2].params.key).toBe(host.asked[0].params.key);
    expect(host.asked[1].params).toEqual({ name: "Invoice 1042 Harlan Valley", html: "<h1>Invoice 1042</h1>", paper: "Letter" });
    expect(host.asked[2].params).toMatchObject({ workspaceId: "ws", what: "invoice", invoice, part: 0, parts: 1 });
    expect(onCreated).toHaveBeenCalledWith(kept, invoice);
    expect(written).toEqual([]);
  });
});

describe("an invoice, by the keyboard and on a retry", () => {
  it("adds the next line on Return in a line's field, and moves to its What", async () => {
    const { dialog } = await open();
    fireEvent.change(within(dialog).getByLabelText("What, line 1"), { target: { value: "Varsity games" } });
    fireEvent.keyDown(within(dialog).getByLabelText("Rate, line 1"), { key: "Enter" });
    await settle();
    expect(within(dialog).getByLabelText("What, line 2")).toBe(document.activeElement);
    expect(host.asked.filter((a) => a.method === "work.money.invoice")).toEqual([]);
    expect(within(dialog).getByText("Total")).toBeTruthy();
  });

  it("sends the same key when the same Create is tried again", async () => {
    let fail = true;
    const answer = host.answer;
    host.answer = (method, params) => {
      if (method === "work.money.keep" && fail) {
        fail = false;
        throw new Error("The box did not answer");
      }
      return answer(method, params);
    };
    const { dialog } = await open();
    fireEvent.change(within(dialog).getByLabelText("To"), { target: { value: "Harlan Valley Officials" } });
    fireEvent.change(within(dialog).getByLabelText("What, line 1"), { target: { value: "Varsity games" } });
    fireEvent.change(within(dialog).getByLabelText("Rate, line 1"), { target: { value: "75" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await settle();
    await settle();
    expect(within(dialog).getByText("The box did not answer")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await settle();
    await settle();
    const keys = host.asked.filter((a) => a.method === "work.money.keep").map((a) => a.params.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});

describe("Send…", () => {
  it("opens the job's Mail with the composer filled, one line that claims no attachment, names the PDF to attach, and sends nothing", async () => {
    expect(sentAs("Invoices/Invoice 1042 Harlan Valley.pdf")).toEqual({ kind: "invoice", number: "1042" });
    expect(sentAs("Requests/Purchase request 12 Field Supply.pdf")).toEqual({ kind: "request", number: "12" });
    expect(sentAs("Receipts/2026/fuel.jpg")).toBeNull();
    toast.mockClear();
    sendInvoice("box", "ws", kept.source as never, kept.receipt, "invoice", "1042", "$150.00");
    await settle();
    expect(written).toEqual([{ to: [], cc: [], bcc: [], subject: "Invoice 1042", body: "Invoice 1042, for $150.00." }]);
    expect(opened).toHaveBeenCalledWith({ workspaceId: "ws", view: "mail" });
    expect(toast).toHaveBeenCalledWith("Attach Invoice 1042 Harlan Valley.pdf from Money/Invoices.", expect.objectContaining({ action: expect.objectContaining({ label: "Show in Files" }) }));
    // Nothing went to the host: Files opens only on his press.
    expect(host.asked).toEqual([]);
    (toast.mock.calls[0][1] as { action: { onClick: () => void } }).action.onClick();
    await settle();
    expect(host.asked.map((a) => a.method)).toEqual(["work.files.open"]);
  });
});
