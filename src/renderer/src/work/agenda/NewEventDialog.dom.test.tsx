// @vitest-environment jsdom
/** New event says before the press when no calendar of the job takes events, with Add off; a refusal with no words of its own names the act. */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const lifeos = vi.hoisted(() => ({
  sources: undefined as unknown[] | undefined,
  save: vi.fn(async (_args: unknown): Promise<string> => "op1"),
  convex: {},
}));
vi.mock("convex/react", async (original) => ({
  ...(await original<object>()),
  useQuery: () => lifeos.sources,
  useMutation: () => lifeos.save,
  useConvex: () => lifeos.convex,
  ConvexProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("../jobName", () => ({ jobNameNow: (sector: string) => (sector === "purdue" ? "Purdue Esports" : sector) }));

const { NewEventDialog } = await import("./NewEventDialog");

afterEach(() => {
  cleanup();
  lifeos.sources = undefined;
  lifeos.save.mockClear();
});

const add = () => screen.getByRole("button", { name: "Add" });

describe("New event", () => {
  // Council round 1 (R1-B18): no fields to fill and no Add that cannot work, only the line and Cancel.
  it("with no calendar of the job that takes events, says so with Cancel alone", () => {
    lifeos.sources = [{ _id: "s2", kind: "gcal", account: "a@b.c", sector: "ref", enabled: true }];
    render(<NewEventDialog sector="purdue" startsAt={null} onClose={() => {}} />);
    expect(document.querySelector("[data-no-calendar]")?.textContent).toBe("Purdue Esports has no calendar that takes new events.");
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Event" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("gives Day a row of its own where the three fields do not fit, From and To together under it (council round 9)", () => {
    render(<NewEventDialog sector="purdue" startsAt={null} onClose={() => {}} />);
    const when = document.querySelector("[data-event-when]")!;
    // The dialog's own width decides (a container query): one row from 420px, the room the day in words needs beside two times, else Day over the two times.
    expect(when.className).toContain("@container/when");
    const grid = when.firstElementChild!;
    expect(grid.className.split(" ")).toEqual(expect.arrayContaining(["grid-cols-2", "@[420px]/when:grid-cols-[minmax(0,1fr)_120px_120px]"]));
    // Council round 1 (R1-B17): From and To sit 16px under Day, as every field under the one before.
    expect(grid.className.split(" ")).toEqual(expect.arrayContaining(["gap-x-2", "gap-y-4"]));
    const [day, from, to] = [...grid.children];
    expect(day.textContent).toContain("Day");
    expect(day.className.split(" ")).toEqual(expect.arrayContaining(["col-span-2", "@[420px]/when:col-span-1"]));
    expect([from.textContent, to.textContent]).toEqual(["From", "To"]);
  });

  it("says nothing of calendars while LifeOS reads them, and draws no example words in Event or Invite", () => {
    render(<NewEventDialog sector="purdue" startsAt={null} onClose={() => {}} />);
    expect(document.querySelector("[data-no-calendar]")).toBeNull();
    expect(add().hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("textbox", { name: "Invite" }).getAttribute("placeholder")).toBeNull();
    // Nor an example title: grey words in an empty field read as typed.
    expect(screen.getByRole("textbox", { name: "Event" }).getAttribute("placeholder")).toBeNull();
  });

  it("with a calendar, Add is on; a refusal with no words of its own says LifeOS did not add the event", async () => {
    lifeos.sources = [{ _id: "s1", kind: "gcal", account: "a@b.c", sector: "purdue", enabled: true }];
    lifeos.save.mockRejectedValueOnce(new Error("work.lifeos.call failed at /srv/x/y"));
    render(<NewEventDialog sector="purdue" startsAt={null} onClose={() => {}} />);
    expect(document.querySelector("[data-no-calendar]")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Event" }), { target: { value: "Walk the hall" } });
    fireEvent.click(add());
    await waitFor(() => expect(screen.getByText("LifeOS did not add the event")).toBeTruthy());
  });

  /** Council round 8 (Sol, Tasks 1 P1): a session that drops with the form open never takes what he typed. */
  it("keeps what he typed and the calendars it read through a session that drops, says its line, and holds Add until it reads again", async () => {
    lifeos.sources = [{ _id: "s1", kind: "gcal", account: "a@b.c", sector: "purdue", enabled: true }];
    const reads = { environmentId: "box", sector: "purdue" as const, client: {} as never, state: "connected" as const };
    const down = { environmentId: "box", sector: "purdue" as const, client: null, state: "signed-out" as const };
    const view = render(<NewEventDialog sector="purdue" startsAt={null} session={reads} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Event" }), { target: { value: "Walk the hall" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Invite" }), { target: { value: "sam@purdue.edu" } });
    await act(async () => view.rerender(<NewEventDialog sector="purdue" startsAt={null} session={down} onClose={() => {}} />));
    expect((screen.getByRole("textbox", { name: "Event" }) as HTMLInputElement).value).toBe("Walk the hall");
    expect((screen.getByRole("textbox", { name: "Invite" }) as HTMLInputElement).value).toBe("sam@purdue.edu");
    expect(document.querySelector('[data-session-down="signed-out"]')).toBeTruthy();
    expect(document.querySelector("[data-no-calendar]")).toBeNull();
    expect(screen.getByRole("button", { name: "Send invites" }).hasAttribute("disabled")).toBe(true);
    await act(async () => view.rerender(<NewEventDialog sector="purdue" startsAt={null} session={reads} onClose={() => {}} />));
    expect(document.querySelector("[data-session-down]")).toBeNull();
    expect(screen.getByRole("button", { name: "Send invites" }).hasAttribute("disabled")).toBe(false);
  });
});
