import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openingView, openingZoom, PAGES_FROM, TRUE_SIZE_FROM } from "./opening";

describe("the view a styled document opens in on the guest's page", () => {
  it("is Flow under 640px and Pages from 640px", () => {
    expect(openingView(390)).toBe("flow");
    expect(openingView(639)).toBe("flow");
    expect(openingView(640)).toBe("pages");
    expect(openingView(768)).toBe("pages");
  });

  it("fits the sheet to the width until a sheet stands at true size, from 864px", () => {
    expect(openingZoom(390)).toBe("width");
    expect(openingZoom(768)).toBe("width");
    expect(openingZoom(863)).toBe("width");
    expect(openingZoom(864)).toBe(100);
  });

  it("holds the app's own two widths", () => {
    const pane = readFileSync(join(__dirname, "../../renderer/src/work/docs/DocumentCanvas.tsx"), "utf8");
    expect(pane).toContain(`export const PAGES_FROM = ${PAGES_FROM};`);
    expect(pane).toContain(`export const TRUE_SIZE_FROM = ${TRUE_SIZE_FROM};`);
  });
});
