import { describe, expect, it, vi } from "vitest";
import { closeCopyTab } from "./copyClose";
import { copyBackDue, copyLine } from "./fileText";

/** A copy that saves back to its file on another computer: the header's words per state, when its tab sends, and its close. */

const AT = new Date(2026, 10, 23, 13, 52).getTime();
const NOW = new Date(2026, 10, 23, 14, 30).getTime();

describe("the line of a copy that saves back", () => {
  it("names the computer in every state, in few words and no middle dots", () => {
    const words = (back: Parameters<typeof copyLine>[1], kind: Parameters<typeof copyLine>[0] = { state: "saved" }) => copyLine(kind, back, "MacBook", NOW).words;
    expect(words({ is: "ok" })).toBe("On MacBook");
    expect(words({ is: "ok", at: AT })).toBe("Saved to MacBook 1:52 PM");
    expect(words({ is: "sending" })).toBe("Saving to MacBook…");
    expect(words({ is: "ok", at: AT }, { state: "saving" })).toBe("Saving to MacBook…");
    expect(words({ is: "changed", at: AT })).toBe("This file changed on MacBook");
    expect(words({ is: "gone" })).toBe("This file was moved or deleted on MacBook");
    expect(words({ is: "away" })).toBe("MacBook is not answering. Changes wait here");
    expect(words({ is: "refused", detail: "this host's bridge is off for that host." })).toBe("MacBook refused the save. This host's bridge is off for that host");
    expect(words({ is: "refused" })).toBe("MacBook refused the save");
    expect(copyLine(null, { is: "ok", at: AT }, "the Windows VM", NOW).words).toBe("Saved to the Windows VM 1:52 PM");
    for (const is of ["ok", "sending", "changed", "gone", "away", "refused"] as const) expect(words({ is, at: AT, detail: "x" })).not.toContain("·");
  });

  it("never reads as saved while his window's ask is unanswered, and says the host's refusal of it", () => {
    expect(copyLine({ state: "saved", at: AT }, { is: "ok", at: AT - 60_000 }, "the Windows VM", NOW, { owed: true }).words).toBe("Saving to the Windows VM…");
    expect(copyLine({ state: "saved" }, { is: "ok" }, "MacBook", NOW, { owed: true }).state).toBe("saving");
    const failed = copyLine({ state: "saved", at: AT }, { is: "ok", at: AT - 60_000 }, "MacBook", NOW, { failed: "the link dropped." });
    expect(failed).toMatchObject({ state: "conflict", words: "Not saved to MacBook. The link dropped" });
    // What the host says of the file wins over the window's own ask.
    expect(copyLine(null, { is: "away" }, "MacBook", NOW, { failed: "x" }).words).toBe("MacBook is not answering. Changes wait here");
    expect(copyLine(null, { is: "ok", at: AT }, "MacBook", NOW, {}).words).toBe("Saved to MacBook 1:52 PM");
  });

  it("takes the foreground only where it needs him", () => {
    expect(copyLine(null, { is: "away" }, "MacBook").needs).toBe(true);
    expect(copyLine(null, { is: "changed" }, "MacBook").state).toBe("conflict");
    expect(copyLine(null, { is: "refused" }, "MacBook").state).toBe("conflict");
    expect(copyLine(null, { is: "ok", at: AT }, "MacBook")).toMatchObject({ state: "saved" });
    expect(copyLine(null, { is: "ok" }, "MacBook").needs).toBeUndefined();
  });

  it("shows the kind's own trouble with the copy itself as the kind says it", () => {
    const own = { state: "readonly" as const, detail: "Others can open this sheet: this key may not change it." };
    expect(copyLine(own, { is: "ok" }, "MacBook")).toBe(own);
    const conflict = { state: "conflict" as const, detail: "The file was not saved: disk full" };
    expect(copyLine(conflict, { is: "away" }, "MacBook")).toBe(conflict);
  });
});

describe("when a copy's tab asks for a send", () => {
  it("asks once the kind went from saving to saved, or says a newer save, never for a line read at open", () => {
    expect(copyBackDue(null, { state: "saved", at: AT })).toBe(false);
    expect(copyBackDue({ state: "saving" }, { state: "saved", at: AT })).toBe(true);
    expect(copyBackDue({ state: "saving" }, { state: "saved" })).toBe(true);
    expect(copyBackDue({ state: "saved", at: AT }, { state: "saved", at: AT })).toBe(false);
    expect(copyBackDue({ state: "saved", at: AT }, { state: "saved", at: AT + 1000 })).toBe(true);
    expect(copyBackDue({ state: "saving" }, { state: "conflict" })).toBe(false);
  });
});

describe("closing a copy's tab", () => {
  const deps = (choice: "action" | "other" | null = "action", ok = true) => ({ choose: vi.fn(async () => choice), confirm: vi.fn(async () => ok), close: vi.fn(async () => undefined), keepBoth: vi.fn(async () => undefined) });

  it("closes at once when the file holds what the copy holds", async () => {
    const d = deps();
    expect(await closeCopyTab({ name: "Roster.xlsx", back: { is: "ok", at: AT } }, "MacBook", d)).toBe(true);
    expect(d.choose).not.toHaveBeenCalled();
    expect(d.close).toHaveBeenCalledWith(false);
  });

  it("asks once while changes wait for the computer: Keep trying keeps them, Discard drops them, Cancel keeps the tab", async () => {
    const keep = deps("action");
    expect(await closeCopyTab({ name: "Roster.xlsx", back: { is: "away" } }, "MacBook", keep)).toBe(true);
    expect(keep.choose).toHaveBeenCalledWith({ title: "Changes to Roster.xlsx have not reached MacBook.", action: "Keep trying", other: "Discard" });
    expect(keep.close).toHaveBeenCalledWith(false);
    const drop = deps("other");
    await closeCopyTab({ name: "Roster.xlsx", back: { is: "sending" } }, "MacBook", drop);
    expect(drop.close).toHaveBeenCalledWith(true);
    const stay = deps(null);
    expect(await closeCopyTab({ name: "Roster.xlsx", back: { is: "away" } }, "MacBook", stay)).toBe(false);
    expect(stay.close).not.toHaveBeenCalled();
  });

  it("offers Keep Both over a file that changed there, and Discard alone where it was refused", async () => {
    const both = deps("action");
    await closeCopyTab({ name: "Roster.xlsx", back: { is: "changed", at: AT } }, "MacBook", both);
    expect(both.choose).toHaveBeenCalledWith(expect.objectContaining({ action: "Keep Both", other: "Discard" }));
    expect(both.keepBoth).toHaveBeenCalledTimes(1);
    expect(both.close).toHaveBeenCalledWith(false);
    const refused = deps("action", true);
    await closeCopyTab({ name: "Roster.xlsx", back: { is: "refused", detail: "no" } }, "MacBook", refused);
    expect(refused.confirm).toHaveBeenCalledWith({ title: "Changes to Roster.xlsx have not reached MacBook.", action: "Discard", danger: true });
    expect(refused.close).toHaveBeenCalledWith(true);
  });
});
