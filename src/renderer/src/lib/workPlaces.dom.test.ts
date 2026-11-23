// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shell, shellStore } from "../stores/shell";
import { placeForDayStart } from "../work/places/registry";
import { shortcutFor } from "./settings";
import { WORK_PLACE_ROWS, workPlaceLabel, workPlaceRow } from "./workPlaces";
import { digestOpensPort } from "./workSwitch";

const at = (day: number, hour = 9) => new Date(2026, 10, day, hour).getTime();

beforeEach(() => localStorage.clear());
afterEach(() => shell.openWorkPlace(null));

describe("the pages above the Work workspaces, as the first paint lists them", () => {
  it("lists Today first, under the name its key is listed by in the Work keybindings", () => {
    expect(WORK_PLACE_ROWS[0]).toMatchObject({ id: "today", label: "Today", order: 10 });
    expect(shortcutFor("Work", WORK_PLACE_ROWS[0].label)).toBeTruthy();
    expect(workPlaceRow("today")?.icon).toBeTruthy();
    expect(workPlaceLabel("today")).toBe("Today");
  });

  it("the digest's notice opens Today", () => {
    digestOpensPort.get()?.();
    expect(shellStore.getState().workPlace).toBe("today");
  });

  it("the key's toggle opens a place and closes it when it is the page on screen", () => {
    shell.toggleWorkPlace("today");
    expect(shellStore.getState().workPlace).toBe("today");
    shell.toggleWorkPlace("today");
    expect(shellStore.getState().workPlace).toBeNull();
    shell.openInbox();
    shell.toggleWorkPlace("today");
    expect(shellStore.getState()).toMatchObject({ workPlace: "today", inboxViewOpen: false });
  });
});

describe("a place that opens at the day's start", () => {
  it("is off unless he set it: nothing opens by itself", () => {
    expect(placeForDayStart(at(23))).toBeNull();
    expect(placeForDayStart(at(24))).toBeNull();
  });

  it("set, it is answered once at the first focus of each day and not again that day", () => {
    localStorage.setItem("work.today.opensAtDayStart", "true");
    expect(placeForDayStart(at(23, 7))).toBe("today");
    expect(placeForDayStart(at(23, 7))).toBeNull();
    expect(placeForDayStart(at(23, 18))).toBeNull();
    expect(placeForDayStart(at(24, 0))).toBe("today");
    // Any other value is off.
    localStorage.setItem("work.today.opensAtDayStart", "yes");
    expect(placeForDayStart(at(25))).toBeNull();
  });
});
