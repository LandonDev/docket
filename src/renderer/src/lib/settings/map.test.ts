import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS } from "../settings";
import { SETTINGS_MAP, hasSetting, settingEntry, settingTitle, settingWords, settingsOnPage, type SettingPage } from "./map";

describe("the settings map", () => {
  it("gives every row one id", () => {
    const ids = SETTINGS_MAP.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts every row on a page that exists", () => {
    const pages = new Set<SettingPage>([...SETTINGS_SECTIONS.map((section) => section.id), "computer:*", "job", "workspace"]);
    for (const entry of SETTINGS_MAP) expect(pages.has(entry.page), entry.id).toBe(true);
  });

  it("lists rows for every page of the list", () => {
    for (const section of SETTINGS_SECTIONS) expect(settingsOnPage(section.id).length, section.id).toBeGreaterThan(0);
    for (const page of ["computer:*", "job", "workspace"] as const) expect(settingsOnPage(page).length, page).toBeGreaterThan(0);
  });

  it("gives a stored setting one home: no two settings on one page share a name in a section", () => {
    const seen = new Set<string>();
    for (const entry of SETTINGS_MAP) {
      const key = `${entry.page}|${entry.section}|${entry.title}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it("says where each moved setting was: a setting that is kept somewhere has an old home or is new by name", () => {
    // New in Settings 2, or a second door to a control that did not move (Away: the rail's switch stands).
    const NEW = new Set(["appearance.theme", "defaults.reset", "sub.reset", "away.code", "away.work"]);
    for (const entry of SETTINGS_MAP) {
      if ((entry.kind ?? "setting") !== "setting" || NEW.has(entry.id)) continue;
      expect(entry.was.length, entry.id).toBeGreaterThan(0);
    }
  });

  it("fills a name's placeholders in this window's words", () => {
    expect(settingTitle("general.awake")).toBe("Keep this Mac awake");
    expect(settingTitle("general.awake", { mac: "this PC" })).toBe("Keep this PC awake");
    expect(settingTitle("pc.may", { computer: "the box" })).toBe("What the box may do on this Mac");
    expect(settingWords("{computer} on {mac}", { computer: "the box" })).toBe("The box on this Mac");
    expect(settingTitle("defaults.different", { n: 2 })).toBe("Different in 2 places");
    expect(settingTitle("reviews.different", { n: 1 })).toBe("Different in 1 project");
    expect(settingTitle("updates.version", { version: "1.0.400" })).toBe("Docket 1.0.400");
    expect(settingTitle("updates.version")).toBe("Docket");
  });

  it("refuses a row the map lacks", () => {
    expect(hasSetting("here.atOnce")).toBe(true);
    expect(hasSetting("nope")).toBe(false);
    expect(() => settingEntry("nope")).toThrow(/No setting "nope"/);
  });
});
