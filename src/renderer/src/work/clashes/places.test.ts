import { describe, expect, it } from "vitest";
import { formChanged, placeWords, rowLabel, savePatch } from "./places";


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
    expect(savePatch("ref", saved, { ...saved, address: ` ${saved.address} ` })).toBeNull();
    expect(formChanged(saved, { ...saved, lookups: false })).toBe(true);
  });

  it("a job's new address alone: that job and nothing of another, so a change made elsewhere is kept", () => {
    expect(savePatch("ref", saved, { ...saved, address: " 2 Gym Ln " })).toEqual({ startFor: { sector: "ref", address: "2 Gym Ln" } });
    expect(savePatch("cosmic", { address: "", lookups: true }, { address: "5 Pine Ave", lookups: true })).toEqual({ startFor: { sector: "cosmic", address: "5 Pine Ave" } });
  });

  it("an emptied address goes as empty, which clears the job's start: it starts from home", () => {
    expect(savePatch("ref", saved, { ...saved, address: "  " })).toEqual({ startFor: { sector: "ref", address: "" } });
  });

  it("the lookups switch alone: that job's, never another job's", () => {
    expect(savePatch("purdue", { address: "", lookups: false }, { address: "", lookups: true })).toEqual({ lookupsFor: { sector: "purdue", on: true } });
    expect(savePatch("ref", saved, { ...saved, lookups: false })).toEqual({ lookupsFor: { sector: "ref", on: false } });
  });

  it("Home sends its address, or null to clear it", () => {
    expect(savePatch("home", { address: "9 Office Rd", lookups: false }, { address: "12 Oak Ct", lookups: false })).toEqual({ homeAddress: "12 Oak Ct" });
    expect(savePatch("home", { address: "9 Office Rd", lookups: false }, { address: "", lookups: false })).toEqual({ homeAddress: null });
  });

  it("sends an emptied address and a flipped switch in one patch, so Use home never drops the switch", () => {
    expect(savePatch("ref", { address: "4 Gym Way", lookups: true }, { address: "", lookups: false })).toEqual({ startFor: { sector: "ref", address: "" }, lookupsFor: { sector: "ref", on: false } });
  });

  it("names a row's button by its verb, whose place and what the row says", () => {
    expect(rowLabel("Purdue", { description: "Cedar Hall, 4 Elm Street" })).toBe("Change Purdue: Cedar Hall, 4 Elm Street");
    expect(rowLabel("Ref", { description: "2 Gym Ln", error: "Not found" })).toBe("Change Ref: 2 Gym Ln, Not found");
    expect(rowLabel("Home", {})).toBe("Change Home");
  });
});
