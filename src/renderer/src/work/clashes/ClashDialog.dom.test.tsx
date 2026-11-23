// @vitest-environment jsdom
/** The Clash dialog: the two events and the drive, only the ways out each allows, each way's one step, Send, a refusal in words, and "This is fine". */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clash, ClashSide } from "@shared/work/clashes";
import { marksOf, NO_MARKS, type ClashMarks } from "./model";

const HOUR = 3_600_000;
const T0 = new Date(2026, 10, 26, 13, 0).getTime();

const wire = vi.hoisted(() => ({ calls: [] as { method: string; params: unknown }[], fail: null as string | null, hold: null as (() => void) | null }));
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    linkOf: () => ({
      request: (method: string, params: unknown) => {
        wire.calls.push({ method, params });
        if (wire.fail) return Promise.reject(new Error(wire.fail));
        return new Promise<null>((resolve) => {
          if (wire.hold === null) resolve(null);
          else wire.hold = () => resolve(null);
        });
      },
    }),
  },
}));
const marks = vi.hoisted(() => ({ now: null as unknown }));
vi.mock("./mark", () => ({ useClashes: () => marks.now }));
const lifeos = vi.hoisted(() => ({ attendees: [] as { address: string }[] }));
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosSession: () => ({ environmentId: "box", sector: null, state: "connected", client: { query: async () => ({ attendees: lifeos.attendees }) } }),
}));
const toasts = vi.hoisted(() => ({ said: [] as { words: string; action?: { label: string; onClick: () => void } }[] }));
vi.mock("../../components/ui/toaster", () => ({
  loadToast: async () => Object.assign((words: string, opts?: { action?: { label: string; onClick: () => void } }) => void toasts.said.push({ words, ...opts }), { error: (words: string) => void toasts.said.push({ words }) }),
}));
const mail = vi.hoisted(() => ({ drafts: [] as unknown[] }));
vi.mock("../mail/mailto", () => ({ writeMail: (draft: unknown) => void mail.drafts.push(draft) }));

const { ClashDialog } = await import("./ClashDialog");
const { openWorkView, workViewNow } = await import("../../lib/workSwitch");

const side = (eventId: string, title: string, startH: number, hours: number, more: Partial<ClashSide> = {}): ClashSide => ({
  eventId,
  sector: "ref",
  title,
  startsAt: T0 + startH * HOUR,
  endsAt: T0 + (startH + hours) * HOUR,
  can: [],
  ...more,
});
const meeting = (can: ClashSide["can"]) => side("ev_a", "Staff meeting", 0, 2, { sector: "purdue", place: "Cedar Hall, 4 Elm St", can });
const game = (can: ClashSide["can"], more: Partial<ClashSide> = {}) => side("ev_b", "Varsity Basketball", 1, 2, { place: "Maple Ridge High School", workspaceId: "ws_ref", can, ...more });
const overlap = (a = meeting(["decline", "propose"]), b = game(["move", "late"])): Clash => ({ id: "ev_a-ev_b", kind: "overlap", a, b, minutes: 38, miles: 24, measured: true });

const show = (clash: Clash | null, live: ClashMarks = clash ? marksOf({ clashes: [clash], leaves: [] }) : NO_MARKS) => {
  marks.now = live;
  const onClose = vi.fn();
  render(<ClashDialog ask={{ id: "ev_a-ev_b", environmentId: "box", ...(clash ? { clash } : {}) }} onClose={onClose} />);
  return onClose;
};
const settle = () => act(async () => {});

beforeEach(() => {
  wire.calls.length = 0;
  wire.fail = null;
  wire.hold = null;
  toasts.said.length = 0;
  mail.drafts.length = 0;
  lifeos.attendees = [];
});
afterEach(() => {
  cleanup();
  openWorkView(null);
});

