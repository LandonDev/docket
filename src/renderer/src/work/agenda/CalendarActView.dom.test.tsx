// @vitest-environment jsdom
/** A held LifeOS calendar act: a day read that failed says so with Retry, and Retry asks again; the act's rows stay put. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const day = vi.hoisted(() => ({
  fail: true,
  loading: false,
  asked: 0,
  event: "none" as "none" | "loading" | "failed" | "gone" | "ready",
  // The session's own state: connected and on its way unless a test says it is down.
  session: { state: "connected", withheld: false } as { state: string; withheld: boolean; unanswered?: boolean },
  reopened: [] as string[],
  // The day holds the event itself and nothing else.
  alone: false,
}));
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosSession: () => ({ environmentId: "box", sector: null, client: null, state: day.session.state, ...(day.session.withheld ? { withheld: true } : {}), ...(day.session.unanswered ? { unanswered: true } : {}) }),
  reopenLifeos: async (env: string) => void day.reopened.push(env),
  useLifeosStatus: () => ({ lifeos: { state: day.session.state }, keys: [] }),
  useLifeosQuery: (_s: unknown, name: string) => {
    if (name === "events:get") {
      if (day.event === "loading") return { status: "loading" };
      if (day.event === "failed") return { status: "failed", error: "Server error" };
      return { status: "ready", value: day.event === "ready" ? { _id: "ev1", title: "Kickoff call", sector: "unify", startsAt: Date.UTC(2026, 10, 21, 20), allDay: false } : null };
    }
    if (name !== "events:range") return { status: "ready", value: null };
    if (day.loading) return { status: "loading" };
    if (day.alone) return { status: "ready", value: [{ _id: "ev1", title: "Kickoff call", sector: "unify", startsAt: Date.UTC(2026, 10, 21, 20), allDay: false }] };
    return day.fail ? { status: "failed", error: "Server error" } : { status: "ready", value: [{ _id: "e1", title: "Scrim night", sector: "purdue", startsAt: Date.UTC(2026, 10, 21, 15), allDay: false }] };
  },
}));
vi.mock("../shell/open", () => ({ openConnections: vi.fn(), openWorkSettings: vi.fn() }));
// The sign-in dialog the line's press opens in place (its own chunk, DownSignIn.tsx).
vi.mock("../shell/settings", () => ({ SignInDialog: () => <div role="dialog" aria-label="Sign in to LifeOS" /> }));
const { View } = await import("./CalendarActView");
const { openConnections } = await import("../shell/open");

afterEach(cleanup);

const op = { id: "op1", kind: "create", payload: { title: "Review", startsAt: Date.UTC(2026, 10, 21, 17), endsAt: Date.UTC(2026, 10, 21, 18) } };

describe("a held calendar act's day", () => {
  it("says Couldn't read that day with Retry, which reads it again", () => {
    render(<View item={{ kind: "calendar.op", payload: op, sector: "purdue" } as never} env="box" />);
    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByText("Couldn't read that day")).toBeTruthy();
    day.fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByText("Couldn't read that day")).toBeNull();
    expect(screen.getByText("Scrim night")).toBeTruthy();
  });
});

describe("a held reply's day", () => {
  const reply = { id: "op3", kind: "accept", eventId: "ev1", account: "landon@unify.dev" };
  afterEach(() => void ((day.event = "none"), (day.alone = false), (day.fail = true)));
  it("is drawn only when something besides the event is on it, such as a clash", () => {
    day.event = "ready";
    day.alone = true;
    const { unmount } = render(<View item={{ kind: "calendar.op", payload: reply, sector: "unify" } as never} env="box" />);
    expect(screen.queryByRole("region", { name: "That day" })).toBeNull();
    unmount();
    day.alone = false;
    day.fail = false;
    render(<View item={{ kind: "calendar.op", payload: reply, sector: "unify" } as never} env="box" />);
    expect(screen.getByRole("region", { name: "That day" })).toBeTruthy();
    expect(screen.getByText("Scrim night")).toBeTruthy();
  });
});

describe("a held calendar act's day on its way", () => {
  it("shows the day's bones under the act while LifeOS reads it, so the clash check is seen to be coming", () => {
    day.loading = true;
    render(<View item={{ kind: "calendar.op", payload: op, sector: "purdue" } as never} env="box" />);
    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Reading that day" })).toBeTruthy();
    day.loading = false;
  });
});

describe("a held reply whose event is still being read", () => {
  const reply = { id: "op2", kind: "accept", eventId: "ev1", account: "landon@unify.dev" };
  const draw = () => render(<View item={{ kind: "calendar.op", payload: reply, sector: "unify" } as never} env="box" />);
  afterEach(() => void (day.event = "none"));

  it("draws bones for the event's title and time while LifeOS reads it", () => {
    day.event = "loading";
    const { container } = draw();
    expect([...container.querySelectorAll("[data-field-bones] dt")].map((dt) => dt.textContent)).toEqual(["Event", "When"]);
    expect(screen.getByRole("status", { name: "" }).textContent).toBe("Reading the event");
    // The reply itself is known: it stands under the bones.
    expect(screen.getByText("Yes")).toBeTruthy();
  });

  it("says a failed read in its own line with Retry, which reads it again and fills the facts", () => {
    day.event = "failed";
    day.fail = false;
    const { container } = draw();
    expect(container.querySelector("[data-event-read=failed]")!.textContent).toBe("Couldn't read the eventRetry");
    day.event = "ready";
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(container.querySelector("[data-event-read]")).toBeNull();
    expect(screen.getByText("Kickoff call")).toBeTruthy();
  });

  it("says an event LifeOS no longer has, with no Retry that could not help", () => {
    day.event = "gone";
    const { container } = draw();
    const line = container.querySelector("[data-event-read=gone]")!;
    expect(line.textContent).toBe("The event is no longer in LifeOS");
    expect(line.querySelector("button")).toBeNull();
  });
});

describe("a held invite's guests", () => {
  it("are names with their addresses muted after them, never the mail header's angle brackets", () => {
    day.fail = false;
    const invite = { ...op, payload: { ...op.payload, attendees: [{ name: "Dana Lee", address: "dana.lee@purdue.edu" }, { address: "sam@arena.com" }] } };
    const { container } = render(<View item={{ kind: "calendar.op", payload: invite, sector: "purdue" } as never} env="box" />);
    const dd = [...container.querySelectorAll("dt")].find((dt) => dt.textContent === "Invites")!.nextElementSibling!;
    expect(dd.textContent).toBe("Dana Leedana.lee@purdue.edu, sam@arena.com");
    expect(dd.textContent).not.toContain("<");
    expect(screen.getByText("dana.lee@purdue.edu").className).toContain("text-muted-foreground");
    // An address alone is the guest's only name: drawn in the row's ink.
    expect(screen.getByText("sam@arena.com").className).not.toContain("text-muted-foreground");
  });

  it("wrap inside the value column: between name and address, and within an address too long for a line", () => {
    day.fail = false;
    const long = "events-and-facilities-reservations.recwell@purdue.edu";
    const invite = { ...op, payload: { ...op.payload, attendees: [{ name: "Alexandra Montgomery-Fitzgerald", address: long }] } };
    const { container } = render(<View item={{ kind: "calendar.op", payload: invite, sector: "purdue" } as never} env="box" />);
    const dd = [...container.querySelectorAll("dt")].find((dt) => dt.textContent === "Invites")!.nextElementSibling!;
    expect(dd.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "break-words"]));
    const address = screen.getByText(long);
    expect(address.className.split(" ")).toContain("wrap-anywhere");
    // Nothing between the column and the address holds the line whole.
    for (let el: Element | null = address; el && el !== dd; el = el.parentElement) expect(el.className).not.toContain("whitespace-nowrap");
    // A break may fall between the name and its address.
    expect(address.previousElementSibling?.tagName).toBe("WBR");
  });
});

describe("a held reply whose LifeOS session is down", () => {
  const reply = { id: "op2", kind: "accept", eventId: "ev1", account: "landon@unify.dev" };
  const draw = () => render(<View item={{ kind: "calendar.op", payload: reply, sector: "unify" } as never} env="box" />);
  afterEach(() => {
    day.event = "none";
    day.session = { state: "connected", withheld: false };
    day.reopened = [];
  });

  it("says the session's state once, in place of both reads, with Retry that asks the host for the session again", () => {
    // The queries fail with the session's words, as a session that cannot read fails them.
    day.event = "failed";
    day.fail = true;
    day.session = { state: "unreachable", withheld: false };
    const { container } = draw();
    expect(container.querySelector("[data-event-read]")).toBeNull();
    expect(container.querySelector("[data-day-failed]")).toBeNull();
    const line = container.querySelector("[data-session-down=unreachable]")!;
    expect(line.textContent).toBe("LifeOS did not answerRetry");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(day.reopened).toEqual(["box"]);
    // The reply itself still reads whole.
    expect(screen.getByText("Yes")).toBeTruthy();
  });

  /** Council round 4 (Sol P1): the host's status went unanswered, so the session is down, never bones for good. */
  it("names the computer that did not answer its status, with Retry, in place of the event's bones", async () => {
    const { registry } = await import("../../lib/connection");
    const named = vi.spyOn(registry, "environment").mockReturnValue({ name: "The box" } as never);
    day.event = "failed";
    day.session = { state: "unreachable", withheld: false, unanswered: true };
    const { container } = draw();
    expect(container.querySelector("[data-field-bones]")).toBeNull();
    expect(container.querySelector("[data-session-down=unanswered]")!.textContent).toBe("The box did not answerRetry");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(day.reopened).toEqual(["box"]);
    // Work off and a computer kept from LifeOS name the computer too.
    cleanup();
    day.session = { state: "off", withheld: false };
    // Work off: Open Settings, where the switch is (this window may turn it on).
    expect(draw().container.querySelector("[data-session-down=off]")!.textContent).toBe("Work is off on the boxOpen Settings");
    named.mockRestore();
  });

  it("offers no Retry where asking again cannot help, and Sign in where a sign-in is missing", async () => {
    day.event = "failed";
    day.session = { state: "unreachable", withheld: true };
    const { container, unmount } = draw();
    expect(container.querySelector("[data-session-down=withheld]")!.textContent).toBe("This computer cannot read LifeOS through this host");
    expect(screen.queryByRole("button")).toBeNull();
    unmount();
    day.session = { state: "pairing", withheld: false };
    const pairing = draw();
    // Council round 6: the code ends the wait, where this window may sign the host in.
    expect(pairing.container.querySelector("[data-session-down=pairing]")!.textContent).toBe("The LifeOS sign-in waits for your approvalShow the code");
    pairing.unmount();
    day.session = { state: "signed-out", withheld: false };
    const out = draw();
    expect(out.container.querySelector("[data-session-down=signed-out]")!.textContent).toBe("Not signed in to LifeOSSign in");
    // Council round 7: the press opens the sign-in dialog in place, never Settings where he must press again.
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("dialog", { name: "Sign in to LifeOS" })).toBeTruthy();
    expect(openConnections).not.toHaveBeenCalled();
  });
});
