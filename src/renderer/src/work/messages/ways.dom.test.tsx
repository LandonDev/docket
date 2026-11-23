// @vitest-environment jsdom
/**
 * Threads and the ways in: Start thread and Mention in a thread from a conversation's toolbar, its
 * row's menu and a message's menu (a message's words ride on the chip as its quote), the row's Open
 * in the app and Copy link, a conversation opened from outside the view (OpenWorkView's chat and
 * message), and a search hit that brings its message into view.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextChip } from "@shared/work";
import { openWorkView, workViewNow } from "../../lib/workSwitch";
import { MessagesDataProvider } from "./data";
import { fixtureData, JOB, manyMessages, MESSAGES, type FixtureOptions } from "./fixtures";
import { MessagesScreen, useOpened } from "./MessagesView";
import { patchPage, resetPages } from "./page";
import { StartThreadProvider } from "./threads";

const thread = vi.hoisted(() => ({ open: null as { id: string; title: string; archived?: boolean } | null, chips: [] as { id: string; chip: unknown }[] }));
vi.mock("../../stores/subscriptions", async (original) => ({ ...(await original<object>()), currentActiveSession: () => thread.open }));
vi.mock("../canvas/chips", () => ({ addContextChip: (id: string, chip: unknown) => void thread.chips.push({ id, chip }) }));
vi.mock("../shell/open", () => ({ openConnections: () => {} }));
const native = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("../../lib/native", async (original) => ({ ...(await original<object>()), openUrl: async (url: string) => void native.opened.push(url) }));

const copied: string[] = [];
beforeAll(() => {
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => void copied.push(text) }, configurable: true });
});
beforeEach(() => {
  thread.open = null;
  thread.chips.length = 0;
  native.opened.length = 0;
  copied.length = 0;
});
afterEach(() => {
  cleanup();
  resetPages();
  openWorkView(null);
});

const WS = "ws";
function Opened() {
  useOpened(WS);
  return null;
}
function mount(options: FixtureOptions = {}, chatId: string | null = null) {
  const started: ContextChip[] = [];
  const data = fixtureData(options);
  patchPage(WS, { chatId });
  render(
    <MessagesDataProvider value={data}>
      <StartThreadProvider value={(chip) => void started.push(chip)}>
        <Opened />
        <MessagesScreen workspaceId={WS} job={JOB} narrow={false} />
      </StartThreadProvider>
    </MessagesDataProvider>,
  );
  return { data, started };
}
const row = (name: string): HTMLElement => screen.getAllByRole("option").find((el) => el.getAttribute("aria-label")?.includes(`${name}, `))!;
const block = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-block="${id}"]`);
const pick = async (name: string) => act(async () => fireEvent.click(await screen.findByRole("menuitem", { name })));
const DANA_CHIP = { kind: "chat", label: "Dana Lee in Slack", ref: { at: "lifeos", table: "chats", id: "c_dana" } };

describe("threads about a conversation", () => {
  it("starts a thread from the toolbar with the conversation as a chip", () => {
    const { started } = mount({}, "c_dana");
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));
    expect(started).toEqual([DANA_CHIP]);
  });

  it("offers Start thread, Open in Slack and Copy link on a row's menu, and Mention only with a thread open", async () => {
    const { started } = mount();
    fireEvent.contextMenu(row("Dana Lee"));
    expect(await screen.findByRole("menuitem", { name: "Open in Slack" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Mention in a thread" })).toBeNull();
    await pick("Start thread");
    expect(started).toEqual([DANA_CHIP]);
    fireEvent.contextMenu(row("Dana Lee"));
    await pick("Open in Slack");
    expect(native.opened).toEqual(["https://starboard.slack.com/archives/c_dana"]);
    fireEvent.contextMenu(row("Dana Lee"));
    await pick("Copy link");
    expect(copied).toEqual(["https://starboard.slack.com/archives/c_dana"]);
  });

  it("mentions the conversation in the thread open in the window", async () => {
    thread.open = { id: "th1", title: "Launch week" };
    mount();
    fireEvent.contextMenu(row("Dana Lee"));
    await pick("Mention in a thread");
    await act(async () => {});
    expect(thread.chips).toEqual([{ id: "th1", chip: DANA_CHIP }]);
  });

  it("offers no app for a conversation whose source gives no link", async () => {
    mount();
    fireEvent.contextMenu(row("Jordan Blake"));
    expect(await screen.findByRole("menuitem", { name: "Start thread" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Open in/ })).toBeNull();
  });

  it("starts a thread about one message with its words on the chip, and copies its text", async () => {
    const { started } = mount({}, "c_dana");
    fireEvent.contextMenu(block("c_dana_m4")!);
    await pick("Start thread");
    expect(started).toEqual([{ ...DANA_CHIP, quote: "Can you send me the crash numbers before the review?\nJust the last three builds is fine." }]);
    fireEvent.click(within(block("c_dana_m5")!).getByRole("button", { name: "Message actions" }));
    await pick("Copy text");
    expect(copied).toEqual(["Sure. Here they are: https://dash.starboard.games/crashes?builds=3"]);
  });
});

describe("the ways in", () => {
  it("opens the conversation a sent chip names, once, and clears the ask", () => {
    mount();
    act(() => openWorkView({ workspaceId: WS, view: "messages", chat: "c_builds" }));
    expect(screen.getByRole("log", { name: "Messages" })).toBeTruthy();
    expect(row("#builds").getAttribute("aria-selected")).toBe("true");
    expect(workViewNow()).toEqual({ workspaceId: WS, view: "messages" });
  });

  it("brings a named message into view and marks it for a moment", () => {
    mount();
    act(() => openWorkView({ workspaceId: WS, view: "messages", chat: "c_dana", message: "c_dana_m3" }));
    expect(block("c_dana_m3")!.querySelector("[data-found]")!.getAttribute("data-found")).toBe("on");
    expect(block("c_dana_m3")!.querySelector("[data-found]")!.className).toContain("bg-muted");
  });

  it("reads older pages until it holds the message, then marks it", async () => {
    const long = manyMessages("c_dana", 180);
    const oldest = long[long.length - 3]!._id;
    mount({ messages: { ...MESSAGES, c_dana: long } });
    await act(async () => openWorkView({ workspaceId: WS, view: "messages", chat: "c_dana", message: oldest }));
    await act(async () => {});
    expect(block(oldest)?.querySelector("[data-found]")?.getAttribute("data-found")).toBe("on");
  });

  it("gives up on a message it cannot find and leaves the conversation open", async () => {
    mount();
    await act(async () => openWorkView({ workspaceId: WS, view: "messages", chat: "c_dana", message: "gone" }));
    expect(screen.getByRole("log", { name: "Messages" })).toBeTruthy();
    expect(document.querySelector("[data-found]")).toBeNull();
  });

  it("opens a search hit's message in its conversation", () => {
    mount();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search messages" }), { target: { value: "crash numbers" } });
    fireEvent.click(within(screen.getByRole("listbox", { name: "Search results" })).getAllByRole("option")[0]!);
    expect(block("c_dana_m4")!.querySelector("[data-found]")!.getAttribute("data-found")).toBe("on");
  });
});
