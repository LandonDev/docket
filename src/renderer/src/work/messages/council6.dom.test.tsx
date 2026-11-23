// @vitest-environment jsdom
/**
 * What the council's sixth round asked of the Messages view, one behaviour a test, over the
 * fixtures' seam: Down from a departed Unread row opens the row in its place; a press of this
 * composer that failed owns the line; a refused held press leaves the field his own; a file asked
 * for opens though its row scrolled away; widening hands the keys on from a failed reader; one
 * clear handler for the search; the Outbox quote's Retry keeps the keys; and the smaller lines.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatRow } from "@shared/work/messages";
import { MessagesDataProvider, type ThreadDraft } from "./data";
import { CHATS, fixtureData, HELD_DRAFT, JOB, MESSAGES, type FixtureOptions } from "./fixtures";
import { MessagesScreen } from "./MessagesView";
import { pageOf, patchPage, peekReturn, resetPages } from "./page";
import { StartThreadProvider } from "./threads";

vi.mock("work-kit/mail/lib/bytes", () => ({ loadBytes: async () => new Blob(["x"], { type: "image/png" }) }));
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
  URL.createObjectURL = () => "blob:picture";
  URL.revokeObjectURL = () => {};
  Element.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => resetPages());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const WS = "ws";
function screenOf(data: ReturnType<typeof fixtureData>, narrow = false) {
  return (
    <MessagesDataProvider value={data}>
      <StartThreadProvider value={() => {}}>
        <MessagesScreen workspaceId={WS} job={JOB} narrow={narrow} />
      </StartThreadProvider>
    </MessagesDataProvider>
  );
}
function mount(options: FixtureOptions = {}, chatId: string | null = null, narrow = false) {
  const data = fixtureData(options);
  patchPage(WS, { chatId });
  const view = render(screenOf(data, narrow));
  return { data, view };
}
const field = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>("[data-composer] textarea")!;
const composer = (): HTMLElement => document.querySelector<HTMLElement>("[data-composer]")!;
const failedLine = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-draft-failed]");
const flush = () => act(async () => {});
const enter = () => fireEvent.keyDown(field(), { key: "Enter" });
const conversations = () => screen.getByRole("listbox", { name: "Conversations" });
const block = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-block="${id}"]`);
const SECOND: ThreadDraft = { id: "held_2", held: true, text: "Also: the trailer cut is in the shared folder.", threadId: "t_trailer", thread: "Trailer cut" };

describe("Down from a departed Unread row, beside the conversation", () => {
  it("opens the row that took its place, then the next, so no conversation is skipped", async () => {
    const unread = new Set(["c_builds", "c_dana", "c_trio", "c_priya"]);
    mount({ chats: CHATS.map((c) => ({ ...c, unread: unread.has(c._id) })) });
    act(() => patchPage(WS, { filter: "unread" }));
    const first = within(conversations()).getAllByRole("option")[0]!.id.replace("chat-row-", "");
    fireEvent.click(within(conversations()).getAllByRole("option")[0]!);
    await flush();
    const opened = [first];
    for (let i = 0; i < 2; i++) {
      fireEvent.keyDown(conversations(), { key: "ArrowDown" });
      await flush();
      opened.push(pageOf(WS).chatId!);
    }
    expect(opened).toEqual(["c_builds", "c_dana", "c_trio"]);
  });
});

describe("a press of this composer that failed owns the line", () => {
  it("shows May have gone. for that item, with its Open in Outbox, while another held draft waits", async () => {
    const { data } = mount({ pressFails: "LifeOS did not answer in time", pressUnknown: true, lingers: true, drafts: { c_dana: [HELD_DRAFT, SECOND] } }, "c_dana");
    enter();
    await flush();
    const line = failedLine()!;
    expect(line.textContent).toContain("May have gone.");
    expect(line.textContent).toContain(HELD_DRAFT.thread!);
    expect(composer().textContent).not.toContain("Drafted in");
    fireEvent.click(within(line).getByRole("button", { name: "Open in Outbox" }));
    expect(data.log.outbox).toEqual([`box:host:${HELD_DRAFT.id}`]);
    // Opened there, the other draft's line comes back.
    expect(composer().textContent).toContain(`Drafted in${SECOND.thread}`);
  });
});

describe("a file he asked to open", () => {
  it("opens once stored though its row scrolled out of the column's window", async () => {
    const { data } = mount({}, "c_lucas");
    await flush();
    fireEvent.click(within(block("c_lucas_m3")!).getByRole("button", { name: /starboard-0\.9\.5-linux\.zip, on its way/ }));
    // Forty messages arrive at the foot: the file's message leaves the drawn window.
    const note = "the nightly log for the launcher, nothing to see yet. ".repeat(6);
    for (let i = 0; i < 40; i++) act(() => data.deliver("c_lucas", "Lucas Grey", `Build note ${i}: ${note}`));
    await flush();
    expect(block("c_lucas_m3")).toBeNull();
    act(() => data.storeFile("c_lucas", "c_lucas_m3", "f_zip", "https://lifeos.example.dev/api/storage/zip"));
    await flush();
    expect(data.log.opened).toEqual([{ chatId: "c_lucas", messageId: "c_lucas_m3", file: "f_zip", verb: "save" }]);
    // Settled once: another change opens nothing more.
    act(() => data.deliver("c_lucas", "Lucas Grey", "One more."));
    await flush();
    expect(data.log.opened).toHaveLength(1);
  });

  it("a picture still on its way opens once its bytes are stored", async () => {
    const pic: ChatMessage = { _id: "pic", who: { name: "Ana Ruiz", me: false }, text: "", sentAt: Date.now(), files: [{ _id: "f1", name: "banner.png", contentType: "image/png", width: 800, height: 400, status: "wanted" }] };
    const { data } = mount({ messages: { ...MESSAGES, c_art: [pic] } }, "c_art");
    await flush();
    const button = within(block("pic")!).getByRole("button", { name: "View banner.png" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    expect(data.log.opened).toEqual([]);
    act(() => data.storeFile("c_art", "pic", "f1", "https://lifeos.example.dev/api/storage/banner"));
    await flush();
    expect(data.log.opened).toEqual([{ chatId: "c_art", messageId: "pic", file: "f1", verb: "view" }]);
  });
});

describe("widening with Back focused from a reader that failed", () => {
  it("hands the keys to the list holding its row, found by the conversation's id", async () => {
    const { data, view } = mount({ fail: { chat: 1 } }, null, true);
    fireEvent.keyDown(conversations(), { key: "ArrowDown" });
    fireEvent.keyDown(conversations(), { key: "Enter" });
    expect(screen.getByText("This conversation did not load")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back to Messages" }));
    view.rerender(screenOf(data, false));
    await flush();
    expect(document.activeElement).toBe(conversations());
  });

  it("with no row for it in the list, hands them to Retry", async () => {
    const chats: ChatRow[] = CHATS.map((c) => ({ ...c, unread: c._id === "c_builds" }));
    const { data, view } = mount({ chats, fail: { chat: 1 } }, null, true);
    act(() => patchPage(WS, { filter: "unread" }));
    act(() => patchPage(WS, { chatId: "c_priya" }));
    await flush();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back to Messages" }));
    view.rerender(screenOf(data, false));
    await flush();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry" }));
  });
});

describe("the search field's one clear", () => {
  it("drops the way back on Escape, as on new words", () => {
    mount({ searchFails: ["broken words"] }, null, true);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "controller" } });
    const results = screen.getByRole("listbox", { name: "Search results" });
    fireEvent.keyDown(results, { key: "ArrowDown" });
    fireEvent.keyDown(results, { key: "Enter" });
    act(() => patchPage(WS, { query: "broken words" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to Messages" }));
    expect(peekReturn(WS)).not.toBeUndefined();
    const box = screen.getByRole("searchbox");
    box.focus();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(peekReturn(WS)).toBeUndefined();
    expect(pageOf(WS).query).toBe("");
    // The rows that come back find no way back to take: the keys stay in the search field.
    expect(document.activeElement).toBe(box);
  });
});

describe("the failed line's smaller points", () => {
  it("wraps rather than cutting its reasons, puts the reason 10px after the name, and its status region speaks it as it changes", async () => {
    mount({ pressFails: "Slack said the thread is archived", lingers: true, drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    const status = document.querySelector("[data-press-status]")!;
    expect(status.textContent).toBe("");
    enter();
    await flush();
    expect(document.querySelector("[data-press-status]")).toBe(status);
    expect(status.textContent).toBe(`Not sent. ${HELD_DRAFT.thread}. Slack said the thread is archived.`);
    const line = failedLine()!;
    expect(line.className).toContain("flex-wrap");
    // Round 7 (Opus C1): the 10px is the line's gap, not a margin that travels with a wrapped reason.
    expect(line.className).toContain("gap-x-2.5");
    expect(within(line).getByText("Slack said the thread is archived").className).not.toContain("ms-1");
  });
});
