import { describe, expect, it } from "vitest";
import type { SheetReach } from "@shared/contract-work-sheets";
import { reachHere } from "./fullHere";

const full: SheetReach = { parts: ["a pivot table"], to: "full", carried: true };
const desk = (caps: string[], carry = true) => ({ carry, caps: () => caps as never });

describe("where the full editor is offered", () => {
  it("in the desktop app on the box itself, and from another computer with an admin key where the box's page reaches beyond it", () => {
    expect(reachHere(full, "local", desk([]))).toBe(full);
    expect(reachHere(full, "box", desk(["read", "operate", "approve", "admin"]))).toBe(full);
  });

  it("not in a browser, not for a key short of admin, not where the box's page stays on the box", () => {
    expect(reachHere(full, "local", desk(["admin"], false))).toBeUndefined();
    expect(reachHere(full, "box", desk(["read", "operate", "approve"]))).toBeUndefined();
    expect(reachHere({ parts: ["macros"], to: "full" }, "box", desk(["admin"]))).toBeUndefined();
  });

  it("leaves Excel's and Google's switch as it was", () => {
    const excel: SheetReach = { parts: ["macros"], to: "excel" };
    expect(reachHere(excel, "box", desk([], false))).toBe(excel);
    expect(reachHere(undefined, "box", desk(["admin"]))).toBeUndefined();
  });
});
