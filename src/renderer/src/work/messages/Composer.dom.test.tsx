// @vitest-environment jsdom
/**
 * The composer at a conversation's foot, over the fixtures' seam: his own Send with Undo, a failed
 * reply's Retry, a refusal in LifeOS's words, the way it reads where nothing can send, and a
 * thread's held or copy-only draft pressed, copied or discarded.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { workOpenPort } from "../../lib/workSwitch";
import { MessagesDataProvider } from "./data";
import { COPY_DRAFT, fixtureData, HELD_DRAFT, JOB, MESSAGES, withReply, type FixtureOptions } from "./fixtures";
import { MessagesScreen } from "./MessagesView";
import { patchPage, resetPages } from "./page";

const toasts = vi.hoisted(() => ({ said: [] as string[] }));
vi.mock("../shell/open", () => ({ openConnections: () => {} }));
vi.mock("../../components/ui/toaster", async (original) => ({
  ...(await original<object>()),
  loadToast: async () => Object.assign((m: string) => void toasts.said.push(m), { error: (m: string) => void toasts.said.push(`error: ${m}`) }),
}));
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
  copied.length = 0;
  toasts.said.length = 0;
  native.opened.length = 0;
});
afterEach(() => {
  cleanup();
  resetPages();
  workOpenPort.set(null);
});

const WS = "ws";
function mount(options: FixtureOptions, chatId: string) {
  const data = fixtureData(options);
  patchPage(WS, { chatId });
  render(
    <MessagesDataProvider value={data}>
      <MessagesScreen workspaceId={WS} job={JOB} narrow={false} />
    </MessagesDataProvider>,
  );
  return data;
}
const field = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>("[data-composer] textarea")!;
const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
const press = async (name: string) => act(async () => fireEvent.click(within(document.querySelector<HTMLElement>("[data-composer]")!).getByRole("button", { name })));
const flush = () => act(async () => {});

describe("his own reply", () => {
  it("asks a direct chat's person by first name and a channel by its name", () => {
    mount({}, "c_dana");
    expect(field().placeholder).toBe("Reply to Dana");
    cleanup();
    mount({}, "c_builds");
    expect(field().placeholder).toBe("Message #builds");
  });

  it("makes a line on Shift and Return, sends on Return, and shows it as his own, Sending with Undo", async () => {
    const data = mount({}, "c_dana");
    type("On it");
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    expect(data.log.sent).toEqual([]);
    await act(async () => fireEvent.keyDown(field(), { key: "Enter" }));
    expect(data.log.sent).toEqual([{ chatId: "c_dana", text: "On it" }]);
    expect(field().value).toBe("");
    const mine = document.querySelector<HTMLElement>("[data-reply='sending']")!;
    expect(mine.textContent).toContain("Sending");
    expect(within(mine).getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("puts the words back in the field on Undo", async () => {
    const data = mount({}, "c_dana");
    type("Wrong chat, sorry");
    await press("Send");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    await flush();
    expect(data.log.undone).toHaveLength(1);
    expect(field().value).toBe("Wrong chat, sorry");
    expect(document.querySelector("[data-reply]")).toBeNull();
  });

  it("says Not sent. and LifeOS's reason under the red mark, and Retry sends it again", async () => {
    const data = mount({ messages: { ...MESSAGES, c_dana: withReply("c_dana", "failed", "Yes", "Slack says this conversation is archived") } }, "c_dana");
    const failed = document.querySelector<HTMLElement>("[data-reply='failed']")!;
    expect(failed.textContent).toContain("Not sent.");
    expect(failed.textContent).toContain("Slack says this conversation is archived");
    await act(async () => fireEvent.click(within(failed).getByRole("button", { name: "Retry" })));
    expect(data.log.retried).toEqual(["c_dana_out"]);
    expect(document.querySelector("[data-reply='sending']")).not.toBeNull();
  });

  it("shows a refusal in LifeOS's words and keeps what he typed", async () => {
    mount({ refuse: "LifeOS can't reply to a conversation you left" }, "c_dana");
    type("Still here?");
    await press("Send");
    expect(screen.getByRole("alert").textContent).toBe("LifeOS can't reply to a conversation you left");
    expect(field().value).toBe("Still here?");
  });

  it("keeps what he typed with each conversation", () => {
    mount({}, "c_dana");
    type("Half a thought");
    act(() => patchPage(WS, { chatId: "c_builds" }));
    expect(field().value).toBe("");
    act(() => patchPage(WS, { chatId: "c_dana" }));
    expect(field().value).toBe("Half a thought");
  });
});

describe("where nothing here can send", () => {
  it("offers Copy with Open in the app, under LifeOS's reason", async () => {
    mount({}, "c_playtest");
    const composer = document.querySelector<HTMLElement>("[data-composer]")!;
    expect(composer.textContent).toContain("LifeOS can't reply in Discord yet");
    expect(within(composer).queryByRole("button", { name: "Send" })).toBeNull();
    type("Thanks all");
    await press("Copy");
    expect(copied).toEqual(["Thanks all"]);
    await press("Open in Discord");
    expect(native.opened).toEqual(["https://discord.com/channels/starboard/c_playtest"]);
  });

  it("says the Mac is away in LifeOS's words, with no app to open", () => {
    mount({ routes: { c_jordan: { can: false, why: "Your Mac isn't running LifeOS" } } }, "c_jordan");
    const composer = document.querySelector<HTMLElement>("[data-composer]")!;
    expect(composer.textContent).toContain("Your Mac isn't running LifeOS");
    expect(within(composer).getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(within(composer).queryByRole("button", { name: /Open in/ })).toBeNull();
  });

  it("turns to Send by itself when the route does", () => {
    mount({}, "c_jordan");
    expect(within(document.querySelector<HTMLElement>("[data-composer]")!).getByRole("button", { name: "Send" })).toBeTruthy();
  });
});

describe("a thread's draft", () => {
  it("opens holding a held reply under the thread's line, and Send saves his edit and presses it", async () => {
    const opened: string[] = [];
    workOpenPort.set((id) => void opened.push(id));
    const data = mount({ drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    expect(field().value).toBe(HELD_DRAFT.text);
    const composer = document.querySelector<HTMLElement>("[data-composer]")!;
    expect(composer.textContent).toContain(`Drafted in${HELD_DRAFT.thread}`);
    await press("Open thread");
    expect(opened).toEqual(["t_keyart"]);
    type("Thursday works.");
    await press("Send");
    expect(data.log.pressed).toEqual([{ id: "held_1", text: "Thursday works." }]);
    expect(data.log.sent).toEqual([]);
    expect(composer.textContent).not.toContain("Drafted in");
  });

  it("discards a held reply", async () => {
    const data = mount({ drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    await press("Discard");
    expect(data.log.dropped).toEqual(["held_1"]);
    expect(field().value).toBe("");
  });

  it("copies a copy-only draft and drops it", async () => {
    const data = mount({ drafts: { c_playtest: [COPY_DRAFT] } }, "c_playtest");
    expect(field().value).toBe(COPY_DRAFT.text);
    await press("Copy");
    expect(copied).toEqual([COPY_DRAFT.text]);
    expect(data.log.dropped).toEqual(["copy_1"]);
    expect(toasts.said).toContain("Copied");
  });

  it("marks the conversation's row while a draft waits", () => {
    mount({ drafts: { c_dana: [HELD_DRAFT] } }, "c_dana");
    const row = screen.getAllByRole("option").find((el) => el.getAttribute("aria-label")?.includes("Dana Lee"))!;
    expect(row.getAttribute("aria-label")).toContain("a draft waits");
  });
});