describe("the Clash dialog", () => {
  it("names the fact, then the two events in time order with the drive between them", async () => {
    show(overlap());
    await settle();
    const dialog = screen.getByRole("dialog", { name: "Two things at once" });
    const text = dialog.textContent ?? "";
    expect(text.indexOf("Staff meeting")).toBeLessThan(text.indexOf("38 min drive, 24 mi"));
    expect(text.indexOf("38 min drive, 24 mi")).toBeLessThan(text.indexOf("Varsity Basketball"));
    // Each event with its job and where it is.
    expect(within(dialog).getByText("Purdue")).toBeTruthy();
    expect(within(dialog).getByText("Cedar Hall, 4 Elm St")).toBeTruthy();
    expect(within(dialog).getByText("Maple Ridge High School")).toBeTruthy();
  });

  it("titles a drive clash with the minutes short, and words an unmeasured drive as about", async () => {
    show({ ...overlap(), kind: "drive", shortBy: 15, measured: false, minutes: 41, miles: 25 });
    await settle();
    const dialog = screen.getByRole("dialog", { name: "About 15 minutes short" });
    expect(within(dialog).getByText("About 40 min, 25 mi")).toBeTruthy();
  });

  it("shows his calendar's words for a place the map only has roughly, and no drive line without one", async () => {
    show({ id: "ev_a-ev_b", kind: "overlap", a: side("ev_a", "Staff meeting", 0, 2, { place: "Cedar Falls, IN", location: "Cedar Hall, Cedar Falls, IN", rough: "town" }), b: game([]) });
    await settle();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Cedar Hall, Cedar Falls, IN")).toBeTruthy();
    expect(within(dialog).queryByText("Cedar Falls, IN")).toBeNull();
    expect(dialog.querySelector("[data-clash-drive]")?.textContent).toBe("");
  });

  it("offers under each event only the ways out it allows", async () => {
    show(overlap());
    await settle();
    const ways = [...document.querySelectorAll("[data-way]")].map((b) => `${b.getAttribute("data-way")} ${b.textContent}`);
    expect(ways).toEqual(["a:decline Decline", "a:propose Propose new time…", "b:move Move…", "b:late Running late…"]);
  });

  it("offers Running late only on the later event, and only where Mail can open for its job", async () => {
    show(overlap(meeting(["late"]), game(["late"], { workspaceId: undefined })));
    await settle();
    expect(document.querySelectorAll("[data-way]")).toHaveLength(0);
  });

  it("declines with his note as his own press, then closes with a toast", async () => {
    const onClose = show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    // The step shows the event and what goes before Send.
    const step = document.querySelector("[data-clash-step='a:decline']")!;
    expect(step.textContent).toContain("Declines Staff meeting. Its organizer is told.");
    expect(step.textContent).not.toContain("Varsity Basketball");
    expect(step.querySelector("input[type=time]")).toBeNull();
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: " At a game then " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(wire.calls).toEqual([{ method: "work.clashes.answer", params: { eventId: "ev_a", way: "decline", comment: "At a game then" } }]);
    expect(toasts.said.map((t) => t.words)).toEqual(["Declined Staff meeting"]);
    await settle();
    expect(onClose).toHaveBeenCalled();
  });

  it("proposes the first quarter hour after the other event that the drive allows", async () => {
    show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Propose new time…" }));
    // The game ends at 4:00 and the drive is 38 minutes: 4:45 for the meeting's two hours.
    expect((screen.getByLabelText("Day") as HTMLInputElement).value).toBe("2026-11-26");
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("16:45");
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe("18:45");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(wire.calls[0]).toEqual({ method: "work.clashes.answer", params: { eventId: "ev_a", way: "propose", start: T0 + 3 * HOUR + 45 * 60_000, end: T0 + 5 * HOUR + 45 * 60_000 } });
    expect(toasts.said[0]?.words).toBe("New time proposed for Staff meeting");
  });

  it("moves his own event to the time he sets, with no note to send", async () => {
    show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Move…" }));
    expect(screen.queryByLabelText("Note")).toBeNull();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "18:00" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "19:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await settle();
    expect(wire.calls[0]).toEqual({ method: "work.clashes.answer", params: { eventId: "ev_b", way: "move", start: T0 + 5 * HOUR, end: T0 + 6.5 * HOUR } });
  });

  it("refuses times that cannot be, in words, before asking anything", async () => {
    show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Move…" }));
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await settle();
    expect(screen.getByText("It must end after it starts")).toBeTruthy();
    expect(wire.calls).toEqual([]);
  });

  it("keeps a refusal in the dialog in LifeOS's words", async () => {
    wire.fail = "this calendar's Google account must be connected again";
    const onClose = show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(screen.getByText("This calendar's Google account must be connected again")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(toasts.said).toEqual([]);
    // Send is his to press again.
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("holds Send and Back while the answer is on its way", async () => {
    wire.hold = () => {};
    show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect((document.querySelector("[data-dialog-confirm]") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => wire.hold?.());
    expect(toasts.said).toHaveLength(1);
  });

  it("goes back to the two events from a step, with focus on the way it came from", async () => {
    show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Propose new time…" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await settle();
    expect(screen.getByText("Varsity Basketball")).toBeTruthy();
    expect(document.activeElement?.getAttribute("data-way")).toBe("a:propose");
  });

  it("opens Mail's composer for Running late, to the people on the later event, with one line", async () => {
    lifeos.attendees = [{ address: "dana@example.com" }, { address: "room-204" }];
    const onClose = show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Running late…" }));
    await settle();
    expect(workViewNow()).toEqual({ workspaceId: "ws_ref", view: "mail" });
    // An hour shared and a 38 minute drive.
    expect(mail.drafts).toEqual([{ to: ["dana@example.com"], cc: [], bcc: [], subject: "Running late: Varsity Basketball", body: "I'm running about 98 minutes late." }]);
    expect(wire.calls).toEqual([]);
    await settle();
    expect(onClose).toHaveBeenCalled();
  });

  it("quiets the clash with This is fine, and Undo brings it back", async () => {
    const onClose = show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "This is fine" }));
    await settle();
    expect(wire.calls).toEqual([{ method: "work.clashes.waive", params: { id: "ev_a-ev_b", on: true } }]);
    expect(toasts.said[0]?.words).toBe("Marked as fine");
    toasts.said[0]?.action?.onClick();
    await settle();
    expect(wire.calls[1]).toEqual({ method: "work.clashes.waive", params: { id: "ev_a-ev_b", on: false } });
    await settle();
    expect(onClose).toHaveBeenCalled();
  });

  it("reads the clash by its id when the opener did not hand it over: bones, then the clash", async () => {
    show(null);
    await settle();
    expect(screen.getByRole("dialog", { name: "Clash" }).querySelector("[data-slot=skeleton]")).not.toBeNull();
    cleanup();
    show(null, marksOf({ clashes: [overlap()], leaves: [] }));
    await settle();
    expect(screen.getByRole("dialog", { name: "Two things at once" })).toBeTruthy();
  });

  it("says so once the two no longer clash", async () => {
    show(overlap(), marksOf({ clashes: [], leaves: [] }));
    await settle();
    const dialog = screen.getByRole("dialog", { name: "No longer a clash" });
    expect(within(dialog).getByText("These two events no longer clash.")).toBeTruthy();
    expect(document.querySelectorAll("[data-way]")).toHaveLength(0);
    expect(within(dialog).queryByRole("button", { name: "This is fine" })).toBeNull();
  });
});
