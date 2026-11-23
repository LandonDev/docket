import { describe, expect, it } from "vitest";
import { formChanged, placeWords, rowLabel, savePatch, type StartSettings } from "./places";

const settings: StartSettings = { homeAddress: "9 Office Rd", starts: { ref: "Cedar Hall, 4 Elm St, Cedar Falls, IN", unify: "1 Mill St" }, placeLookups: { purdue: false } };

describe("a start place's words", () => {
  it("a job with no start of its own starts from home; Home with none is not set", () => {
    expect(placeWords({ state: "none" }, "ref")).toEqual({ description: "Home" });
    expect(placeWords({ state: "none" }, "home")).toEqual({ description: "Not set" });
  });

  it("says Looking up… until LifeOS has placed it, then the map's name", () => {
    expect(placeWords({ address: "9 Office Rd", state: "looking" }, "home")).toEqual({ description: "Looking up…" });
    expect(placeWords({ address: "9 office rd", label: "9 Office Road, Cedar Falls", state: "found" }, "ref")).toEqual({ description: "9 Office Road, Cedar Falls" });
    expect(placeWords({ address: "9 Office Rd", state: "found" }, "ref")).toEqual({ description: "9 Office Rd" });
  });

  it("a place the map did not find keeps its address and says Not found in red", () => {
    expect(placeWords({ address: "9 Ofice Rd", state: "failed" }, "purdue")).toEqual({ description: "9 Ofice Rd", error: "Not found" });
  });
});

describe("what a Save sends", () => {
  const saved = { address: "Cedar Hall, 4 Elm St, Cedar Falls, IN", lookups: true };

  it("nothing while the form is as LifeOS holds it, spaces at the ends aside", () => {
    expect(formChanged(saved, { ...saved, address: ` ${saved.address} ` })).toBe(false);
    expect(savePatch("ref", saved, { ...saved, address: ` ${saved.address} ` }, settings)).toBeNull();
    expect(formChanged(saved, { ...saved, lookups: false })).toBe(true);
  });

  it("a job's new address: the whole starts map, changed at its one key", () => {
    expect(savePatch("ref", saved, { ...saved, address: " 2 Gym Ln " }, settings)).toEqual({ starts: { ref: "2 Gym Ln", unify: "1 Mill St" } });
    expect(savePatch("cosmic", { address: "", lookups: true }, { address: "5 Pine Ave", lookups: true }, settings)).toEqual({ starts: { ref: settings.starts!.ref, unify: "1 Mill St", cosmic: "5 Pine Ave" } });
  });

  it("an emptied address leaves the job out, so it starts from home", () => {
    expect(savePatch("ref", saved, { ...saved, address: "  " }, settings)).toEqual({ starts: { unify: "1 Mill St" } });
  });

  it("the lookups switch: the whole placeLookups map, changed at its one key", () => {
    expect(savePatch("purdue", { address: "", lookups: false }, { address: "", lookups: true }, settings)).toEqual({ placeLookups: { purdue: true } });
    expect(savePatch("ref", saved, { ...saved, lookups: false }, settings)).toEqual({ placeLookups: { purdue: false, ref: false } });
  });

  it("Home sends its address, or null to clear it", () => {
    expect(savePatch("home", { address: "9 Office Rd", lookups: false }, { address: "12 Oak Ct", lookups: false }, settings)).toEqual({ homeAddress: "12 Oak Ct" });
    expect(savePatch("home", { address: "9 Office Rd", lookups: false }, { address: "", lookups: false }, settings)).toEqual({ homeAddress: null });
  });

  it("sends an emptied address and a flipped switch in one patch, so Use home never drops the switch", () => {
    expect(savePatch("ref", { address: "4 Gym Way", lookups: true }, { address: "", lookups: false }, settings)).toEqual({ starts: { unify: "1 Mill St" }, placeLookups: { ...settings.placeLookups, ref: false } });
  });

  it("names a row's button by its verb, whose place and what the row says", () => {
    expect(rowLabel("Purdue", { description: "Cedar Hall, 4 Elm Street" })).toBe("Change Purdue: Cedar Hall, 4 Elm Street");
    expect(rowLabel("Ref", { description: "2 Gym Ln", error: "Not found" })).toBe("Change Ref: 2 Gym Ln, Not found");
    expect(rowLabel("Home", {})).toBe("Change Home");
  });
});
