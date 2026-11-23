// @vitest-environment jsdom
/** The Clash dialog: the two events and the drive, only the ways out each allows, each way's one step, Send, a refusal in words, and "This is fine". */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clash, ClashSide } from "@shared/work/clashes";
import { startOfDay } from "work-kit/views/lib/agenda";
import { formatDayHeading } from "work-kit/views/lib/format";
import { marksOf, NO_MARKS, type ClashMarks } from "./model";

const HOUR = 3_600_000;
/** A day far ahead of any clock this runs on, 1:00 PM. */
const T0 = new Date(2031, 10, 26, 13, 0).getTime();

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
const lifeos = vi.hoisted(() => ({ attendees: [] as { address: string }[], gone: false }));
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosSession: () => (lifeos.gone ? { environmentId: "box", sector: null, state: "unreachable", client: null } : { environmentId: "box", sector: null, state: "connected", client: { query: async () => ({ attendees: lifeos.attendees }) } }),
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
  lifeos.gone = false;
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
    // Each event is a group by its name, so a verb under it says whose it is.
    expect(within(screen.getByRole("group", { name: "Staff meeting" })).getByRole("button", { name: "Decline" })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Varsity Basketball" })).queryByRole("button", { name: "Decline" })).toBeNull();
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
    expect(step.textContent).toContain("Its organizer is told you declined.");
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

  it("fills a proposal for the earlier event with the latest time that still ends a drive before the later one", async () => {
    show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Propose new time…" }));
    // The game starts at 2:00 and the drive is 38 minutes: the two-hour meeting is offered 11:15 to 1:15.
    expect((screen.getByLabelText("Day") as HTMLInputElement).value).toBe("2031-11-26");
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("11:15");
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe("13:15");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(wire.calls[0]).toEqual({ method: "work.clashes.answer", params: { eventId: "ev_a", way: "propose", start: T0 - 105 * 60_000, end: T0 + 15 * 60_000 } });
    expect(toasts.said[0]?.words).toBe("New time proposed for Staff meeting");
  });

  it("fills a move of the later event with the first quarter hour after the earlier one that the drive allows, and takes a span past midnight", async () => {
    show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Move…" }));
    // The meeting ends at 3:00 and the drive is 38 minutes: 3:45 for the game's two hours.
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("15:45");
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe("17:45");
    expect(screen.queryByText("Next day")).toBeNull();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "23:30" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "01:00" } });
    expect(screen.getByText("Next day")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await settle();
    expect(wire.calls[0]).toEqual({ method: "work.clashes.answer", params: { eventId: "ev_b", way: "move", start: T0 + 10.5 * HOUR, end: T0 + 12 * HOUR } });
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
    fireEvent.change(screen.getByLabelText("To"), { target: { value: (screen.getByLabelText("From") as HTMLInputElement).value } });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("It must end after it starts");
    expect(wire.calls).toEqual([]);
    // An edit takes the words away; a day already gone is refused the same way.
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "23:00" } });
    expect(screen.getByRole("alert").textContent).toBe("");
    fireEvent.change(screen.getByLabelText("Day"), { target: { value: "2020-01-01" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("That time has passed");
    expect(wire.calls).toEqual([]);
  });

  it("keeps a refusal in the dialog in LifeOS's words", async () => {
    wire.fail = "this calendar's Google account must be connected again";
    const onClose = show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    // Said aloud too: the refusal is an alert.
    expect(screen.getByRole("alert").textContent).toBe("This calendar's Google account must be connected again");
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

  it("keeps the clash on screen when his own press ends it, and never turns to No longer a clash as it closes", async () => {
    wire.hold = () => {};
    const view = (live: ClashMarks) => {
      marks.now = live;
      return <ClashDialog ask={{ id: "ev_a-ev_b", environmentId: "box", clash: overlap() }} onClose={() => {}} />;
    };
    const { rerender } = render(view(marksOf({ clashes: [overlap()], leaves: [] })));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "This is fine" }));
    // LifeOS drops the clash from the live read before the host has answered the press.
    rerender(view(marksOf({ clashes: [], leaves: [] })));
    await settle();
    expect(screen.getByRole("dialog", { name: "Two things at once" })).toBeTruthy();
    await act(async () => wire.hold?.());
    await settle();
    expect(screen.queryByRole("dialog", { name: "No longer a clash" })).toBeNull();
    expect(toasts.said[0]?.words).toBe("Marked as fine");
  });

  it("keeps a step he is typing in when the calendar settles the clash meanwhile: it says so, sends nothing, and Back shows the clash is gone", async () => {
    const view = (live: ClashMarks) => {
      marks.now = live;
      return <ClashDialog ask={{ id: "ev_a-ev_b", environmentId: "box", clash: overlap() }} onClose={() => {}} />;
    };
    const { rerender } = render(view(marksOf({ clashes: [overlap()], leaves: [] })));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "At a game then, sorry" } });
    expect(document.querySelector("[data-clash-step] [aria-live=polite]")?.textContent).toBe("Its organizer is told you declined.");
    const day = formatDayHeading(startOfDay(overlap().b.startsAt));
    expect(screen.getByRole("dialog").textContent).toContain(day);
    rerender(view(marksOf({ clashes: [], leaves: [] })));
    await settle();
    // What he typed is still there to read or copy.
    expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toBe("At a game then, sorry");
    // The title follows the read, so the top and the foot of the step say one thing.
    expect(screen.getByRole("dialog", { name: "No longer a clash" })).toBeTruthy();
    // The line that said what would go is the one that now says nothing went, and the day under the title stays.
    const said = document.querySelector("[data-clash-step] [aria-live=polite]")!;
    expect(said.querySelector("span:not(.invisible)")?.textContent).toBe("Nothing was sent.");
    // The first sentence keeps its lines, unseen and unread, so the fields under it do not move.
    expect(said.querySelector("span.invisible")?.textContent).toBe("Its organizer is told you declined.");
    expect(screen.getByRole("dialog").textContent).toContain(day);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(document.querySelector("[data-clash-step]")!);
    await settle();
    expect(wire.calls).toEqual([]);
    // A read that then fails, or is out again, says nothing new: Send stays off and the old pair does not come back.
    rerender(view({ ...NO_MARKS, failed: "LifeOS did not answer" }));
    await settle();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(view(NO_MARKS));
    await settle();
    expect(screen.getByRole("dialog", { name: "No longer a clash" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await settle();
    expect(screen.getByRole("dialog", { name: "No longer a clash" })).toBeTruthy();
  });

  it("locks a step's fields while Send is out, so what goes is what shows", async () => {
    wire.hold = () => {};
    show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Propose new time…" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    for (const label of ["Day", "From", "To", "Note"]) expect((screen.getByLabelText(label) as HTMLInputElement).disabled, label).toBe(true);
    await act(async () => wire.hold?.());
  });

  it("says that a move of an event with guests is mailed to them", async () => {
    show(overlap(meeting([]), game(["move"], { guests: true })));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Move…" }));
    expect(document.querySelector("[data-clash-step='b:move']")?.textContent).toContain("It moves on your calendar, and its guests are told the new time.");
  });

  it("says why Running late cannot open when LifeOS is out of reach", async () => {
    lifeos.gone = true;
    const onClose = show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Running late…" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("LifeOS did not answer");
    expect(mail.drafts).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reads the clash by its id when the opener did not hand it over: bones, then the clash", async () => {
    show(null);
    await settle();
    expect(screen.getByRole("dialog", { name: "Clash" }).querySelector("[data-slot=skeleton]")).not.toBeNull();
    // The bones are for the eye; a screen reader hears the wait in words.
    expect(screen.getByRole("status").textContent).toBe("Reading the clash…");
    cleanup();
    show(null, marksOf({ clashes: [overlap()], leaves: [] }));
    await settle();
    expect(screen.getByRole("dialog", { name: "Two things at once" })).toBeTruthy();
  });

  it("says so once the two no longer clash, in its title alone", async () => {
    show(overlap(), marksOf({ clashes: [], leaves: [] }));
    await settle();
    const dialog = screen.getByRole("dialog", { name: "No longer a clash" });
    expect(dialog.textContent).not.toContain("no longer clash.");
    expect(document.querySelectorAll("[data-way]")).toHaveLength(0);
    expect(within(dialog).queryByRole("button", { name: "This is fine" })).toBeNull();
    expect(dialog.querySelector("[data-dialog-cancel]")?.textContent).toBe("Close");
  });

  it("keeps a clash it has seen gone as gone when a later read fails, never bringing back the opener's old copy", async () => {
    const view = (live: ClashMarks) => {
      marks.now = live;
      return <ClashDialog ask={{ id: "ev_a-ev_b", environmentId: "box", clash: overlap() }} onClose={() => {}} />;
    };
    const { rerender } = render(view(marksOf({ clashes: [], leaves: [] })));
    await settle();
    expect(screen.getByRole("dialog", { name: "No longer a clash" })).toBeTruthy();
    rerender(view({ ...NO_MARKS, failed: "LifeOS did not answer" }));
    await settle();
    expect(screen.getByRole("dialog", { name: "No longer a clash" })).toBeTruthy();
    expect(document.querySelectorAll("[data-way]")).toHaveLength(0);
    // A fresh read that holds the pair again brings it back.
    rerender(view(marksOf({ clashes: [overlap()], leaves: [] })));
    await settle();
    expect(screen.getByRole("dialog", { name: "Two things at once" })).toBeTruthy();
  });

  it("says why when the read failed and the opener handed nothing over, with no bones left waiting", async () => {
    show(null, { ...NO_MARKS, failed: "LifeOS did not answer" });
    await settle();
    const dialog = screen.getByRole("dialog", { name: "Clash" });
    expect(within(dialog).getByRole("alert").textContent).toBe("LifeOS did not answer");
    expect(dialog.querySelector("[data-slot=skeleton]")).toBeNull();
  });

  it("names the weekday of a time that is not on the day the dialog names", async () => {
    const night = side("ev_a", "Late game", -3, 2, { sector: "ref" });
    const morning = side("ev_b", "Breakfast", 20, 1, { sector: "life" });
    show({ id: "ev_a-ev_b", kind: "drive", a: night, b: morning, minutes: 30, measured: true, shortBy: 5 });
    await settle();
    const day = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(night.startsAt);
    expect(screen.getByRole("group", { name: "Late game" }).textContent).toContain(`${day} `);
    expect(screen.getByRole("group", { name: "Breakfast" }).textContent).not.toContain(new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(morning.startsAt));
  });

  it("drops the country every map name ends in", async () => {
    show(overlap(meeting([]), game([], { place: "Maple Ridge High School, 12 Oak St, Riverton, IN 47906, United States" })));
    await settle();
    expect(screen.getByText("Maple Ridge High School, 12 Oak St, Riverton, IN 47906")).toBeTruthy();
  });
});
