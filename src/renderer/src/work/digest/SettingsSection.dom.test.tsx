// @vitest-environment jsdom
/**
 * Settings → Work → Digest over two hosts that answer from memory: the
 * time, the four rows, a change written to every host once he has stopped
 * typing, the hosts that refused as the row's red line, and a host that
 * missed a write brought to the newest.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../lib/connection", async (original) => {
  const kit = await import("./world.testkit");
  world.current = kit.makeWorld();
  return kit.connectionMock(world.current as import("./world.testkit").World, await original<object>());
});
// The select's own chunk: the section is tested through its cold trigger's words and the body once it lands.
import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { SETTING_GROUPS, SettingsSection } from "./SettingsSection";
import { newestSettings, resetDigestStore, staleSettings, useDigestSheetOpen } from "./store";
import { resetWorld, SETTINGS, type World } from "./world.testkit";

const w = (): World => world.current as World;
const sets = () => w().calls.filter((c) => c.method === "work.digest.set");

function SheetFlag() {
  return <output data-testid="sheet">{useDigestSheetOpen() ? "open" : "shut"}</output>;
}

beforeEach(() => {
  resetWorld(w());
  resetDigestStore();
  setWorkOn("box", true);
  setWorkOn("mac", true);
});
afterEach(() => {
  cleanup();
  workSwitch.reset();
});

describe("Settings → Work → Digest", () => {
  it("is one section: the time, then four rows that all start at the same level, and nothing explained under them", async () => {
    render(<SettingsSection />);
    const section = within(await screen.findByRole("region", { name: "Digest" }));
    const time = (await section.findByLabelText("Time of the digest")) as HTMLInputElement;
    expect(time.type).toBe("time");
    expect(time.value).toBe("08:00");
    expect(SETTING_GROUPS).toEqual(["held", "results", "people", "meetings"]);
    expect(section.getAllByText(/^(Time|Held items|Routine results|Messages and mail|Meetings)$/).map((el) => el.textContent)).toEqual(["Time", "Held items", "Routine results", "Messages and mail", "Meetings"]);
    // every select reads the default, in his words
    expect(section.getAllByText("When it can't wait")).toHaveLength(4);
    // no describing line under any row
    expect(document.querySelectorAll("[data-slot=item-description]")).toHaveLength(0);
  });

  it("a new time is written to every host with Work on, once it is a whole time and he has stopped typing", async () => {
    render(<SettingsSection />);
    const time = (await screen.findByLabelText("Time of the digest")) as HTMLInputElement;
    // The hour typed a digit at a time: "01:30" is on the way to "10:30", and is never written.
    fireEvent.change(time, { target: { value: "01:30" } });
    fireEvent.change(time, { target: { value: "10:30" } });
    expect(sets()).toHaveLength(0);
    await waitFor(() => expect(sets()).toHaveLength(2));
    expect(sets().map((c) => [c.env, c.params])).toEqual([
      ["box", { at: "10:30" }],
      ["mac", { at: "10:30" }],
    ]);
    await waitFor(() => expect(time.value).toBe("10:30"));
    // leaving the field writes at once
    fireEvent.change(time, { target: { value: "07:30" } });
    fireEvent.blur(time);
    await waitFor(() => expect(sets()).toHaveLength(4));
    expect(sets()[3]!.params).toEqual({ at: "07:30" });
    // a field cleared mid-edit writes nothing
    fireEvent.change(time, { target: { value: "" } });
    fireEvent.blur(time);
    expect(sets()).toHaveLength(4);
  });

  it("shows what he set: a group he made quieter reads so", async () => {
    w().settings.set("box", { ...SETTINGS, at: "17:30", levels: { results: "digest", held: "now" } });
    w().settings.set("mac", { ...SETTINGS, at: "17:30", levels: { results: "digest", held: "now" } });
    render(<SettingsSection />);
    expect(((await screen.findByLabelText("Time of the digest")) as HTMLInputElement).value).toBe("17:30");
    expect(screen.getByText("In the digest")).toBeTruthy();
    expect(screen.getByText("Right away")).toBeTruthy();
    expect(screen.getAllByText("When it can't wait")).toHaveLength(2);
  });

  it("the hosts that refused are the row's red line by name, in his words, and it stays through an edit of another row", async () => {
    w().refuses.add("mac");
    render(<SettingsSection />);
    const time = await screen.findByLabelText("Time of the digest");
    fireEvent.change(time, { target: { value: "09:00" } });
    fireEvent.blur(time);
    expect(await screen.findByText("The Mac did not take it")).toBeTruthy();
    // The link's own error text is never shown.
    expect(screen.queryByText(/forbidden/)).toBeNull();
    w().refuses.add("box");
    fireEvent.change(time, { target: { value: "09:15" } });
    fireEvent.blur(time);
    expect(await screen.findByText("The box and The Mac did not take it")).toBeTruthy();
    // Written everywhere at last: the line goes.
    w().refuses.clear();
    fireEvent.change(time, { target: { value: "09:30" } });
    fireEvent.blur(time);
    await waitFor(() => expect(screen.queryByText(/did not take it/)).toBeNull());
  });

  it("a host that missed a write is brought to the settings set last, as the section opens", async () => {
    w().settings.set("box", { ...SETTINGS, at: "07:00", levels: { results: "digest" }, setAt: 2_000 });
    w().settings.set("mac", { ...SETTINGS, at: "08:00", levels: { held: "now" }, setAt: 1_000 });
    render(<SettingsSection />);
    // The newest is what he sees, whichever host answered first.
    expect(((await screen.findByLabelText("Time of the digest")) as HTMLInputElement).value).toBe("07:00");
    await waitFor(() => expect(sets()).toHaveLength(1));
    expect(sets()[0]).toMatchObject({ env: "mac", params: { at: "07:00", levels: { held: "clock", results: "digest", people: "clock", meetings: "clock" } } });
    // Alike now: nothing more is written.
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(sets()).toHaveLength(1);
  });

  it("hosts that agree, or that were never set, are left alone", () => {
    const a = { ...SETTINGS, at: "07:00", setAt: 5 };
    expect(staleSettings([{ environmentId: "box", settings: a }, { environmentId: "mac", settings: { ...a, setAt: 9, nextAt: 44, zone: "UTC" } }])).toBeNull();
    // Differing, but nothing says which was set last.
    expect(staleSettings([{ environmentId: "box", settings: SETTINGS }, { environmentId: "mac", settings: { ...SETTINGS, at: "09:00" } }])).toBeNull();
    expect(staleSettings([{ environmentId: "box", settings: a }])).toBeNull();
    expect(newestSettings([SETTINGS, a, { ...a, at: "06:00", setAt: 3 }])).toBe(a);
    expect(newestSettings([])).toBeNull();
  });

  it("Open the digest opens the list", async () => {
    render(
      <>
        <SettingsSection />
        <SheetFlag />
      </>,
    );
    expect(screen.getByTestId("sheet").textContent).toBe("shut");
    fireEvent.click(await screen.findByRole("button", { name: "Open the digest" }));
    expect(screen.getByTestId("sheet").textContent).toBe("open");
  });

  it("with no host answering it is one red line with Retry, never a row that pretends", async () => {
    w().down.add("box");
    w().down.add("mac");
    // nothing read before: no last-known settings to show
    resetDigestStore();
    render(<SettingsSection />);
    // In his words, never the link's own error text.
    expect((await screen.findByRole("alert")).textContent).toBe("The box and The Mac did not answer");
    expect(screen.queryByLabelText("Time of the digest")).toBeNull();
    w().down.clear();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(await screen.findByLabelText("Time of the digest")).toBeTruthy();
  });
});
