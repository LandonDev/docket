// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "../../../lib/connection/registry";
import type { VmState } from "../../../lib/winvmWake";
import { OPEN_SETTINGS_EVENT, peekSettingsRow } from "../../../lib/monaco/debugTab";
import { ComputerBar, DelayButton, FOLD, FOLD_LAST, NO_LIVE_PICTURE, OpenSettingsButton, barSentence, NO_RESIZE, THREAD_HOLDS, ViewButton, delayWords, vmMenuRows, type VmScreenSeam } from "./ComputerBar";
import { tile } from "./FullWindow.fixtures";

const press = vi.hoisted(() => ({ take: null as null | (() => Promise<void>), toasts: [] as { title: string; description?: string }[] }));
vi.mock("../../../lib/computers", async (original) => {
  const actual = await original<typeof import("../../../lib/computers")>();
  return { ...actual, takeOver: (...a: Parameters<typeof actual.takeOver>) => (press.take ? press.take() : actual.takeOver(...a)) };
});
vi.mock("@renderer/components/ui/toaster", async (original) => ({
  ...(await original<typeof import("@renderer/components/ui/toaster")>()),
  loadToast: async () => Object.assign(() => undefined, { error: (title: string, o?: { description?: string }) => void press.toasts.push({ title, description: o?.description }) }),
}));
const confirm = vi.hoisted(() => ({ asked: [] as { title: string; body?: string; action: string }[], yes: true }));
vi.mock("../../../chrome/ConfirmDialog", () => ({ confirmAction: async (r: { title: string; body?: string; action: string }) => (confirm.asked.push(r), confirm.yes) }));

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
            <ViewButton label="Full screen" fold="last" onClick={() => undefined}>
              <span />
            </ViewButton>
          </>
        }
      />,
    );
    const facts = document.querySelector('[data-slot="facts"]')!;
    // the host after another fact is lower case, as every host mid-line is
    expect([...facts.children].map((c) => c.textContent)).toEqual(["Clicking Submit in Chromium", "the box"]);
    // only the step's words cut; a later fact drops whole, its comma with it
    expect(facts.className).toContain("flex-wrap");
    expect(facts.className).toContain("overflow-hidden");
    expect(facts.children[0]!.className).toContain("truncate");
    expect(facts.children[1]!.className).toContain("shrink-0");
    expect(facts.children[1]!.className).toContain("before:content-[',']");
    // the order the eye and Tab take: title, controls, views
    expect(names()).toEqual(["File the March expense report", "Take over", "Stop File the March expense report", "Pop out", "Full screen"]);
    fireEvent.click(screen.getByRole("button", { name: "File the March expense report" }));
    expect(opened).toEqual([["t1", "box"]]);
    // under 640px Pop out gives way, whole; Full screen stays
    expect(screen.getByRole("button", { name: "Pop out" }).className).toContain(FOLD);
    expect(screen.getByRole("button", { name: "Full screen" }).className).not.toContain(FOLD);
    // once the sentence gives way the title has the row
    expect(screen.getByRole("button", { name: "File the March expense report" }).className).toContain("@max-[480px]/bar:max-w-full");
    // under 400px Full screen too: a click on the picture still opens it
    expect(screen.getByRole("button", { name: "Full screen" }).className).toContain(FOLD_LAST);
  });

  it("while he drives: the words in foreground, Hand back alone as the one primary with its key cap, and Keys on the Windows VM", () => {
    render(<ComputerBar tile={vmTile({ driving: true, idle: false })} vm={awake} />);
    expect(screen.getByText("You are driving").className).toContain("text-foreground");
    const back = screen.getByRole("button", { name: /^Hand back/ });
    expect(back.getAttribute("data-variant")).toBe("default");
    expect(back.querySelector("kbd")).not.toBeNull();
    // the key cap gives way under 400px of bar, before the computer's name
    expect(back.querySelector("kbd")!.className).toContain(FOLD_LAST);
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
    // a question then a place would read "…be used?, Landon's MacBook": the strip and the thread say where
    expect([...document.querySelector('[data-slot="facts"]')!.children].map((c) => c.textContent)).toEqual(["Allow Frame.io to be used?"]);
    // Council round 6, sitting E (Sol): under 480px the sentence gives way, so the question keeps a waiting mark there,
    // a keyboard stop named by the question; wider, the sentence says it and the mark stays hidden.
    const mark = document.querySelector<HTMLElement>("[data-bar-asking]")!;
    expect(mark.getAttribute("aria-label")).toBe("Allow Frame.io to be used?");
    expect(mark.tabIndex).toBe(0);
    expect(mark.className).toContain("hidden");
    expect(mark.className).toContain("@max-[480px]/bar:inline-flex");
    expect(document.querySelector('[data-slot="facts"]')!.className).toContain("@max-[480px]/bar:hidden");
    cleanup();
    render(<ComputerBar tile={tile()} />);
    expect(document.querySelector("[data-bar-asking]")).toBeNull();
    cleanup();
    render(<ComputerBar tile={vmTile({ pictureOnly: true })} vm={awake} />);
    expect(screen.getByText(NO_LIVE_PICTURE)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });

  it("says where it runs alone with its capital, and after another fact in lower case", () => {
    expect(barSentence(tile({ doing: null }))).toEqual(["The box"]);
    expect(barSentence(tile(), "This Mac")).toEqual(["Clicking Submit in Chromium", "this Mac"]);
    expect(barSentence(tile(), "Landon's MacBook")).toEqual(["Clicking Submit in Chromium", "Landon's MacBook"]);
    expect(barSentence(tile(), null)).toEqual(["Clicking Submit in Chromium"]);
    expect(barSentence(null)).toEqual([]);
  });

  it("words a failed press in Work's words, never the host's raw text", async () => {
    press.toasts.length = 0;
    press.take = () => Promise.reject(new Error("Cannot read properties of undefined (reading 'drive') at /srv/agents/app/out/main/index.js:12"));
    render(<ComputerBar tile={tile()} />);
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await vi.waitFor(() => expect(press.toasts).toHaveLength(1));
    expect(press.toasts[0]).toEqual({ title: "Couldn't take over", description: "File the March expense report" });
    // a refusal already in a person's words follows the computer's name
    cleanup();
    press.take = () => Promise.reject(new Error("The box refused it"));
    render(<ComputerBar tile={tile()} />);
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await vi.waitFor(() => expect(press.toasts).toHaveLength(2));
    expect(press.toasts[1]).toEqual({ title: "Couldn't take over", description: "File the March expense report: The box refused it" });
    press.take = null;
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

  it("where Windows cannot take a new size, says where to turn it on and opens Screen size on the Windows VM's page", async () => {
    expect(NO_RESIZE).toBe("Set Screen size to Fits my window in Settings, Windows VM");
    const opened: string[] = [];
    const hear = (event: Event) => opened.push((event as CustomEvent<string>).detail);
    window.addEventListener(OPEN_SETTINGS_EVENT, hear);
    render(<ComputerBar tile={vmTile()} vm={awake} screen={seam({ canResize: false })} />);
    fireEvent.click(screen.getByRole("button", { name: "Windows VM" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open Settings" }));
    expect(opened).toEqual(["winvm"]);
    expect(peekSettingsRow()).toBe("winvm.screen");
    // where it can, no such row
    expect(vmMenuRows({ state: "awake", held: false, screen: seam(), may: { admin: true, operate: true } }).some((r) => r.kind === "item" && r.id === "screen-settings")).toBe(false);
    window.removeEventListener(OPEN_SETTINGS_EVENT, hear);
  });

  it("Open Settings for a VM not set up goes to the Windows VM's page, where it is set up", () => {
    const opened: string[] = [];
    const hear = (event: Event) => opened.push((event as CustomEvent<string>).detail);
    window.addEventListener(OPEN_SETTINGS_EVENT, hear);
    render(<OpenSettingsButton />);
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(opened).toEqual(["winvm"]);
    window.removeEventListener(OPEN_SETTINGS_EVENT, hear);
  });

  it("a VM not set up has one press, to Settings, and no menu or Take over", () => {
    render(<ComputerBar tile={vmTile()} vm={{ state: "none", cannot: null, error: null }} action={<button type="button">Open Settings</button>} />);
    expect(names()).toEqual(["Open Settings"]);
  });

  it("Restart Windows… asks first, then restarts it cleanly; the sign-in row brings OneDrive's sign-in up on the VM, as Connections' walk does", async () => {
    const calls: string[] = [];
    vi.spyOn(registry, "linkOf").mockReturnValue({ request: async (method: string) => void calls.push(method) } as never);
    render(<ComputerBar tile={vmTile()} vm={awake} />);
    confirm.yes = false;
    fireEvent.click(screen.getByRole("button", { name: "Windows VM" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restart Windows…" }));
    await act(async () => {});
    expect(confirm.asked.at(-1)).toMatchObject({ title: "Restart Windows?", action: "Restart" });
    expect(calls).toEqual([]);
    confirm.yes = true;
    fireEvent.click(screen.getByRole("button", { name: "Windows VM" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restart Windows…" }));
    await act(async () => {});
    expect(calls).toEqual(["work.winvm.restart"]);
    fireEvent.click(screen.getByRole("button", { name: "Windows VM" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign in to Office and OneDrive…" }));
    await act(async () => {});
    expect(calls).toEqual(["work.winvm.restart", "work.office.vmSignIn"]);
  });

  it("every computer wears it: the box's page with Take over and no VM menu, a Mac's or a PC's window with Stop alone", () => {
    render(<ComputerBar tile={tile()} />);
    expect(document.querySelector("[data-glyph]")!.getAttribute("data-glyph")).toBe("page");
    expect(names()).toEqual(["Take over", "Stop File the March expense report"]);
    expect(screen.queryByRole("button", { name: "Windows VM" })).toBeNull();
    expect(screen.getByRole("button", { name: "Take over" })).not.toBeNull();
    cleanup();
    render(<ComputerBar tile={tile({ browser: false, computer: "window:t2", title: "Tidy the Downloads folder", where: "Landon's MacBook" })} />);
    expect(document.querySelector("[data-glyph]")!.getAttribute("data-glyph")).toBe("window");
    expect(names()).toEqual(["Stop Tidy the Downloads folder"]);
    cleanup();
    render(<ComputerBar tile={vmTile()} vm={awake} />);
    expect(document.querySelector("[data-glyph]")!.getAttribute("data-glyph")).toBe("screen");
  });
});
