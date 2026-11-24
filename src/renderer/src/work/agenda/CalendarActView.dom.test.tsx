// @vitest-environment jsdom
/** A held LifeOS calendar act: a day read that failed says so with Retry, and Retry asks again; the act's rows stay put. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const day = vi.hoisted(() => ({ fail: true, loading: false, asked: 0, event: "none" as "none" | "loading" | "failed" | "gone" | "ready" }));
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosSession: () => ({ environmentId: "box", sector: null, client: null, state: "connected" }),
  useLifeosQuery: (_s: unknown, name: string) => {
    if (name === "events:get") {
      if (day.event === "loading") return { status: "loading" };
      if (day.event === "failed") return { status: "failed", error: "Server error" };
      return { status: "ready", value: day.event === "ready" ? { _id: "ev1", title: "Kickoff call", sector: "unify", startsAt: Date.UTC(2026, 10, 21, 20), allDay: false } : null };
    }
    if (name !== "events:range") return { status: "ready", value: null };
    if (day.loading) return { status: "loading" };
    return day.fail ? { status: "failed", error: "Server error" } : { status: "ready", value: [{ _id: "e1", title: "Scrim night", sector: "purdue", startsAt: Date.UTC(2026, 10, 21, 15), allDay: false }] };
  },
}));
const { View } = await import("./CalendarActView");

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
});
