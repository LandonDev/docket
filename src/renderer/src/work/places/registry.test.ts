import { describe, expect, it } from "vitest";
import { WORK_PLACE_ROWS, workPlaceLabel, workPlaceRows } from "../../lib/workPlaces";
import { placeChunk, WORK_PLACES } from "./registry";

describe("the pages above the Work workspaces", () => {
  it("every row in the rail has a place of the same id", () => {
    for (const row of WORK_PLACE_ROWS) expect(WORK_PLACES[row.id], row.id).toBeDefined();
  });

  it("no two rows share an id or an order, and the rail lists them by order", () => {
    expect(new Set(WORK_PLACE_ROWS.map((row) => row.id)).size).toBe(WORK_PLACE_ROWS.length);
    expect(new Set(WORK_PLACE_ROWS.map((row) => row.order)).size).toBe(WORK_PLACE_ROWS.length);
    const orders = workPlaceRows().map((row) => row.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it("a place has one chunk for the life of the window, and an unknown id has none", () => {
    expect(placeChunk("today")).toBe(placeChunk("today"));
    expect(placeChunk("nowhere")).toBeNull();
  });

  it("a place whose row has not landed is named by its id", () => {
    expect(workPlaceLabel("nowhere")).toBe("Nowhere");
  });

  it("every place's chunk exports a View", async () => {
    for (const id of Object.keys(WORK_PLACES)) {
      const module = await placeChunk(id)!.load();
      expect(typeof module.View, id).toMatch(/function|object/);
    }
  }, 60_000);
});
