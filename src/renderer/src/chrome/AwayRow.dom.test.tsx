// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../components/ui/tooltip";
import { awayStore, resetAwayForTest } from "../lib/away";
import { registry } from "../lib/connection/registry";
import { clockTime } from "../lib/duration";
import { setWorkOn } from "../lib/workSwitch";
import { AwayRow, awayLabel, awayMenuRows, awayTooltip, pickAway } from "./AwayRow";
import { RailFoot } from "./ProjectRail";

const toast = vi.hoisted(() => ({ error: vi.fn(), call: vi.fn() }));
vi.mock("../components/ui/toaster", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/ui/toaster")>()),
  loadToast: () => Promise.resolve(Object.assign(toast.call, { error: toast.error })),
}));
vi.mock("./UsageMeter", () => ({ UsageMeter: () => null }));
vi.mock("./UpdateRow", () => ({ UpdateRow: () => null, useUpdateRowState: () => null }));
vi.mock("./SignInRow", () => ({ SignInRow: () => null, useSignInTarget: () => null }));
const place = vi.hoisted(() => ({ kind: "code" as "code" | "work", listeners: new Set<() => void>() }));
vi.mock("../lib/placeScheme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/placeScheme")>()),
  currentPlaceKind: () => place.kind,
  onPlaceKind: (l: () => void) => (place.listeners.add(l), () => place.listeners.delete(l)),
}));

/** A primary link that answers `away.set` as `answer` says. */
function primaryLink(answer: (enabled: boolean, params: { code?: boolean; work?: boolean }) => Promise<unknown>) {
  const request = vi.fn((method: string, params: { enabled: boolean; code?: boolean; work?: boolean }) =>
    method === "away.set" ? answer(params.enabled, params) : Promise.reject(new Error("no")),
  );
  vi.spyOn(registry, "linkOf").mockReturnValue({ request } as never);
  return request;
}

const host = (enabled: boolean, at = 1_000) => ({
  [registry.primaryEnvironmentId]: { state: { enabled, at, by: "env_mac" }, decided: { since: at, threads: [] } },
});

const switchRow = () => screen.getByRole("switch", { name: "Away from computer" });
const track = () => document.querySelector<HTMLElement>("[data-slot=away-track]")!;
const glyph = () => switchRow().querySelector<HTMLElement>("svg")!.parentElement!;

