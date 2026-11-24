/**
 * The full editor's offer and its switch, held to one check over every kind of window (docs/agents/work-sheets.md
 * "Offered where it opens"): the bar's line (excelWaits.tsx `ExcelWaits`) and the tab row's switch (SheetBody.tsx
 * `TabEnd`) both ask fullHere.ts `reachHere`. In every cell the two agree: where the switch is drawn the line names
 * the full editor alone, and a press reaches the host once; where it is not, the line says the computer it opens on,
 * so no line names a press that is not drawn and no switch stands without its line.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SheetReach } from "@shared/contract-work-sheets";
import { canvasItem } from "../canvas/testkit";
import { resetSheetSyncs, syncOf } from "./sync";
import { fakeGrid, fakeSheetHost, sheetView, workbookOf, type FakeSheetHost } from "./testkit";

/** The window's link to the box: its key's capabilities, as the host's hello said them. */
const link = vi.hoisted(() => ({ caps: [] as string[] }));
vi.mock("../../lib/connection", async (original) => {
  const real = await original<typeof import("../../lib/connection")>();
  // The real registry, with the key's capabilities and the host's name this test gives it.
  const registry = Object.assign(Object.create(real.registry) as typeof real.registry, {
    statusOf: (id: string) => ({ ...real.registry.statusOf(id), lastHello: { caps: link.caps } }),
    environment: () => ({ name: "the box" }),
  });
  return { ...real, registry };
});

import { TabEnd } from "./SheetBody";
import { ExcelWaits } from "./excelWaits";

const ADMIN = ["read", "operate", "approve", "admin"];

/** Each kind of window: the link it reaches the workbook's host by, whether it is the desktop app, and its key. */
const WINDOWS = {
  "the host's own window": { env: "local", desktop: true, caps: [] as string[] },
  "his own computer's window, an owner's key": { env: "env_box", desktop: true, caps: ADMIN },
  "a given computer's window, its key": { env: "env_box", desktop: true, caps: ["read", "operate", "approve"] },
  "a read key's window": { env: "env_box", desktop: true, caps: ["read"] },
  "the browser at /ui, on the host": { env: "local", desktop: false, caps: ADMIN },
  "the browser at /ui, to the box": { env: "env_box", desktop: false, caps: ADMIN },
} as const;
type Window = keyof typeof WINDOWS;

/** Where the switch is offered, by the rule: the desktop app, and from another computer only an admin key where the box's page reaches beyond it. */
const OFFERED: Record<Window, { carried: boolean; notCarried: boolean }> = {
  "the host's own window": { carried: true, notCarried: true },
  "his own computer's window, an owner's key": { carried: true, notCarried: false },
  "a given computer's window, its key": { carried: false, notCarried: false },
  "a read key's window": { carried: false, notCarried: false },
  "the browser at /ui, on the host": { carried: false, notCarried: false },
  "the browser at /ui, to the box": { carried: false, notCarried: false },
};

const BOOK = workbookOf([{ id: "budget", name: "Budget", rows: [["Item"]] }]);
const ITEM = canvasItem("s1", { kind: "sheet", title: "Budget.xlsx", source: { at: "file", host: "env_box", path: "/work/Budget.xlsx" } });

let sheetHost: FakeSheetHost;

function draw(window: Window, carried: boolean) {
  const kind = WINDOWS[window];
  link.caps = [...kind.caps];
  if (kind.desktop) (globalThis.window as { api?: unknown }).api = { app: { openFullEditor: async () => {} } };
  else delete (globalThis.window as { api?: unknown }).api;
  const reach: SheetReach = { parts: ["a pivot table"], to: "full", ...(carried ? { carried: true } : {}) };
  sheetHost = fakeSheetHost(sheetView({ store: "package", reach }), BOOK);
  const drawn = render(
    <div>
      <ExcelWaits reach={reach} store="package" env={kind.env} />
      <TabEnd {...({ env: kind.env, item: ITEM, host: sheetHost, grid: fakeGrid() } as never)} />
    </div>,
  );
  // The kind's Body opens the item; here the test does, on the sync TabEnd made for it.
  const stop = syncOf(`${kind.env}\n${ITEM.id}`, () => {
    throw new Error("TabEnd made no sync");
  }).start();
  onTestFinished(stop);
  return drawn;
}

beforeEach(() => resetSheetSyncs());
afterEach(() => {
  cleanup();
  resetSheetSyncs();
  delete (globalThis.window as { api?: unknown }).api;
});

describe("the full editor's line and switch agree in every window", () => {
  const cells = (Object.keys(WINDOWS) as Window[]).flatMap((window) => [true, false].map((carried) => [window, carried] as const));

  it.each(cells)("%s, the box's page carried beyond it: %s", async (window, carried) => {
    draw(window, carried);
    const offered = OFFERED[window][carried ? "carried" : "notCarried"];
    const line = await waitFor(() => document.querySelector("[data-sheet-waits]")!.textContent);
    // The switch is drawn once the sync holds the host's view: wait for that, then read both.
    await waitFor(() => expect(syncOf(`${WINDOWS[window].env}\n${ITEM.id}`, () => null as never).state.view).not.toBeNull());
    if (offered) {
      const tabs = await screen.findByRole("tablist", { name: "Open in" });
      expect(line).toBe("A pivot table opens in the full editor");
      fireEvent.click(within(tabs).getByRole("tab", { name: "Full editor" }));
      await waitFor(() => expect(sheetHost.calls.filter((c) => c[0] === "switch")).toHaveLength(1));
    } else {
      expect(screen.queryByRole("tablist", { name: "Open in" })).toBeNull();
      expect(line).toBe("A pivot table opens in the full editor on the box");
      expect(sheetHost.calls.filter((c) => c[0] === "switch")).toHaveLength(0);
    }
  });
});
