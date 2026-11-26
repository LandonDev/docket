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
vi.mock("../../lib/linkMay", async (original) => (await import("../../lib/linkMay.testkit")).linkMayMock(await original()));
import { GIVEN_KEY, resetTestKey, testKey } from "../../lib/linkMay.testkit";
// The select's own chunk: the section is tested through its cold trigger's words and the body once it lands.
import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { Page } from "../../components/page";
import { SETTING_GROUPS, SettingsSection, zoneWords } from "./SettingsSection";
import { hostsHold, newestSettings, resetDigestStore, staleSettings, useDigestSheetOpen } from "./store";
import { push, resetWorld, SETTINGS, type World } from "./world.testkit";

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
  resetTestKey();
});

describe("Settings → Work → Digest", () => {
  it("is the time with the zone it follows, then four rows that all start at the same level, and nothing explained under them", async () => {
    render(<SettingsSection />);
    const time = (await screen.findByLabelText("Arrives at")) as HTMLInputElement;
    expect(time.type).toBe("time");
    expect(time.value).toBe("08:00");
    expect(within(screen.getByRole("region", { name: "The day's digest" })).getByText(zoneWords(SETTINGS.zone))).toBeTruthy();
    expect(SETTING_GROUPS).toEqual(["held", "results", "people", "meetings"]);
    const tell = within(screen.getByRole("region", { name: "Tell me about" }));
    expect(tell.getAllByText(/^(Things waiting for me|Routine results|Messages and mail|Meetings)$/).map((el) => el.textContent)).toEqual(["Things waiting for me", "Routine results", "Messages and mail", "Meetings"]);
    // every select reads the default, in his words
    expect(tell.getAllByText("When it can't wait")).toHaveLength(4);
    // no describing line under any level's row: the zone's is the page's one
    expect(document.querySelectorAll("[data-slot=item-description]")).toHaveLength(1);
  });

  it("says the zone by its everyday name", () => {
    expect(zoneWords("America/Chicago")).toBe("Central Time, from the computer you used last");
    expect(zoneWords("Not/AZone")).toBe("Not/AZone, from the computer you used last");
  });

  it("a new time is written to every host with Work on, once it is a whole time and he has stopped typing", async () => {
    render(<SettingsSection />);
    const time = (await screen.findByLabelText("Arrives at")) as HTMLInputElement;
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

  it("never writes to a host this window's key may not set, and with none it may, says the settings as words", async () => {
    // His laptop with the box's given key: the laptop's own Work takes the change, the box is never asked.
    testKey.of = { box: GIVEN_KEY };
    render(<SettingsSection />);
    const time = await screen.findByLabelText("Arrives at");
    fireEvent.change(time, { target: { value: "09:00" } });
    fireEvent.blur(time);
    await waitFor(() => expect(sets()).toHaveLength(1));
    expect(sets()[0]!.env).toBe("mac");
    expect(screen.queryByText(/did not take it/)).toBeNull();
    cleanup();
    testKey.current = GIVEN_KEY;
    render(<SettingsSection />);
    await screen.findByText("Things waiting for me");
    expect(screen.queryByLabelText("Arrives at")).toBeNull();
    expect(screen.queryAllByRole("combobox")).toEqual([]);
    expect(screen.getAllByText("When it can't wait")).toHaveLength(4);
    expect(sets()).toHaveLength(1);
  });

  it("moves a level at once and puts it back when every computer refuses it, the refusal under the row", async () => {
    w().refuses.add("box");
    w().refuses.add("mac");
    render(<SettingsSection />);
    const trigger = await screen.findByRole("combobox", { name: "Routine results" });
    await act(async () => fireEvent.click(trigger));
    const option = await screen.findByRole("option", { name: "Right away" });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option);
    });
    expect(await screen.findByText("The box and The Mac did not take it")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Routine results" }).textContent).toContain("When it can't wait"));
  });

  it("says who can change them to a key that may set none", async () => {
    testKey.current = GIVEN_KEY;
    render(<SettingsSection />);
    await screen.findByText("Things waiting for me");
    expect(document.querySelector("[data-managed]")!.textContent).toMatch(/^Changed from a computer that manages /);
  });

  it("shows what he set: a group he made quieter reads so", async () => {
    w().settings.set("box", { ...SETTINGS, at: "17:30", levels: { results: "digest", held: "now" } });
    w().settings.set("mac", { ...SETTINGS, at: "17:30", levels: { results: "digest", held: "now" } });
    render(<SettingsSection />);
    expect(((await screen.findByLabelText("Arrives at")) as HTMLInputElement).value).toBe("17:30");
    expect(screen.getByText("In the digest")).toBeTruthy();
    expect(screen.getByText("Right away")).toBeTruthy();
    expect(screen.getAllByText("When it can't wait")).toHaveLength(2);
  });

  it("the hosts that refused are the row's red line by name, in his words, and it stays through an edit of another row", async () => {
    w().refuses.add("mac");
    render(<SettingsSection />);
    const time = await screen.findByLabelText("Arrives at");
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

  it("a host that missed a write is brought to each field's newest setting as the section opens, field by field", async () => {
    // The box alone took a new time; later the Mac alone took a new level for Meetings.
    w().settings.set("box", { ...SETTINGS, at: "07:30", levels: {}, setAt: { at: 2_000 } });
    w().settings.set("mac", { ...SETTINGS, at: "08:00", levels: { meetings: "digest" }, setAt: { meetings: 3_000 } });
    render(<SettingsSection />);
    // He sees both of his changes, whichever host answered first.
    expect(((await screen.findByLabelText("Arrives at")) as HTMLInputElement).value).toBe("07:30");
    expect(screen.getByText("In the digest")).toBeTruthy();
    await waitFor(() => expect(sets()).toHaveLength(2));
    // Each host is written only the field it missed, stamped with when it was set: neither change undoes the other.
    expect(sets().map((c) => [c.env, c.params])).toEqual([
      ["box", { levels: { meetings: "digest" }, setAt: { meetings: 3_000 } }],
      ["mac", { at: "07:30", setAt: { at: 2_000 } }],
    ]);
    // Alike now: nothing more is written.
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    expect(sets()).toHaveLength(2);
  });

  it("hosts that agree, or a field no host says when it was set, are left alone", () => {
    const a = { ...SETTINGS, at: "07:00", setAt: { at: 5 } };
    expect(staleSettings([{ environmentId: "box", settings: a }, { environmentId: "mac", settings: { ...a, nextAt: 44, zone: "UTC" } }])).toEqual([]);
    // The same value under an older stamp is still brought to the newer one: going back to an earlier choice is a new edit.
    expect(staleSettings([{ environmentId: "box", settings: a }, { environmentId: "mac", settings: { ...a, setAt: { at: 9 } } }])).toEqual([{ environmentId: "box", patch: { at: "07:00", setAt: { at: 9 } } }]);
    // Differing, but nothing says which was set last.
    expect(staleSettings([{ environmentId: "box", settings: SETTINGS }, { environmentId: "mac", settings: { ...SETTINGS, at: "09:00" } }])).toEqual([]);
    expect(staleSettings([{ environmentId: "box", settings: a }])).toEqual([]);
    // The newest of each field, from whichever host holds it.
    const merged = newestSettings([
      { ...SETTINGS, at: "07:30", setAt: { at: 2 } },
      { ...SETTINGS, at: "06:00", levels: { held: "now", meetings: "digest" }, setAt: { at: 1, held: 4, meetings: 3 } },
    ])!;
    expect(merged).toMatchObject({ at: "07:30", levels: { held: "now", meetings: "digest" }, setAt: { at: 2, held: 4, meetings: 3 } });
    expect(newestSettings([SETTINGS])).toEqual(SETTINGS);
    expect(newestSettings([])).toBeNull();
  });

  it("a refusal's line goes once every host holds what he asked for, whoever wrote it there", async () => {
    w().refuses.add("mac");
    render(<SettingsSection />);
    const time = await screen.findByLabelText("Arrives at");
    fireEvent.change(time, { target: { value: "09:00" } });
    fireEvent.blur(time);
    expect(await screen.findByText("The Mac did not take it")).toBeTruthy();
    // The Mac is back and takes it (a later read brought it into line): its push arrives.
    w().refuses.clear();
    await act(async () => push(w(), "mac", { settings: { ...SETTINGS, at: "09:00", setAt: { at: 9 } } }));
    await waitFor(() => expect(screen.queryByText("The Mac did not take it")).toBeNull());
  });

  it("a host that refused and whose settings were never read keeps its line though the others agree", async () => {
    // The Mac answers nothing at first, then refuses the write: nothing is known of what it holds.
    w().down.add("mac");
    render(<SettingsSection />);
    const time = await screen.findByLabelText("Arrives at");
    fireEvent.change(time, { target: { value: "09:00" } });
    fireEvent.blur(time);
    expect(await screen.findByText("The Mac did not take it")).toBeTruthy();
    // The box holds 09:00 now; the Mac is not known to.
    await act(async () => push(w(), "box", { settings: { ...SETTINGS, at: "09:00", setAt: { at: 9 } } }));
    expect(screen.getByText("The Mac did not take it")).toBeTruthy();
    expect(hostsHold(["mac"], "at", "09:00")).toBe(false);
    expect(hostsHold(["box"], "at", "09:00")).toBe(true);
  });

  it("a time typed while an earlier one is still on its way is not taken back by that one's answer, and is sent once", async () => {
    let answer: (() => void) | null = null;
    w().slow = new Promise<void>((resolve) => (answer = resolve));
    render(<SettingsSection />);
    const time = (await screen.findByLabelText("Arrives at")) as HTMLInputElement;
    fireEvent.change(time, { target: { value: "07:30" } });
    fireEvent.blur(time);
    await waitFor(() => expect(sets()).toHaveLength(2));
    // Leaving the field again does not send 07:30 a second time.
    fireEvent.blur(time);
    expect(sets()).toHaveLength(2);
    // He types another time before the hosts answer; then the first save's push arrives.
    fireEvent.change(time, { target: { value: "06:30" } });
    await act(async () => push(w(), "box", { settings: { ...SETTINGS, at: "07:30", setAt: { at: 7 } } }));
    expect(time.value).toBe("06:30");
    await act(async () => answer!());
    expect(time.value).toBe("06:30");
    w().slow = null;
    await waitFor(() => expect(sets().map((c) => c.params.at)).toEqual(["07:30", "07:30", "06:30", "06:30"]));
  });

  it("going back to the time the hosts still hold, while another is on its way, is his latest edit and is sent after it", async () => {
    let answer: (() => void) | null = null;
    w().slow = new Promise<void>((resolve) => (answer = resolve));
    render(<SettingsSection />);
    const time = (await screen.findByLabelText("Arrives at")) as HTMLInputElement;
    fireEvent.change(time, { target: { value: "07:30" } });
    fireEvent.blur(time);
    await waitFor(() => expect(sets()).toHaveLength(2));
    // Back to 08:00 before any host has confirmed 07:30.
    fireEvent.change(time, { target: { value: "08:00" } });
    fireEvent.blur(time);
    await waitFor(() => expect(sets().map((c) => c.params.at)).toEqual(["07:30", "07:30", "08:00", "08:00"]));
    await act(async () => answer!());
    w().slow = null;
    await waitFor(() => expect(time.value).toBe("08:00"));
  });

  it("a time he typed and left the section before the rest was over is still written", async () => {
    const view = render(<SettingsSection />);
    fireEvent.change(await screen.findByLabelText("Arrives at"), { target: { value: "05:15" } });
    expect(sets()).toHaveLength(0);
    view.unmount();
    await waitFor(() => expect(sets().map((c) => [c.env, c.params.at])).toEqual([["box", "05:15"], ["mac", "05:15"]]));
  });

  it("the time field keeps what he typed until the hosts have answered", async () => {
    let answer: (() => void) | null = null;
    w().slow = new Promise<void>((resolve) => (answer = resolve));
    render(<SettingsSection />);
    const time = (await screen.findByLabelText("Arrives at")) as HTMLInputElement;
    fireEvent.change(time, { target: { value: "06:45" } });
    fireEvent.blur(time);
    await waitFor(() => expect(sets()).toHaveLength(2));
    // Not answered yet: the field does not fall back to 08:00.
    expect(time.value).toBe("06:45");
    await act(async () => answer!());
    await waitFor(() => expect(time.value).toBe("06:45"));
  });

  it("Open the digest stands on the page's title line and opens the list", async () => {
    render(
      <>
        <Page title="Digest">
          <SettingsSection />
        </Page>
        <SheetFlag />
      </>,
    );
    expect(screen.getByTestId("sheet").textContent).toBe("shut");
    const open = await screen.findByRole("button", { name: "Open the digest" });
    expect(open.closest("[data-slot=page-actions]")).toBeTruthy();
    fireEvent.click(open);
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
    expect(screen.queryByLabelText("Arrives at")).toBeNull();
    w().down.clear();
    expect(screen.getByRole("button", { name: "Retry" }).className).toContain("-me-2.5");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(await screen.findByLabelText("Arrives at")).toBeTruthy();
  });
});
