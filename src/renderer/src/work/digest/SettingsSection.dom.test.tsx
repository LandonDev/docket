// @vitest-environment jsdom
/**
 * Settings → Work → Digest over two hosts that answer from memory: the
 * time, the three rows, a change written to every host, a host that
 * refused as the row's red line.
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
import { resetDigestStore, useDigestSheetOpen } from "./store";
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
  it("is one section: the time, then three rows that all start at the same level, and nothing explained under them", async () => {
    render(<SettingsSection />);
    const section = within(await screen.findByRole("region", { name: "Digest" }));
    const time = (await section.findByLabelText("Time of the digest")) as HTMLInputElement;
    expect(time.type).toBe("time");
    expect(time.value).toBe("08:00");
    expect(SETTING_GROUPS).toEqual(["held", "results", "people"]);
    expect(section.getAllByText(/^(Time|Held items|Routine results|Messages and mail)$/).map((el) => el.textContent)).toEqual(["Time", "Held items", "Routine results", "Messages and mail"]);
    // every select reads the default, in his words
    expect(section.getAllByText("When it can't wait")).toHaveLength(3);
    // no describing line under any row
    expect(document.querySelectorAll("[data-slot=item-description]")).toHaveLength(0);
  });

  it("a new time is written to every host with Work on, once it is a whole time", async () => {
    render(<SettingsSection />);
    const time = (await screen.findByLabelText("Time of the digest")) as HTMLInputElement;
    fireEvent.change(time, { target: { value: "07:30" } });
    await waitFor(() => expect(sets()).toHaveLength(2));
    expect(sets().map((c) => [c.env, c.params])).toEqual([
      ["box", { at: "07:30" }],
      ["mac", { at: "07:30" }],
    ]);
    await waitFor(() => expect(time.value).toBe("07:30"));
    // a field cleared mid-edit writes nothing
    fireEvent.change(time, { target: { value: "" } });
    expect(sets()).toHaveLength(2);
  });

  it("shows what he set: a group he made quieter reads so", async () => {
    w().settings.set("box", { ...SETTINGS, at: "17:30", levels: { results: "digest", held: "now" } });
    w().settings.set("mac", { ...SETTINGS, at: "17:30", levels: { results: "digest", held: "now" } });
    render(<SettingsSection />);
    expect(((await screen.findByLabelText("Time of the digest")) as HTMLInputElement).value).toBe("17:30");
    expect(screen.getByText("In the digest")).toBeTruthy();
    expect(screen.getByText("Right away")).toBeTruthy();
    expect(screen.getAllByText("When it can't wait")).toHaveLength(1);
  });

  it("a host that refused is the row's red line, naming the host", async () => {
    w().refuses.add("mac");
    render(<SettingsSection />);
    fireEvent.change(await screen.findByLabelText("Time of the digest"), { target: { value: "09:00" } });
    expect(await screen.findByText("The Mac did not take it: forbidden: needs admin")).toBeTruthy();
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
    expect((await screen.findByRole("alert")).textContent).toBe("socket closed");
    expect(screen.queryByLabelText("Time of the digest")).toBeNull();
    w().down.clear();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(await screen.findByLabelText("Time of the digest")).toBeTruthy();
  });
});
