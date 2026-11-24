// @vitest-environment jsdom
/**
 * The chat beside the mail (docs/agents/work-mail.md "The chat beside the mail"), on work-kit's fixture mail: Ask
 * and ⌘L open and close it (⌘L stepping aside for a canvas selection's Ask), its head names what it is about, it
 * follows his moves and comes back to a mail's own chat, a mail opened from a chip does not move it, and the first
 * send makes the thread about the mail, marks it a mail chat, and only then sends.
 */
import type React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as { method: string; params: Record<string, unknown> }[]);
const found = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("../../../lib/connection", async (original) => {
  const linkOf = (id: string) => ({
    environmentId: id,
    connected: true,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      if (method === "work.mail.chat.find") return { sessionIds: found.ids };
      if (method === "session.create") return { id: params.id, provider: "claude", model: "m", status: "idle", title: "", cwd: "/w", createdAt: 0, updatedAt: 0, workspaceId: "w1" };
      return {};
    },
    onPush: () => () => undefined,
  });
  return { ...(await original<typeof import("../../../lib/connection")>()), registry: { linkOf, link: linkOf, has: () => true, environments: () => [], onLink: () => () => undefined } };
});
vi.mock("../../../surfaces/threadChat", () => ({
  useSessionActions: () => ({ onSubmit: (id: string, text: string) => calls.push({ method: "submit", params: { id, text } }) }),
  useThreadChat: () => ({ renderChat: (opts?: { topSlot?: unknown }) => opts?.topSlot ?? null, renderSlots: () => null, newPassArmed: false, armNewPass: () => undefined }),
}));
// The thread's view: a stand-in that draws the composer's top edge (the starters) and an input to type in.
vi.mock("../../../surfaces/threads/ThreadView", () => ({
  ThreadView: ({ renderChat }: { renderChat: () => React.ReactNode }) => (
    <div>
      {renderChat()}
      <div data-composer-input contentEditable suppressContentEditableWarning />
    </div>
  ),
}));
vi.mock("../../../surfaces/SessionPane", () => ({ LoadLine: () => null }));

const { MailClientProvider, MailKitProvider } = await import("work-kit/mail");
const { corpusThreads, createFixtureMailClient } = await import("work-kit/mail/fixtures");
const { chatSeat, MailScreen, patch, showMail } = await import("../MailView");
const { MAIL_CHAT } = await import("@shared/work/mailChat");
const { tempcodeMailKit } = await import("../kit");
const { resetDocks } = await import("../../dock/dockThread");
const { resetContextChips, takeContextChips } = await import("../../canvas/chips");
const { sessionStore } = await import("../../../lib/tcserver/store");
const { newSession } = await import("../../../lib/session");
const { workDockPort } = await import("../../../lib/workSwitch");
const { send } = await import("../../../lib/tcserver/commands");
const { mailDockPort } = await import("./port");
const { IS_MAC } = await import("../../../lib/platform");

const threads = corpusThreads();
const workspace = { id: "w1", environmentId: "box", path: "/w" };
let n = 0;
const ID = () => `w1`;

