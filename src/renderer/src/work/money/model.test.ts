import { describe, expect, it } from "vitest";
import { blankForm, canSave, fieldsOfForm, formOfReceipt, formOfRow, offerDay, parseAmount, periodLabel, periodOf, rowMoney, shortMoney, signedMoney, sinceWords, statusChoices, stepPeriod } from "./model";
import { ledgerRow } from "./money.fixtures";

describe("the Money view's period", () => {
  it("steps a month across the year's end, and a year by one", () => {
    const nov = { span: "month" as const, year: 2026, month: 11 };
    expect(periodLabel(nov)).toBe("November 2026");
    expect(periodLabel(stepPeriod(stepPeriod(nov, 1), 1))).toBe("January 2027");
    expect(periodLabel(stepPeriod({ ...nov, month: 1 }, -1))).toBe("December 2025");
    expect(periodOf(nov)).toEqual({ from: "2026-11-01", to: "2026-12-01" });
    const year = { ...nov, span: "year" as const };
    expect(periodLabel(year)).toBe("2026");
    expect(periodOf(stepPeriod(year, -1))).toEqual({ from: "2025-01-01", to: "2026-01-01" });
    // The month is kept while the year is shown.
    expect(stepPeriod(year, 1).month).toBe(11);
  });
});

describe("the Money view's words", () => {
  it("puts + before money in and nothing before money out", () => {
    expect(signedMoney(7500)).toBe("+$75.00");
    expect(signedMoney(-4210)).toBe("$42.10");
    expect(rowMoney({ in: 7500, out: 0 })).toBe("+$75.00");
    expect(rowMoney({ in: 0, out: 120450 })).toBe("$1,204.50");
  });

  it("shortens the axis and counts the days open", () => {
    expect(shortMoney(123_400)).toBe("$1.2k");
    expect(shortMoney(45_000)).toBe("$450");
    expect(sinceWords("2026-10-20", "2026-11-21")).toBe("32 days");
    expect(sinceWords("2026-11-20", "2026-11-21")).toBe("1 day");
    expect(sinceWords("2026-11-21", "2026-11-21")).toBe("Today");
    expect(sinceWords(null)).toBeNull();
    expect(offerDay("2026-11-21")).toBe("Sat Nov 21");
  });
});

describe("the entry dialog's form", () => {
  it("reads an amount as he types it, and saves only with an amount and a date", () => {
    expect(parseAmount("42.1")).toBe(4210);
    expect(parseAmount("$1,204.50")).toBe(120450);
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("-5")).toBeNull();
    expect(parseAmount("forty")).toBeNull();
    expect(canSave({ amount: "12", date: "2026-11-21" })).toBe(true);
    expect(canSave({ amount: "", date: "2026-11-21" })).toBe(false);
    expect(canSave({ amount: "12", date: "" })).toBe(false);
  });

  it("writes money spent to be paid back as To reimburse, and never both a status and the box", () => {
    const form = { ...blankForm("ws", "2026-11-09"), amount: "16.25", who: " Diner on 9th ", reimburse: true, status: "Unpaid" as const };
    expect(fieldsOfForm(form)).toEqual({ date: "2026-11-09", who: "Diner on 9th", what: "", category: "", way: "out", amount: 1625, status: "To reimburse", paidOn: null });
    // Money received cannot be paid back: the box does not count.
    expect(fieldsOfForm({ ...form, way: "in" })?.status).toBe("Unpaid");
    expect(fieldsOfForm({ ...form, amount: "" })).toBeNull();
  });

  it("comes back from a row as it was, and keeps a status the field does not offer", () => {
    const row = ledgerRow("2026-11-09", "Diner on 9th", "Meals", -1625, { status: "To reimburse", what: "Crew meal" });
    const form = formOfRow(row, "ws");
    expect(form).toMatchObject({ amount: "16.25", date: "2026-11-09", who: "Diner on 9th", category: "Meals", way: "out", reimburse: true, what: "Crew meal" });
    expect(fieldsOfForm(form, row)?.status).toBe("To reimburse");
    const requested = formOfRow(ledgerRow("2026-11-02", "Field Supply", "Equipment", -9000, { status: "Requested" }), "ws");
    expect(statusChoices(requested)).toEqual(["Paid", "Unpaid", "Requested"]);
    const paidRow = ledgerRow("2026-11-01", "Ridgeline Conference", "Game fees", 6500, { paidOn: "2026-11-05" });
    expect(fieldsOfForm(formOfRow(paidRow, "ws"), paidRow)?.paidOn).toBe("2026-11-05");
  });

  it("fills from a receipt what was read, and leaves the rest empty", () => {
    expect(formOfReceipt({ amount: 4210, date: null, who: "Corner Fuel", category: null }, "ws")).toMatchObject({ amount: "42.10", date: "", who: "Corner Fuel", category: "", way: "out" });
  });
});
