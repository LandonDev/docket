// @vitest-environment jsdom
/**
 * What the council's first round asked of the Messages view, one behaviour a test, over the
 * fixtures' seam: the list's head, keys, failures and Retry; the conversation's held unread mark,
 * its "New" read from the first answer and reached above the first page, its arrivals and keys;
 * files whose ask failed; and the composer acting on whose words the field holds.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRow } from "@shared/work/messages";
import { MessagesDataProvider } from "./data";
import { CHATS, FILE_FAILED, fixtureData, HELD_DRAFT, JOB, manyMessages, MESSAGES, type FixtureOptions } from "./fixtures";
import { MessagesScreen } from "./MessagesView";
import { keepListTop, keepTyped, listTopOf, patchPage, resetPages } from "./page";
import { StartThreadProvider } from "./threads";

vi.mock("../shell/open", () => ({ openConnections: () => {} }));
vi.mock("../../components/ui/toaster", async (original) => ({ ...(await original<object>()), loadToast: async () => Object.assign(() => {}, { error: () => {} }) }));

beforeAll(() => {
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
});
beforeEach(() => resetPages());
afterEach(() => cleanup());

const WS = "ws";
function mount(options: FixtureOptions = {}, chatId: string | null = null, narrow = false) {
  const data = fixtureData(options);
  patchPage(WS, { chatId });
  render(
    <MessagesDataProvider value={data}>
      <StartThreadProvider value={() => {}}>
        <MessagesScreen workspaceId={WS} job={JOB} narrow={narrow} />
      </StartThreadProvider>
    </MessagesDataProvider>,
  );
  return data;
}
const listbox = (): HTMLElement => screen.getByRole("listbox", { name: "Conversations" });
const row = (name: string): HTMLElement => screen.getAllByRole("option").find((el) => el.getAttribute("aria-label")?.includes(`${name}, `))!;
const head = (): HTMLElement => document.querySelector<HTMLElement>("[aria-haspopup='menu']")!;
const block = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-block="${id}"]`)!;
const field = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>("[data-composer] textarea")!;
const composer = (): HTMLElement => document.querySelector<HTMLElement>("[data-composer]")!;
const flush = () => act(async () => {});

describe("the list", () => {
  it("laps a group's faces by 4px, ringed in the row's own fill", () => {
    mount();
    const faces = row("Dana, Omar, Mia").querySelectorAll("[aria-hidden] > span");
    expect(faces[1]!.className).toContain("start-2.5");
    expect(faces[1]!.className).toContain("ring-(--row-fill)");
    expect(row("Dana, Omar, Mia").className).toContain("tc-row");
  });

  it("draws the pane's line with the empty list's own title", () => {
    mount();
    const title = screen.getByText("No conversation open");
    expect(title.className).not.toContain("muted");
  });

  it("shows the job's count beside All and Unread alone, and names Messages while a search runs", () => {
    mount({}, null);
    const unread = String(CHATS.filter((c) => c.unread).length);
    expect(head().textContent).toBe(`Messages${unread}`);
    act(() => patchPage(WS, { filter: "direct" }));
    expect(head().textContent).toBe("Direct");
    act(() => patchPage(WS, { filter: "unread" }));
    expect(head().textContent).toBe(`Unread${unread}`);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "controller" } });
    expect(head().textContent).toBe(`Messages${unread}`);
  });

  it("wears the focus ring until a row is active, and opens the active row's menu from the keys", async () => {
    mount();
    expect(listbox().className).toContain("focus-ring");
    fireEvent.keyDown(listbox(), { key: "ArrowDown" });
    expect(listbox().className).not.toContain("focus-ring");
    expect(listbox().getAttribute("aria-activedescendant")).toBe("chat-row-c_builds");
    // Beside the list the arrow opened #builds, which marked it read: its menu offers Mark unread.
    await act(async () => fireEvent.keyDown(listbox(), { key: "F10", shiftKey: true }));
    expect(await screen.findByRole("menuitem", { name: "Mark unread" })).toBeTruthy();
  });

  it("under 640px moves the active row with the arrows, opens it on Enter, puts the keys on Back, and gives them back to the row", () => {
    mount({}, null, true);
    fireEvent.keyDown(listbox(), { key: "ArrowDown" });
    fireEvent.keyDown(listbox(), { key: "ArrowDown" });
    expect(screen.queryByRole("log")).toBeNull();
    fireEvent.keyDown(listbox(), { key: "Enter" });
    const back = screen.getByRole("button", { name: "Back to Messages" });
    expect(document.activeElement).toBe(back);
    fireEvent.click(back);
    expect(document.activeElement).toBe(listbox());
    expect(listbox().getAttribute("aria-activedescendant")).toBe(`chat-row-${CHATS[1]!._id}`);
  });

  it("says the list did not load when its sources fail, and Retry asks again", () => {
    mount({ empty: true, fail: { sources: 1 } });
    expect(screen.getByText("Messages did not load")).toBeTruthy();
    expect(document.querySelector("[data-row-bones]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText(`No messages in ${JOB} yet`)).toBeTruthy();
  });

  it("offers Retry where the list or a search did not load", () => {
    mount({ fail: { chats: 1, search: 1 } });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getAllByRole("option").length).toBe(CHATS.length);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "controller" } });
    expect(screen.getByText("The search did not run")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("listbox", { name: "Search results" })).toBeTruthy();
  });

  it("keeps hits in one list: one tab stop, the arrows open, the fill on the message opened", () => {
    mount();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "0.9.5" } });
    const results = screen.getByRole("listbox", { name: "Search results" });
    const hits = within(results).getAllByRole("option");
    expect(hits.every((hit) => !hit.hasAttribute("tabindex"))).toBe(true);
    fireEvent.keyDown(results, { key: "ArrowDown" });
    const selected = hits.filter((hit) => hit.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(hits[0]);
  });

  it("keeps the list's scroll place for each filter", () => {
    keepListTop(WS, "all", 480);
    expect(listTopOf(WS, "unread")).toBe(0);
    expect(listTopOf(WS, "all")).toBe(480);
  });
});

describe("the conversation", () => {
  it("keeps his Mark unread until a newer message comes", async () => {
    const data = mount({}, "c_dana");
    expect(data.log.read).toEqual(["c_dana"]);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    await act(async () => fireEvent.click(await screen.findByRole("menuitem", { name: "Mark unread" })));
    await flush();
    expect(data.log.unread).toEqual(["c_dana"]);
    expect(data.log.read).toEqual(["c_dana"]);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    act(() => data.deliver("c_dana", "Dana Lee", "Any update?"));
    await flush();
    expect(data.log.read).toEqual(["c_dana", "c_dana"]);
    vi.restoreAllMocks();
  });

  it("reads older pages to reach New above the first page, and opens there", async () => {
    const long = manyMessages("c_dana", 160);
    const since = long[90]!.sentAt;
    const chats: ChatRow[] = CHATS.map((c) => (c._id === "c_dana" ? { ...c, unread: true, readAt: since, lastInAt: long[0]!.sentAt } : c));
    mount({ chats, messages: { ...MESSAGES, c_dana: long } }, "c_dana");
    await flush();
    await flush();
    const marks = screen.getAllByRole("separator").filter((el) => el.getAttribute("aria-label")?.includes("New"));
    expect(marks).toHaveLength(1);
  });

  it("keeps the toolbar's Back when the conversation does not load under 640px, with Retry", () => {
    mount({ fail: { chat: 1 } }, "c_dana", true);
    expect(screen.getByText("This conversation did not load")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to Messages" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByRole("log", { name: "Messages" })).toBeTruthy();
  });

  it("says nothing of an older page, and says an arrival once, which rises in at the foot", async () => {
    const data = mount({}, "c_dana");
    expect(screen.getByRole("log").getAttribute("aria-live")).toBe("off");
    act(() => data.deliver("c_dana", "Dana Lee", "Any update on the key art?"));
    await flush();
    expect(document.querySelector("[data-arrivals]")!.textContent).toBe("Dana Lee: Any update on the key art?");
    expect(block("c_dana_in1").className).toContain("tc-message-arrives");
  });

  it("moves between messages with the arrows and opens the focused one's menu from the keys; its ⋯ is no tab stop", async () => {
    mount({}, "c_dana");
    const log = screen.getByRole("log");
    expect(within(block("c_dana_m5")).getByRole("button", { name: "Message actions" }).getAttribute("tabindex")).toBe("-1");
    log.focus();
    fireEvent.keyDown(log, { key: "ArrowUp" });
    expect(document.activeElement).toBe(block("c_dana_m10"));
    await act(async () => fireEvent.keyDown(document.activeElement!, { key: "ContextMenu" }));
    expect(await screen.findByRole("menuitem", { name: "Copy text" })).toBeTruthy();
  });

  it("says an ask for files that failed, and asks again on Try again", async () => {
    const data = mount({ requestFails: 1 }, "c_lucas");
    await flush();
    const line = block("c_lucas_m3").querySelector<HTMLElement>("[data-file-failed]")!;
    expect(line.textContent).toContain("LifeOS did not answer");
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Try again" })));
    expect(data.log.requested).toEqual(["c_lucas_m3", "c_lucas_m3"]);
    expect(block("c_lucas_m3").querySelector("[data-file-failed]")).toBeNull();
  });

  it("names a failed file in ink, its way back a control 8px on, and quotes in muted ink", () => {
    mount({ messages: { ...MESSAGES, c_lucas: FILE_FAILED } }, "c_lucas");
    const line = block("c_lucas_m3").querySelector<HTMLElement>("[data-file-failed]")!;
    expect(line.querySelector(".font-medium")!.className).toContain("text-foreground");
    expect(within(line).getByRole("button", { name: "Open in Slack" }).className).not.toContain("text-muted-foreground");
    cleanup();
    mount({}, "c_design");
    expect(block("c_design_m6").innerHTML).not.toContain("faint");
  });
});

describe("the composer", () => {
  it("sends his own words as his own and leaves a waiting draft, which Use draft puts before them", async () => {
    keepTyped(WS, "c_dana", "Mine first");
    const data = mount({ drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    expect(field().value).toBe("Mine first");
    expect(composer().textContent).toContain("Use draft");
    await act(async () => fireEvent.click(within(composer()).getByRole("button", { name: "Send" })));
    expect(data.log.sent).toEqual([{ chatId: "c_dana", text: "Mine first" }]);
    expect(data.log.pressed).toEqual([]);
    expect(composer().textContent).toContain("Drafted in");
    fireEvent.change(field(), { target: { value: "And this" } });
    fireEvent.click(within(composer()).getByRole("button", { name: "Use draft" }));
    expect(field().value).toBe(`${HELD_DRAFT.text}\nAnd this`);
    await act(async () => fireEvent.click(within(composer()).getByRole("button", { name: "Send" })));
    expect(data.log.pressed).toEqual([{ id: HELD_DRAFT.id, text: `${HELD_DRAFT.text}\nAnd this` }]);
  });

  it("leaves the field as he left it when he typed while a Send went, and Undo puts the words back before it", async () => {
    const data = mount({ slow: true }, "c_dana");
    fireEvent.change(field(), { target: { value: "First" } });
    fireEvent.click(within(composer()).getByRole("button", { name: "Send" }));
    fireEvent.change(field(), { target: { value: "Second" } });
    await act(async () => data.release());
    await flush();
    expect(field().value).toBe("Second");
    // Undo is in ink, as Retry is: a control, not a word.
    expect(screen.getByRole("button", { name: "Undo" }).className).not.toContain("text-muted-foreground");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    await flush();
    expect(field().value).toBe("First\nSecond");
  });

  it("ends a copy-only draft's line with why its button is Copy, on a one-line floor of 36px", () => {
    mount({ drafts: { c_playtest: [{ id: "d1", held: false, text: "Thanks!", threadId: null }] } }, "c_playtest");
    expect(composer().textContent).toContain("LifeOS can't reply in Discord yet");
    expect(field().className).toContain("min-h-9");
  });
});