beforeEach(() => {
  calls.length = 0;
  found.ids = [];
  sessionStore.reset();
  resetContextChips();
  resetDocks();
  patch(ID(), { threadId: null, box: "inbox", chat: false, chatAt: null, compose: null });
  workDockPort.set({
    draft: (_ws, id) => ({ ...newSession("box", "claude", "/w", undefined, undefined, undefined, { projectId: null, workspaceId: "w1" }), ...(id ? { id } : { id: `draft-${++n}` }) }),
    openFile: () => undefined,
    openDiff: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1280 });
  // jsdom lays nothing out: the reader scrolls its first unread message into view.
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(() => {
  cleanup();
  workDockPort.set(null);
});

function mount() {
  const client = createFixtureMailClient({ write: async ({ run }) => run(), instant: true, threads: corpusThreads() });
  return render(
    <MailClientProvider client={client}>
      <MailKitProvider kit={tempcodeMailKit}>
        <MailScreen id={ID()} onOpenTask={() => undefined} chat={{ workspace }} />
      </MailKitProvider>
    </MailClientProvider>,
  );
}

const dock = (): HTMLElement | null => document.querySelector("[data-mail-dock]");
const head = (): string => dock()?.querySelector("h3")?.textContent ?? "";
const dockId = (): string => dock()?.getAttribute("data-mail-dock") ?? "";
const cmdL = (): void => void fireEvent.keyDown(window, { key: "l", metaKey: IS_MAC, ctrlKey: !IS_MAC });

describe("the chat while it is off", () => {
  it("gives Mail no seat for it, so the reader's toolbar has no Ask and ⌘L does nothing", async () => {
    expect(MAIL_CHAT.on).toBe(false);
    expect(chatSeat(workspace, "life")).toBeUndefined();
    const client = createFixtureMailClient({ write: async ({ run }) => run(), instant: true, threads: corpusThreads() });
    render(
      <MailClientProvider client={client}>
        <MailKitProvider kit={tempcodeMailKit}>
          <MailScreen id={ID()} onOpenTask={() => undefined} chat={chatSeat(workspace, "life")} />
        </MailKitProvider>
      </MailClientProvider>,
    );
    act(() => patch(ID(), { threadId: threads[0].id }));
    await waitFor(() => expect(document.querySelector("[data-mail-pane]")!.textContent).toContain(threads[0].subject));
    expect(screen.queryByRole("button", { name: "Ask" })).toBeNull();
    act(() => cmdL());
    expect(dock()).toBeNull();
  });
});

describe("the chat beside the mail", () => {
  it("opens and closes with Ask at the reader's toolbar's end and with ⌘L", async () => {
    mount();
    act(() => patch(ID(), { threadId: threads[0].id }));
    await waitFor(() => expect(document.querySelector("[data-mail-pane]")!.textContent).toContain(threads[0].subject));
    const ask = await screen.findByRole("button", { name: "Ask" });
    fireEvent.click(ask);
    await waitFor(() => expect(dock()).not.toBeNull());
    expect(ask.getAttribute("aria-pressed")).toBe("true");
    act(() => cmdL());
    expect(dock()).toBeNull();
    act(() => cmdL());
    await waitFor(() => expect(dock()).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Close chat" }));
    expect(dock()).toBeNull();
  });

  it("leaves ⌘L to a live canvas selection's Ask", async () => {
    mount();
    // A live selection's bar hears ⌘L on the document first and takes it (SelectionBar.tsx).
    const taken = (event: KeyboardEvent): void => event.preventDefault();
    document.addEventListener("keydown", taken);
    try {
      act(() => void fireEvent.keyDown(document, { key: "l", metaKey: IS_MAC, ctrlKey: !IS_MAC }));
      expect(dock()).toBeNull();
    } finally {
      document.removeEventListener("keydown", taken);
    }
    act(() => void fireEvent.keyDown(document, { key: "l", metaKey: IS_MAC, ctrlKey: !IS_MAC }));
    await waitFor(() => expect(dock()).not.toBeNull());
  });

  it("names what it is about in its head, and follows his moves to each subject's own chat", async () => {
    mount();
    act(() => patch(ID(), { chat: true }));
    await waitFor(() => expect(head()).toBe("Inbox"));
    const inbox = dockId();
    act(() => patch(ID(), { threadId: threads[0].id }));
    await waitFor(() => expect(head()).toBe(threads[0].subject));
    const first = dockId();
    expect(first).not.toBe(inbox);
    act(() => patch(ID(), { threadId: threads[1].id }));
    await waitFor(() => expect(head()).toBe(threads[1].subject));
    expect(dockId()).not.toBe(first);
    // Back to the first mail: its own chat again.
    act(() => patch(ID(), { threadId: threads[0].id }));
    await waitFor(() => expect(dockId()).toBe(first));
  });

  it("shows a mail's chat from before, found by the host", async () => {
    sessionStore.adopt({ id: "s-old", environmentId: "box", status: "idle", archived: false, workspaceId: "w1", projectId: null, scope: "work", title: "About lunch", createdAt: 0, updatedAt: 0 } as never, { created: true });
    found.ids = ["s-gone", "s-old"];
    mount();
    act(() => patch(ID(), { chat: true, threadId: threads[0].id }));
    await waitFor(() => expect(dockId()).toBe("s-old"));
    expect(calls.find((c) => c.method === "work.mail.chat.find")?.params).toEqual({ workspaceId: "w1", mailThreadId: threads[0].id });
  });

  it("stays on its mail when a mail is opened from a chip in it", async () => {
    mount();
    act(() => patch(ID(), { chat: true, threadId: threads[0].id }));
    await waitFor(() => expect(head()).toBe(threads[0].subject));
    // A chip opens a mail by the view's own way in (openWorkView {mail}): the chat holds what it was about.
    act(() => showMail(ID(), threads[1].id));
    await new Promise((r) => setTimeout(r, 20));
    expect(head()).toBe(threads[0].subject);
    // His own move in the list lets it follow again.
    act(() => patch(ID(), { chatAt: null }));
    expect(document.querySelector("[data-mail-pane]")!.textContent).toContain(threads[1].subject);
    await waitFor(() => expect(head()).toBe(threads[1].subject));
  });

  it("asks about the ticked rows from the ticked head's Ask, even with a mail open", async () => {
    mount();
    act(() => patch(ID(), { threadId: threads[0].id }));
    await waitFor(() => expect(document.querySelectorAll("[data-mail-list] [role=checkbox]").length).toBeGreaterThan(2));
    const ticks = [...document.querySelectorAll<HTMLElement>("[data-mail-list] [role=checkbox]")];
    fireEvent.click(ticks[1]!);
    fireEvent.click(ticks[2]!);
    fireEvent.click(await screen.findByRole("button", { name: "Ask about these" }));
    await waitFor(() => expect(head()).toBe("2 mails"));
  });

  it("puts a mail mentioned from Mail's menus in the open chat's composer", async () => {
    mount();
    act(() => patch(ID(), { chat: true, threadId: threads[0].id }));
    await waitFor(() => expect(dock()).not.toBeNull());
    expect(mailDockPort.get()).not.toBeNull();
    act(() => patch(ID(), { chat: false }));
    await waitFor(() => expect(mailDockPort.get()).toBeNull());
  });

  it("makes the thread about the mail at the first send, marks it a mail chat, and only then sends", async () => {
    mount();
    act(() => patch(ID(), { chat: true, threadId: threads[0].id }));
    await waitFor(() => expect(head()).toBe(threads[0].subject));
    const id = dockId();
    expect(sessionStore.isDraft(id)).toBe(true);
    // No chip sits in the composer; the send carries the mail's.
    const sent = takeContextChips(id, true);
    expect(sent).toEqual([{ kind: "mail", label: threads[0].subject, ref: { at: "lifeos", table: "mailThreads", id: threads[0].id } }]);
    // The send waits for the turn to settle, which no host here does: the calls are what is checked.
    void send(sessionStore.get(id)!, "Draft a reply").catch(() => undefined);
    await waitFor(() => expect(calls.some((c) => c.method === "session.send")).toBe(true));
    const order = calls.map((c) => c.method).filter((m) => m === "session.create" || m === "work.mail.chat.adopt" || m === "session.send");
    expect(order).toEqual(["session.create", "work.mail.chat.adopt", "session.send"]);
    expect(calls.find((c) => c.method === "session.create")?.params.about).toEqual(sent[0]);
    expect(calls.find((c) => c.method === "work.mail.chat.adopt")?.params).toEqual({ workspaceId: "w1", sessionId: id, kind: "mail", mailThreadId: threads[0].id });
  });

  it("offers the subject's starters on a fresh draft, sends one on a press, and hides them once he types", async () => {
    mount();
    act(() => patch(ID(), { chat: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "What needs me today?" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "What needs me today?" }));
    const submit = calls.find((c) => c.method === "submit");
    expect(submit?.params.id).toBe(dockId());
    expect(String(submit?.params.text)).toContain("What needs me today?");
    expect(String(submit?.params.text)).toContain("About this selection: Inbox");
    const input = document.querySelector<HTMLElement>("[data-composer-input]")!;
    input.textContent = "Hello";
    fireEvent.input(input);
    expect(document.querySelector("[data-mail-starters]")).toBeNull();
  });

  it("lies over the whole view where the mail would be left under 480px, the mail under it inert", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 800 });
    mount();
    act(() => patch(ID(), { chat: true }));
    await waitFor(() => expect(dock()).not.toBeNull());
    expect(document.querySelector("[data-mail-dock-seat]")!.getAttribute("data-mail-dock-seat")).toBe("over");
    expect(document.querySelector("[data-mail-room]")!.hasAttribute("inert")).toBe(true);
  });

  it("sits beside the mail at 360px in a wide view", async () => {
    mount();
    act(() => patch(ID(), { chat: true }));
    await waitFor(() => expect(dock()).not.toBeNull());
    const seat = document.querySelector<HTMLElement>("[data-mail-dock-seat]")!;
    expect(seat.getAttribute("data-mail-dock-seat")).toBe("beside");
    expect(seat.style.width).toBe("360px");
    expect(document.querySelector("[data-mail-sash]")).not.toBeNull();
  });
});
