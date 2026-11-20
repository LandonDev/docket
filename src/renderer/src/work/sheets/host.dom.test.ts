// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ request: vi.fn(), openUrl: vi.fn() }));
vi.mock("../../lib/connection", () => ({ registry: { linkOf: () => ({ request: h.request, onPush: () => () => {} }) } }));
vi.mock("../../lib/native", () => ({ openUrl: h.openUrl }));

import { linkSheetHost } from "./host";

afterEach(() => {
  document.documentElement.className = "";
  vi.clearAllMocks();
});

describe("the sheet's switch to its other app", () => {
  it("asks for the full editor in light from a light window, names no theme from a dark one, and opens the page it answers", async () => {
    h.request.mockResolvedValue({ opened: true, url: "https://box.example/w/full/tok/" });
    const host = linkSheetHost("env_box", "item1");
    await host.switchApp();
    // Dark is held: the editor follows the browser's system from a dark window, as it did.
    expect(h.request).toHaveBeenLastCalledWith("work.sheets.switch", { itemId: "item1" });
    expect(h.openUrl).toHaveBeenLastCalledWith("https://box.example/w/full/tok/");
    document.documentElement.classList.add("theme-light");
    await host.switchApp();
    expect(h.request).toHaveBeenLastCalledWith("work.sheets.switch", { itemId: "item1", scheme: "light" });
  });

  it("opens nothing itself when the host brought the app forward", async () => {
    h.request.mockResolvedValue({ opened: true });
    await linkSheetHost("local", "item1").switchApp();
    expect(h.openUrl).not.toHaveBeenCalled();
  });
});
