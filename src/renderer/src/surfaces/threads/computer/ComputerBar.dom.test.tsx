// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../../lib/connection/registry";
import type { VmState } from "../../../lib/winvmWake";
import { ComputerBar, DelayButton, FOLD, NO_LIVE_PICTURE, NO_RESIZE, THREAD_HOLDS, ViewButton, delayWords, vmMenuRows, type VmScreenSeam } from "./ComputerBar";
import { tile } from "./FullWindow.fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const awake: VmState = { state: "awake", cannot: null, error: null };
const vmTile = (over: Parameters<typeof tile>[0] = {}) =>
  tile({ title: "Windows VM", doing: null, browser: false, computer: "vm:windows", idle: true, pane: "vm:windows", entry: { ...tile().entry, previewKey: "vm:windows", row: { ...tile().entry.row, threadId: "vm:windows" } }, ...over });
const seam = (over: Partial<VmScreenSeam> = {}): VmScreenSeam => ({ screen: "fit", detail: "sharp", canResize: true, onPick: () => undefined, ...over });
const names = (): string[] => screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");

describe("the computer's bar", () => {
  it("a thread's computer: its title goes to the thread, its step and where it runs follow, then Take over, Stop and the views", () => {
    const opened: [string, string][] = [];
    render(
      <ComputerBar
        tile={tile()}
        onOpenSession={(t, h) => opened.push([t, h])}
        views={
          <>
            <ViewButton label="Pop out" fold onClick={() => undefined}>
              <span />
            </ViewButton>
            <ViewButton label="Full screen" onClick={() => undefined}>
              <span />
            </ViewButton>
          </>
        }
      />,
    );
    const facts = document.querySelector('[data-slot="facts"]')!;
    expect([...facts.children].map((c) => c.textContent)).toEqual(["Clicking Submit in Chromium", "The box"]);
    // the order the eye and Tab take: title, controls, views
    expect(names()).toEqual(["File the March expense report", "Take over", "Stop File the March expense report", "Pop out", "Full screen"]);
    fireEvent.click(screen.getByRole("button", { name: "File the March expense report" }));
    expect(opened).toEqual([["t1", "box"]]);
    // under 640px Pop out gives way, whole; Full screen stays
    expect(screen.getByRole("button", { name: "Pop out" }).className).toContain(FOLD);
    expect(screen.getByRole("button", { name: "Full screen" }).className).not.toContain(FOLD);
  });

  it("while he drives: the words in foreground, Hand back alone as the one primary with its key cap, and Keys on the Windows VM", () => {
    render(<ComputerBar tile={vmTile({ driving: true, idle: false })} vm={awake} />);
    expect(screen.getByText("You are driving").className).toContain("text-foreground");
    const back = screen.getByRole("button", { name: /^Hand back/ });
    expect(back.getAttribute("data-variant")).toBe("default");
    expect(back.querySelector("kbd")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    expect(screen.getByRole("button", { name: "Keys" }).getAttribute("data-variant")).toBe("ghost");
    // the VM's own name is no link: no thread to go to
    expect(screen.queryByRole("button", { name: "Windows VM" })?.closest('[data-slot="computer-reads"]')).not.toBeNull();
    cleanup();
    render(<ComputerBar tile={tile({ driving: true, doing: null })} />);
    expect(screen.queryByRole("button", { name: "Keys" })).toBeNull();
  });

  it("a card's question leads in foreground; a VM with no live picture says why it has no Take over", () => {
    render(<ComputerBar tile={tile({ entry: { ...tile().entry, row: { ...tile().entry.row, asking: { line: "Allow Frame.io to be used?" } } } })} />);
    expect(screen.getByText("Allow Frame.io to be used?").className).toContain("text-foreground");
    cleanup();
    render(<ComputerBar tile={vmTile({ pictureOnly: true })} vm={awake} />);
    expect(screen.getByText(NO_LIVE_PICTURE)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });

  it("draws no delay until the stream has a number; then a quiet number that opens to what it is made of", async () => {
    render(<ComputerBar tile={tile()} reading={{}} />);
    expect(document.querySelector('[data-slot="computer-delay"]')).toBeNull();
    cleanup();
    render(<ComputerBar tile={tile()} reading={{ delayMs: 31.4, fps: 60, picture: { width: 2912, height: 1868, scale: 2 }, link: "good" }} />);
    const delay = screen.getByRole("button", { name: "Delay 31 ms, details" });
    expect(delay.textContent).toBe("31 ms");
    expect(delay.className).toContain("text-muted-foreground");
    expect(delay.className).toContain(FOLD);
    fireEvent.click(delay);
    const rows = await screen.findAllByRole("term");
    expect(rows.map((r) => `${r.textContent}: ${r.nextElementSibling!.textContent}`)).toEqual(["Delay: 31 ms", "Frames: 60 a second", "Picture: 2912 × 1868, 200%", "Link: Good"]);
  });

  it("on a poor link the number gives way to two words; opened, it says why and offers Faster", async () => {
    const faster = vi.fn();
    render(<DelayButton reading={{ delayMs: 212, fps: 22, link: "poor" }} onFaster={faster} />);
    expect(delayWords({ delayMs: 212, link: "poor" })).toBe("Link poor");
    const button = screen.getByRole("button", { name: "Link poor, details" });
    expect(button.className).toContain("text-foreground");
    fireEvent.click(button);
    expect(await screen.findByText("The link is slow")).not.toBeNull();
    // the heading says the link once: no Link row beside it
    expect(screen.getAllByRole("term").map((t) => t.textContent)).toEqual(["Delay", "Frames"]);
    fireEvent.click(screen.getByRole("button", { name: "Use Faster" }));
    expect(faster).toHaveBeenCalledTimes(1);
  });

  it("the VM's menu: Size and Detail, then Sleep, Restart, the sign-in and the restore points, reached by keys", async () => {
    render(<ComputerBar tile={vmTile()} vm={awake} screen={seam()} />);
    const menu = screen.getByRole("button", { name: "Windows VM" });
    menu.focus();
    fireEvent.click(menu);
    await screen.findAllByRole("menuitemcheckbox");
    const items = [...document.querySelectorAll('[role^="menuitem"]')];
    expect(items.map((m) => m.textContent)).toEqual(["Fit to window", "1280 × 800", "1920 × 1200", "2560 × 1600", "Sharp", "Faster", "Sleep", "Restart Windows…", "Sign in to Office and OneDrive…", "Restore points…"]);
    expect(within(document.body).getAllByRole("menuitemcheckbox").filter((m) => m.getAttribute("aria-checked") === "true").map((m) => m.textContent)).toEqual(["Fit to window", "Sharp"]);
    // the menu is a keyboard's too: arrows move through its rows
    await act(async () => {});
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("role")).toMatch(/menuitem/);
  });

  it("Size and Detail are off with their reason as the row's line: while a thread drives it, or where Windows cannot take a new size", () => {
    const may = { admin: true, operate: true };
    const held = vmMenuRows({ state: "awake", held: true, screen: seam(), may });
    const size = held.filter((r) => r.kind === "item" && (r.id.startsWith("screen:") || r.id.startsWith("detail:")));
    expect(size.every((r) => r.kind === "item" && r.disabled && r.reason === THREAD_HOLDS)).toBe(true);
    expect(held.find((r) => r.kind === "item" && r.id === "restart")).toMatchObject({ disabled: true, reason: THREAD_HOLDS });
    const fixed = vmMenuRows({ state: "awake", held: false, screen: seam({ canResize: false }), may });
    expect(fixed.find((r) => r.kind === "item" && r.id === "screen:fit")).toMatchObject({ disabled: true, reason: NO_RESIZE });
    // a host that does not say its screen has no Size or Detail at all; a key that may not change it neither
    expect(vmMenuRows({ state: "awake", held: false, screen: null, may }).some((r) => r.kind === "label")).toBe(false);
    expect(vmMenuRows({ state: "awake", held: false, screen: seam(), may: { admin: false, operate: true } }).some((r) => r.kind === "label")).toBe(false);
    // a key that may only watch: the restore points alone
    expect(vmMenuRows({ state: "awake", held: false, screen: seam(), may: { admin: false, operate: false } }).map((r) => (r.kind === "item" ? r.id : r.kind))).toEqual(["points"]);
    // asleep: no Sleep and no Restart
    expect(vmMenuRows({ state: "asleep", held: false, screen: null, may }).map((r) => (r.kind === "item" ? r.id : r.kind))).toEqual(["sign-in", "points"]);
  });

  it("a pick of Size or Detail goes to the host's seam; Sleep and Restart (after its confirm) to the host", async () => {
    const picks: unknown[] = [];
    const calls: string[] = [];
    vi.spyOn(registry, "linkOf").mockReturnValue({ request: async (method: string) => void calls.push(method) } as never);
    render(<ComputerBar tile={vmTile()} vm={awake} screen={seam({ onPick: (p) => picks.push(p) })} />);
    fireEvent.click(screen.getByRole("button", { name: "Windows VM" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "1920 × 1200" }));
    fireEvent.click(screen.getByRole("button", { name: "Windows VM" }));
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Faster" }));
    expect(picks).toEqual([{ screen: "1920x1200" }, { detail: "faster" }]);
    fireEvent.click(screen.getByRole("button", { name: "Windows VM" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sleep" }));
    await act(async () => {});
    expect(calls).toEqual(["work.winvm.sleep"]);
  });

  it("a VM not set up has one press, to Settings, and no menu or Take over", () => {
    render(<ComputerBar tile={vmTile()} vm={{ state: "none", cannot: null, error: null }} action={<button type="button">Open Settings</button>} />);
    expect(names()).toEqual(["Open Settings"]);
  });
});