beforeEach(() => {
  place.kind = "code";
  setWorkOn(registry.primaryEnvironmentId, false);
  resetAwayForTest();
  vi.spyOn(registry, "onLink").mockReturnValue(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toast.error.mockReset();
  resetAwayForTest();
});

describe("AwayRow", () => {
  it("is one native switch named Away from computer, drawn as Away, off until the host says on", () => {
    render(<AwayRow />);
    const row = switchRow();
    // A native button: Space and Enter press it as a click does.
    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("type")).toBe("button");
    expect(row.getAttribute("aria-checked")).toBe("false");
    // The whole name is cut at the rail's default 200px, so the row draws the short word.
    expect(row.textContent).toBe("Away");
    expect(row.getAttribute("aria-label")).toBe("Away from computer");
    act(() => awayStore.setState({ hosts: host(true) }));
    expect(switchRow().getAttribute("aria-checked")).toBe("true");
  });

  it("takes the warning tone on the track and the moon only while on", () => {
    render(<AwayRow />);
    expect(track().dataset.on).toBe("false");
    expect(track().className).toContain("data-[on=true]:bg-warning");
    expect(glyph().className).not.toContain("text-warning");
    act(() => awayStore.setState({ hosts: host(true) }));
    expect(track().dataset.on).toBe("true");
    expect(glyph().className).toContain("text-warning");
    expect(switchRow().closest("[data-rail-row]")!.className).toContain("text-foreground");
  });

  it("flips at once on a press, Space or Enter, and stays when the host agrees", async () => {
    const request = primaryLink(async (enabled, p) => ({ state: { enabled, code: p.code, work: false, at: 2_000, by: "env_mac" } }));
    render(<AwayRow />);
    fireEvent.keyDown(switchRow(), { key: " " });
    fireEvent.click(switchRow());
    expect(switchRow().getAttribute("aria-checked")).toBe("true");
    expect(request).toHaveBeenCalledWith("away.set", { enabled: false, code: true });
    await act(async () => {});
    expect(switchRow().getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(switchRow(), { key: "Enter" });
    fireEvent.click(switchRow());
    expect(switchRow().getAttribute("aria-checked")).toBe("false");
    expect(request).toHaveBeenLastCalledWith("away.set", { enabled: false, code: false });
  });

  it("rolls back with a toast when the host refuses", async () => {
    primaryLink(() => Promise.reject(new Error("forbidden: needs approve")));
    render(<AwayRow />);
    fireEvent.click(switchRow());
    expect(switchRow().getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't change Away"));
    expect(switchRow().getAttribute("aria-checked")).toBe("false");
    act(() => awayStore.setState({ hosts: host(true) }));
    fireEvent.click(switchRow());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't change Away"));
    expect(switchRow().getAttribute("aria-checked")).toBe("true");
  });

  it("says what it does while off and since when while on, in a tooltip, never a title", () => {
    expect(awayTooltip(false, 0)).toBe("Away from computer: when on, threads decide without asking you");
    const at = new Date(2026, 10, 5, 14, 14).getTime();
    expect(awayTooltip(true, at)).toBe(`Away since ${clockTime(at)}`);
    render(
      <TooltipProvider>
        <AwayRow />
      </TooltipProvider>,
    );
    expect(switchRow().getAttribute("title")).toBeNull();
  });

  it("sits right above Settings in the foot, the collapsed column's foot included", () => {
    render(<RailFoot onAddWorkspace={() => {}} />);
    const rows = [...document.querySelectorAll("[data-rail-row] button")].map((b) => b.textContent);
    expect(rows.slice(-2)).toEqual(["Away", "Settings"]);
  });

  it("draws its track from switch-track.ts, with no Base UI switch", () => {
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    for (const source of [read("./AwayRow.tsx"), read("../components/ui/switch-track.ts"), read("../components/ui/switch.tsx")]) {
      expect(source).not.toMatch(/@base-ui\/react\/switch/);
    }
    expect(read("./AwayRow.tsx")).toContain("components/ui/switch-track");
    expect(read("../components/ui/switch.tsx")).toContain("./switch-track");
  });
});

describe("AwayRow by kind, with Work on", () => {
  const state = (code: boolean, work: boolean, at = 1_000) => ({
    [registry.primaryEnvironmentId]: { state: { enabled: code && work, code, work, at, by: "env_mac" }, decided: { since: at, threads: [] } },
  });
  const theSwitch = () => screen.getByRole("switch");
  let held = { code: false, work: false };
  beforeEach(() => {
    held = { code: false, work: false };
    setWorkOn(registry.primaryEnvironmentId, true);
  });

  it("names the kinds away in words in each of the four states", () => {
    expect(awayLabel({ code: false, work: false })).toBe("Away");
    expect(awayLabel({ code: true, work: false })).toBe("Away for Code");
    expect(awayLabel({ code: false, work: true })).toBe("Away for Work");
    expect(awayLabel({ code: true, work: true })).toBe("Away for both");
    render(<AwayRow />);
    act(() => awayStore.setState({ hosts: state(false, true) }));
    expect(theSwitch().textContent).toBe("Away for Work");
    // In a code place the switch is Code's: off, while the words say Work is away.
    expect(theSwitch().getAttribute("aria-checked")).toBe("false");
    // Its name stays the switch's own (council 5 F1.1): the words say which kinds, not what the switch flips.
    expect(theSwitch().getAttribute("aria-label")).toBe("Away from computer");
  });

  it("a press in a code place flips Code alone; in a Work place, Work alone", async () => {
    const request = primaryLink(async (_e, p) => {
      held = { code: p.code ?? held.code, work: p.work ?? held.work };
      return { state: { enabled: held.code && held.work, ...held, at: 2_000, by: "env_mac" } };
    });
    act(() => awayStore.setState({ hosts: state(false, false) }));
    const { unmount } = render(<AwayRow />);
    fireEvent.click(theSwitch());
    expect(request).toHaveBeenLastCalledWith("away.set", { enabled: false, code: true });
    await act(async () => {});
    unmount();
    place.kind = "work";
    render(<AwayRow />);
    fireEvent.click(theSwitch());
    expect(request).toHaveBeenLastCalledWith("away.set", { enabled: true, work: true });
  });

  it("its menu ticks each kind and offers Both and Off, each doing what it says", async () => {
    expect(awayMenuRows({ code: true, work: false })).toEqual([
      { kind: "item", id: "code", label: "Code threads", checked: true },
      { kind: "item", id: "work", label: "Work threads", checked: false },
      { kind: "sep" },
      { kind: "item", id: "both", label: "Both", disabled: false },
      { kind: "item", id: "off", label: "Off", disabled: false },
    ]);
    const request = primaryLink(async (_e, p) => {
      held = { code: p.code ?? held.code, work: p.work ?? held.work };
      return { state: { enabled: held.code && held.work, ...held, at: 2_000, by: "env_mac" } };
    });
    act(() => awayStore.setState({ hosts: state(false, false) }));
    pickAway("work");
    expect(request).toHaveBeenLastCalledWith("away.set", { enabled: false, work: true });
    pickAway("both");
    expect(request).toHaveBeenLastCalledWith("away.set", { enabled: true, code: true, work: true });
    pickAway("off");
    expect(request).toHaveBeenLastCalledWith("away.set", { enabled: false, code: false, work: false });
    await act(async () => {});
  });

  it("says in its tip which kind the press flips", () => {
    expect(awayTooltip(false, 0, "code")).toBe("Away from computer: when on, Code threads decide without asking you");
    const at = new Date(2026, 10, 5, 14, 14).getTime();
    expect(awayTooltip(true, at, "work")).toBe(`Work threads away since ${clockTime(at)}`);
  });
});

