// @vitest-environment jsdom
/** A held LifeOS calendar act: a day read that failed says so with Retry, and Retry asks again; the act's rows stay put. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const day = vi.hoisted(() => ({ fail: true, asked: 0 }));
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosSession: () => ({ environmentId: "box", sector: null, client: null, state: "connected" }),
  useLifeosQuery: (_s: unknown, name: string) => {
    if (name !== "events:range") return { status: "ready", value: null };
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
