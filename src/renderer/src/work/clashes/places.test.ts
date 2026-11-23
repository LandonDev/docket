import { describe, expect, it } from "vitest";
import { fieldsOf, formChanged, placeWords, rowLabel, sameField, savePatch, tidyAddress } from "./places";


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

  it("a place found only as its town's centre keeps what he typed and says where its drives start", () => {
    expect(placeWords({ address: "4 Elm St, Cedar Falls, IN", label: "Cedar Falls, IN", state: "found", rough: true }, "purdue")).toEqual({ description: "4 Elm St, Cedar Falls, IN, using the town centre" });
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

  it("reads an address as LifeOS keeps it: runs of spaces as one, so what comes back is what went", () => {
    expect(tidyAddress("  9   Oak  St ")).toBe("9 Oak St");
    expect(formChanged({ address: "9 Oak St", lookups: true }, { address: "9  Oak St", lookups: true })).toBe(false);
    expect(savePatch("ref", saved, { ...saved, address: "9   Oak  St" })).toEqual({ startFor: { sector: "ref", address: "9 Oak St" } });
    expect(savePatch("home", { address: "", lookups: false }, { address: " 9  Oak St", lookups: false })).toEqual({ homeAddress: "9 Oak St" });
  });

  it("knows the fields a patch set, to see in a later read that it landed", () => {
    expect(fieldsOf({ startFor: { sector: "ref", address: "9 Oak St" }, lookupsFor: { sector: "ref", on: false } })).toEqual({ address: "9 Oak St", lookups: false });
    expect(fieldsOf({ homeAddress: null })).toEqual({ address: "" });
    expect(fieldsOf({ lookupsFor: { sector: "purdue", on: true } })).toEqual({ lookups: true });
    expect([sameField("9  Oak St", "9 Oak St"), sameField(true, true), sameField(true, false), sameField("a", undefined)]).toEqual([true, true, false, false]);
  });

  it("names a row's button by its verb, whose place and what the row says", () => {
    expect(rowLabel("Purdue", { description: "Cedar Hall, 4 Elm Street" })).toBe("Change Purdue: Cedar Hall, 4 Elm Street");
    expect(rowLabel("Ref", { description: "2 Gym Ln", error: "Not found" })).toBe("Change Ref: 2 Gym Ln, Not found");
    expect(rowLabel("Home", {})).toBe("Change Home");
  });
});
