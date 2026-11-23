// @vitest-environment jsdom
/** The Clash dialog: the two events and the drive, only the ways out each allows, each way's one step, Send, a refusal in words, and "This is fine". */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Clash, ClashSide } from "@shared/work/clashes";
import { addDays, startOfDay } from "work-kit/views/lib/agenda";
import { formatDayHeading } from "work-kit/views/lib/format";
import { marksOf, NO_MARKS, type ClashMarks } from "./model";

const HOUR = 3_600_000;
/** A day far ahead of any clock this runs on, 1:00 PM. */
const T0 = new Date(2031, 10, 26, 13, 0).getTime();

const wire = vi.hoisted(() => ({ calls: [] as { method: string; params: unknown }[], fail: null as string | null, hold: null as (() => void) | null, reply: null as unknown, lost: null as "timeout" | "closed" | "offline" | null }));
const errors = vi.hoisted(() => ({}) as { TimeoutError: new (method: string, ms: number) => Error; ConnectionLostError: new (message: string) => Error });
vi.mock("../../lib/connection", async (original) => {
  const real = await original<typeof errors>();
  Object.assign(errors, { TimeoutError: real.TimeoutError, ConnectionLostError: real.ConnectionLostError });
  return mocked(real);
});
const mocked = (real: object) => ({
  ...real,
  registry: {
    linkOf: () => ({
      request: (method: string, params: unknown) => {
        wire.calls.push({ method, params });
        if (wire.lost) return Promise.reject(wire.lost === "timeout" ? new errors.TimeoutError(method, 30_000) : new errors.ConnectionLostError(wire.lost === "closed" ? "connection closed" : "not connected"));
        if (wire.fail) return Promise.reject(new Error(wire.fail));
        return new Promise<null>((resolve) => {
          if (wire.hold === null) resolve(wire.reply as null);
          else wire.hold = () => resolve(wire.reply as null);
        });
      },
    }),
  },
});
const marks = vi.hoisted(() => ({ now: null as unknown, asked: [] as unknown[] }));
vi.mock("./mark", () => ({ useClashes: (...asked: unknown[]) => ((marks.asked = asked), marks.now) }));
const lifeos = vi.hoisted(() => ({ attendees: [] as { address: string }[], gone: false, connecting: false, silent: false, held: null as Promise<unknown> | null }));
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosSession: () => (lifeos.gone || lifeos.connecting ? { environmentId: "box", sector: null, state: lifeos.gone ? "unreachable" : "connecting", client: null } : { environmentId: "box", sector: null, state: "connected", client: { query: () => lifeos.held ?? (lifeos.silent ? new Promise<never>(() => {}) : Promise.resolve({ attendees: lifeos.attendees })) } }),
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
  wire.reply = null;
  wire.lost = null;
  toasts.said.length = 0;
  mail.drafts.length = 0;
  lifeos.attendees = [];
  lifeos.gone = false;
  lifeos.connecting = false;
  lifeos.silent = false;
  lifeos.held = null;
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

  it("reads the fortnight from the earlier event's day, so an event of the pair that moves to another day stays in the read", async () => {
    show(overlap());
    await settle();
    const from = startOfDay(T0);
    expect(marks.asked).toEqual(["box", from, addDays(from, 14)]);
  });

  it("offers no way out under an event that is over, and keeps Running late under the later one", async () => {
    // Five minutes after the meeting ended; the game is under way.
    vi.useFakeTimers({ now: T0 + 2 * HOUR + 5 * 60_000, toFake: ["Date"] });
    try {
      show(overlap());
      await settle();
      const ways = [...document.querySelectorAll("[data-way]")].map((b) => b.getAttribute("data-way"));
      expect(ways).toEqual(["b:move", "b:late"]);
      expect(within(screen.getByRole("group", { name: "Staff meeting" })).queryByRole("button")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a timed step whose pair changed under it: it says so in the sentence's place, sends nothing, and Back gives a fresh offer", async () => {
    const view = (clash: Clash) => {
      marks.now = marksOf({ clashes: [clash], leaves: [] });
      return <ClashDialog ask={{ id: "ev_a-ev_b", environmentId: "box", clash: overlap() }} onClose={() => {}} />;
    };
    const { rerender } = render(view(overlap()));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Propose new time…" }));
    const offered = (screen.getByLabelText("From") as HTMLInputElement).value;
    // The game moves an hour later while the step is open.
    const moved = overlap(meeting(["decline", "propose"]), { ...game(["move", "late"]), startsAt: T0 + 2 * HOUR, endsAt: T0 + 4 * HOUR });
    rerender(view(moved));
    await settle();
    const said = document.querySelector("[data-clash-step] [aria-live=polite]")!;
    expect(said.querySelector("span:not(.invisible)")?.textContent).toBe("These events changed. Go back for a new time.");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(document.querySelector("[data-clash-step]")!);
    await settle();
    expect(wire.calls).toEqual([]);
    // What he typed is still his to read; a decline, which names no time, is never held.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Propose new time…" }));
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("From") as HTMLInputElement).value).not.toBe(offered);
  });

  it("does not hold a step under his own Move when the read shows the moved pair before the host answers", async () => {
    wire.hold = () => {};
    const view = (clash: Clash) => {
      marks.now = marksOf({ clashes: [clash], leaves: [] });
      return <ClashDialog ask={{ id: "ev_a-ev_b", environmentId: "box", clash: overlap() }} onClose={() => {}} />;
    };
    const { rerender } = render(view(overlap()));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Move…" }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await settle();
    // LifeOS has moved the game and still finds a clash; the host has not answered the press yet.
    rerender(view(overlap(meeting(["decline", "propose"]), { ...game(["move", "late"]), startsAt: T0 + 1.5 * HOUR, endsAt: T0 + 3.5 * HOUR })));
    await settle();
    const said = document.querySelector("[data-clash-step] [aria-live=polite]")!;
    expect(said.textContent).toBe("It moves on your calendar.");
    await act(async () => wire.hold?.());
    await settle();
    expect(toasts.said[0]?.words).toBe("Moving Varsity Basketball…");
  });

  it("holds an open step once its event is over, as the list gives such an event no way out", async () => {
    vi.useFakeTimers({ now: T0 + HOUR, toFake: ["Date"] });
    try {
      show(overlap());
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Decline" }));
      fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Could not make it" } });
      // The meeting ends while the step is open; the press comes five minutes on.
      vi.setSystemTime(T0 + 2 * HOUR + 5 * 60_000);
      fireEvent.submit(document.querySelector("[data-clash-step]")!);
      await settle();
      expect(wire.calls).toEqual([]);
      expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toBe("Could not make it");
    } finally {
      vi.useRealTimers();
    }
    // Opened after its end by a stale route: the step says so and Send is off.
    cleanup();
    vi.useFakeTimers({ now: T0 + 2 * HOUR + 5 * 60_000, toFake: ["Date"] });
    try {
      const { StepForm } = await import("./ClashDialog");
      render(<StepForm clash={overlap()} step={{ side: "a", way: "decline" }} pending={false} onBack={() => {}} onSend={() => {}} />);
      expect(document.querySelector("[data-clash-step] [aria-live=polite] span:not(.invisible)")?.textContent).toBe("This event is over.");
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("knows the same two events under a flipped id: one moves to start first, they still clash, and the step stays on its event", async () => {
    const view = (clash: Clash) => {
      marks.now = marksOf({ clashes: [clash], leaves: [] });
      return <ClashDialog ask={{ id: "ev_a-ev_b", environmentId: "box", clash: overlap() }} onClose={() => {}} />;
    };
    const { rerender } = render(view(overlap()));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(screen.getByRole("group", { name: "Staff meeting" })).toBeTruthy();
    // The game moves to start an hour before the meeting: LifeOS now names the pair game first.
    const first = { ...game(["move", "late"]), startsAt: T0 - HOUR, endsAt: T0 + HOUR };
    rerender(view({ ...overlap(first, meeting(["decline", "propose"])), id: "ev_b-ev_a" }));
    await settle();
    expect(screen.queryByRole("dialog", { name: "No longer a clash" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Two things at once" })).toBeTruthy();
    // Still the meeting's decline, and it goes for the meeting.
    expect(screen.getByRole("group", { name: "Staff meeting" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(wire.calls[0]).toMatchObject({ method: "work.clashes.answer", params: { eventId: "ev_a", way: "decline" } });
  });

  it("says a start beside the dialog's day and an end beside its start: a weekday within three days, a date further off", async () => {
    const times = (title: string) => within(screen.getByRole("group", { name: title })).getByText(/ – /).textContent;
    // A block that began a week before the day the dialog names: both ends dated, never a few hours on the first day.
    show(overlap(side("ev_a", "Training", -7 * 24, 7 * 24 + 2, { sector: "purdue" }), game([])));
    await settle();
    expect(times("Training")).toBe("Nov 19, 1:00 PM – Nov 26, 3:00 PM");
    expect(times("Varsity Basketball")).toBe("2:00 PM – 4:00 PM");
    cleanup();
    // One that began the night before and runs into the day.
    show(overlap(side("ev_a", "Night shift", -14, 16, { sector: "life" }), game([])));
    await settle();
    expect(times("Night shift")).toBe("Tue 11:00 PM – Wed 3:00 PM");
    cleanup();
    // One wholly on the day before says its day once.
    show({ ...overlap(side("ev_a", "Late call", -16, 2, { sector: "life" }), game([])), kind: "drive", shortBy: 15 });
    await settle();
    expect(times("Late call")).toBe("Tue 9:00 PM – 11:00 PM");
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
    expect(toasts.said.map((t) => t.words)).toEqual(["Declining Staff meeting…"]);
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
    expect(toasts.said[0]?.words).toBe("Proposing a new time for Staff meeting…");
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

  it("says a move is done only when the host wrote it in LifeOS; one handed to a calendar's sender is under way", async () => {
    wire.reply = { queued: false };
    show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Move…" }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await settle();
    expect(toasts.said[0]?.words).toBe("Moved Varsity Basketball");
    cleanup();
    toasts.said.length = 0;
    wire.reply = { queued: true };
    show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Move…" }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await settle();
    expect(toasts.said[0]?.words).toBe("Moving Varsity Basketball…");
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

  it("sends no second act when a Send left and got no answer: it says so, Send stays off, and Back gives the step afresh", async () => {
    for (const lost of ["timeout", "closed"] as const) {
      wire.lost = lost;
      show(overlap());
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Decline" }));
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await settle();
      expect(screen.getByRole("alert").textContent).toBe("The host did not confirm the send. Check the calendar before trying again.");
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.submit(document.querySelector("[data-clash-step]")!);
      await settle();
      expect(wire.calls).toHaveLength(1);
      // Back, and the way out again: a fresh step he may send from, once he has looked.
      wire.lost = null;
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      fireEvent.click(screen.getByRole("button", { name: "Decline" }));
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
      cleanup();
      wire.calls.length = 0;
    }
    // A request that never left sent nothing: the words are the link's, and Send is his again.
    wire.lost = "offline";
    show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Not connected");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("never says Nothing was sent after a Send that got no answer: the clash may be gone because the decline went", async () => {
    wire.lost = "timeout";
    const view = (live: ClashMarks) => {
      marks.now = live;
      return <ClashDialog ask={{ id: "ev_a-ev_b", environmentId: "box", clash: overlap() }} onClose={() => {}} />;
    };
    const { rerender } = render(view(marksOf({ clashes: [overlap()], leaves: [] })));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    // LifeOS queued the decline and dropped the clash; the host's answer was lost.
    rerender(view(marksOf({ clashes: [], leaves: [] })));
    await settle();
    expect(screen.getByRole("dialog", { name: "No longer a clash" })).toBeTruthy();
    const step = document.querySelector("[data-clash-step]")!;
    expect(step.textContent).not.toContain("Nothing was sent.");
    expect(step.querySelector("[aria-live=polite]")?.textContent).toBe("Its organizer is told you declined.");
    expect(screen.getByRole("alert").textContent).toBe("The host did not confirm the send. Check the calendar before trying again.");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says so when the pair changed a moment before This is fine, and marks nothing fine", async () => {
    wire.fail = "These events changed. Look at them again first.";
    const onClose = show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "This is fine" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("These events changed. Look at them again first.");
    expect(toasts.said).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "This is fine" }) as HTMLButtonElement).disabled).toBe(false);
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
    // What he saw goes with the press: each event's times and its calendar's words for the place, when it has them.
    const seen = [
      { eventId: "ev_a", startsAt: T0, endsAt: T0 + 2 * HOUR },
      { eventId: "ev_b", startsAt: T0 + HOUR, endsAt: T0 + 3 * HOUR },
    ];
    expect(wire.calls).toEqual([{ method: "work.clashes.waive", params: { id: "ev_a-ev_b", on: true, seen } }]);
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

  it("lets go of Running late when LifeOS never answers: ten seconds on it says so and Close works again", async () => {
    vi.useFakeTimers();
    try {
      lifeos.silent = true;
      show(overlap());
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Running late…" }));
      await settle();
      // The read is out: the dialog holds, as it does for any press.
      const closes = () => screen.getAllByRole("button", { name: "Close" }).map((b) => (b as HTMLButtonElement).disabled);
      expect(closes()).toEqual([true, true]);
      await act(async () => void vi.advanceTimersByTime(10_000));
      expect(screen.getByRole("alert").textContent).toBe("LifeOS did not answer");
      // The header's and the foot's both work again.
      expect(closes()).toEqual([false, false]);
      expect(mail.drafts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drafts nothing when the pair changes while Running late reads the people: the press is his again on the pair as it is", async () => {
    let answer: (value: { attendees: { address: string }[] }) => void = () => {};
    lifeos.held = new Promise((resolve) => (answer = resolve));
    const view = (clash: Clash) => {
      marks.now = marksOf({ clashes: [clash], leaves: [] });
      return <ClashDialog ask={{ id: "ev_a-ev_b", environmentId: "box", clash: overlap() }} onClose={() => {}} />;
    };
    const { rerender } = render(view(overlap()));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Running late…" }));
    await settle();
    // The meeting's end moves from 3:00 to 2:10 while the people are read: he is no longer an hour late.
    rerender(view(overlap({ ...meeting(["decline", "propose"]), endsAt: T0 + 70 * 60_000 }, game(["move", "late"]))));
    await act(async () => answer({ attendees: [{ address: "dana@example.com" }] }));
    await settle();
    expect(mail.drafts).toEqual([]);
    expect((screen.getByRole("button", { name: "Running late…" }) as HTMLButtonElement).disabled).toBe(false);
    // Pressed again, it drafts for the pair as it is: ten minutes shared and the 38 minute drive, where it was 98.
    lifeos.held = null;
    lifeos.attendees = [{ address: "dana@example.com" }];
    fireEvent.click(screen.getByRole("button", { name: "Running late…" }));
    await settle();
    expect(mail.drafts).toEqual([expect.objectContaining({ body: "I'm running about 48 minutes late." })]);
  });

  it("drafts nothing when the clash goes away while Running late reads the people, and says it is gone", async () => {
    let answer: (value: { attendees: { address: string }[] }) => void = () => {};
    lifeos.held = new Promise((resolve) => (answer = resolve));
    const view = (live: ClashMarks) => {
      marks.now = live;
      return <ClashDialog ask={{ id: "ev_a-ev_b", environmentId: "box", clash: overlap() }} onClose={() => {}} />;
    };
    const { rerender } = render(view(marksOf({ clashes: [overlap()], leaves: [] })));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Running late…" }));
    await settle();
    // The meeting moves clear of the game while the people are read. The pair stays on screen for the wait itself.
    rerender(view(marksOf({ clashes: [], leaves: [] })));
    await settle();
    expect(screen.getByRole("dialog", { name: "Two things at once" })).toBeTruthy();
    await act(async () => answer({ attendees: [{ address: "dana@example.com" }] }));
    await settle();
    expect(mail.drafts).toEqual([]);
    expect(screen.getByRole("dialog", { name: "No longer a clash" })).toBeTruthy();
    expect(document.activeElement).toBe(document.querySelector("[data-dialog-cancel]"));
  });

  it("drafts nothing when the later event changes job while Running late reads the people: Mail would open under the old job", async () => {
    let answer: (value: { attendees: { address: string }[] }) => void = () => {};
    lifeos.held = new Promise((resolve) => (answer = resolve));
    const view = (clash: Clash) => {
      marks.now = marksOf({ clashes: [clash], leaves: [] });
      return <ClashDialog ask={{ id: "ev_a-ev_b", environmentId: "box", clash: overlap() }} onClose={() => {}} />;
    };
    const { rerender } = render(view(overlap()));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Running late…" }));
    await settle();
    // The game is filed under Life while the people load; its times and drive are as they were.
    rerender(view(overlap(meeting(["decline", "propose"]), game(["move", "late"], { sector: "life", workspaceId: "ws_life" }))));
    await act(async () => answer({ attendees: [{ address: "dana@example.com" }] }));
    await settle();
    expect(mail.drafts).toEqual([]);
    expect(workViewNow()).toBeNull();
    expect((screen.getByRole("button", { name: "Running late…" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("drafts nothing when the later event ends while Running late reads the people", async () => {
    let answer: (value: { attendees: { address: string }[] }) => void = () => {};
    lifeos.held = new Promise((resolve) => (answer = resolve));
    vi.useFakeTimers({ now: T0 + 3 * HOUR - 5_000, toFake: ["Date"] });
    try {
      show(overlap());
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Running late…" }));
      await settle();
      // The game ends five seconds on; the people arrive after that.
      vi.setSystemTime(T0 + 3 * HOUR + 2_000);
      await act(async () => answer({ attendees: [{ address: "dana@example.com" }] }));
      await settle();
      expect(mail.drafts).toEqual([]);
      expect(screen.getAllByRole("button", { name: "Close" }).every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts focus on Close when Back finds the way he came from gone", async () => {
    vi.useFakeTimers({ now: T0 + HOUR, toFake: ["Date"] });
    try {
      const view = (live: ClashMarks) => {
        marks.now = live;
        return <ClashDialog ask={{ id: "ev_a-ev_b", environmentId: "box", clash: overlap() }} onClose={() => {}} />;
      };
      const { rerender } = render(view(marksOf({ clashes: [overlap()], leaves: [] })));
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Decline" }));
      // The meeting ends while the step is open: Back finds no Decline to return to.
      vi.setSystemTime(T0 + 2 * HOUR + 60_000);
      rerender(view(marksOf({ clashes: [overlap()], leaves: [] })));
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      await settle();
      expect(document.activeElement).toBe(document.querySelector("[data-dialog-cancel]"));
      // And when the clash is gone altogether, the gone state's Close takes it.
      cleanup();
      const again = render(view(marksOf({ clashes: [overlap()], leaves: [] })));
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Move…" }));
      again.rerender(view(marksOf({ clashes: [], leaves: [] })));
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      await settle();
      expect(screen.getByRole("dialog", { name: "No longer a clash" })).toBeTruthy();
      expect(document.activeElement).toBe(document.querySelector("[data-dialog-cancel]"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("says LifeOS is still connecting when Running late is pressed in that wait, never that he is signed out", async () => {
    lifeos.connecting = true;
    show(overlap());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Running late…" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("LifeOS is still connecting");
    expect(mail.drafts).toEqual([]);
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
