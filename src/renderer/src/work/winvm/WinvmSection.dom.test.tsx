// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WinvmPoint, WinvmState } from "@shared/contract-work-winvm";
import { registry } from "../../lib/connection";
import { WinvmSection, WinvmWorkspaceRow, evaluationLine, winvmRow } from "./WinvmSection";

const h = vi.hoisted(() => ({ screen: "1280x800", state: null as unknown, points: [] as unknown[], calls: [] as { method: string; params: unknown }[], pushes: [] as ((p: unknown) => void)[], confirm: true }));
vi.mock("../../chrome/ConfirmDialog", async (original) => ({ ...(await original<typeof import("../../chrome/ConfirmDialog")>()), confirmAction: async () => h.confirm }));

const at = (s: Partial<WinvmState>): WinvmState => ({ state: "asleep", step: null, error: null, cannot: null, sleepAfter: "30m", since: 1, ...s });
const flush = () => act(async () => {});

beforeEach(() => {
  h.screen = "1280x800";
  h.state = at({});
  h.points = [];
  h.calls = [];
  h.pushes = [];
  h.confirm = true;
  vi.spyOn(registry, "linkOf").mockImplementation(
    () =>
      ({
        request: async (method: string, params: unknown) => {
          h.calls.push({ method, params });
          if (method === "work.winvm.state") return h.state;
          if (method === "work.winvm.points") return { points: h.points };
          if (method === "work.winvm.settings") {
            const next = (params as { screen?: string }).screen;
            if (next) h.screen = next;
            return { sleepAfter: "30m", screen: h.screen };
          }
          return null;
        },
        onPush: (fn: (p: unknown) => void) => (h.pushes.push(fn), () => undefined),
        onOpen: () => () => undefined,
      }) as never,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const pressed = () => h.calls.filter((c) => !["work.winvm.state", "work.winvm.points", "work.winvm.settings"].includes(c.method)).map((c) => c.method);

describe("the Windows VM in Settings → Work", () => {
  it("says its state in a few words with the one press that fits", () => {
    expect(winvmRow(at({ state: "none" }))).toEqual({ words: "Not set up", press: "setup", busy: false });
    expect(winvmRow(at({ state: "asleep" }))).toMatchObject({ words: "Asleep", press: "wake" });
    expect(winvmRow(at({ state: "awake" }))).toMatchObject({ words: "Awake", press: "sleep" });
    expect(winvmRow(at({ state: "setting-up", step: "Copying the service in" }))).toEqual({ words: "Copying the service in", press: null, busy: true });
    expect(winvmRow(at({ state: "waking", step: "Waking the Windows VM" }))).toMatchObject({ press: null, busy: true });
    expect(evaluationLine("2027-02-17")).toMatch(/^Windows 11 Enterprise evaluation, ends about .*2027$/);
  });

  it("shows nothing on a host that cannot have it", async () => {
    h.state = at({ state: "none", cannot: "The Windows VM runs on the box." });
    const { container } = render(<WinvmSection hosts={["mac"]} />);
    await flush();
    expect(container.textContent).toBe("");
  });

  it("sets it up with one press, and offers nothing else until it is", async () => {
    h.state = at({ state: "none" });
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    expect(screen.getByText("Not set up")).not.toBeNull();
    expect(screen.queryByText("Restore points")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    await flush();
    expect(pressed()).toEqual(["work.winvm.setup"]);
    // the keeper's push moves the row on
    act(() => h.pushes.forEach((p) => p({ push: "work.winvm", state: at({ state: "setting-up", step: "Making the disk" }) })));
    expect(screen.getByText("Making the disk")).not.toBeNull();
  });

  it("wakes it, sets when it sleeps, and goes back to a point only after a confirm", async () => {
    h.points = [{ id: "p1", name: "Before setup", at: Date.now() - 60_000, by: "keeper" } satisfies WinvmPoint];
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Wake" }));
    await flush();
    expect(pressed()).toEqual(["work.winvm.wake"]);
    fireEvent.click(screen.getByRole("button", { name: "Restore points" }));
    await flush();
    h.confirm = false;
    fireEvent.click(screen.getByRole("button", { name: "Go back…" }));
    await flush();
    expect(pressed()).toEqual(["work.winvm.wake"]);
    h.confirm = true;
    fireEvent.click(screen.getByRole("button", { name: "Go back…" }));
    await flush();
    expect(h.calls.at(-1)).toEqual({ method: "work.winvm.point.restore", params: { id: "p1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save a point" }));
    await flush();
    expect(h.calls.at(-1)?.method).toBe("work.winvm.point.save");
  });

  it("sets the screen size from the two offered, taken at the next wake", async () => {
    h.state = at({ state: "awake" });
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    const pick = screen.getByRole("combobox", { name: "Screen size" });
    expect(pick.textContent).toContain("1280 × 800");
    // an awake machine keeps the size it woke with
    expect(screen.getByText("From the next wake")).not.toBeNull();
    await act(async () => {
      fireEvent.click(pick);
    });
    const option = await screen.findByRole("option", { name: "1920 × 1200" });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option);
    });
    expect(h.calls).toContainEqual({ method: "work.winvm.settings", params: { screen: "1920x1200" } });
    expect(screen.getByRole("combobox", { name: "Screen size" }).textContent).toContain("1920 × 1200");
  });

  it("offers no screen size before it is set up, and says no wake while it sleeps", async () => {
    h.state = at({ state: "none" });
    const v = render(<WinvmSection hosts={["box"]} />);
    await flush();
    expect(screen.queryByRole("combobox", { name: "Screen size" })).toBeNull();
    v.unmount();
    h.state = at({ state: "asleep" });
    render(<WinvmSection hosts={["box"]} />);
    await flush();
    expect(screen.getByRole("combobox", { name: "Screen size" })).not.toBeNull();
    expect(screen.queryByText("From the next wake")).toBeNull();
  });

  it("gives a workspace its switch only where its host has the VM set up", async () => {
    const change = vi.fn(async () => true);
    h.state = at({ state: "none" });
    const v = render(<WinvmWorkspaceRow env="box" on={false} onChange={change} />);
    await flush();
    expect(screen.queryByRole("switch")).toBeNull();
    v.unmount();
    h.state = at({ state: "asleep" });
    render(<WinvmWorkspaceRow env="box" on={false} onChange={change} />);
    await flush();
    fireEvent.click(screen.getByRole("switch", { name: "Computer use on the Windows VM" }));
    await flush();
    expect(change).toHaveBeenCalledWith(true);
  });
});
