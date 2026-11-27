// @vitest-environment jsdom
/**
 * A thread's held chat reply in the Outbox (`chat.reply`): where it goes, the message it answers as
 * one quoted line, then its words exactly as they go, read from LifeOS on the item's own sector.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeldItem } from "@shared/work";
import { ACT_VIEWS } from "../acts/registry";
import { CHATS, MESSAGES } from "./fixtures";

const lifeos = vi.hoisted(() => ({ asked: [] as { name: string; args: unknown }[], answer: true, raw: undefined as unknown, pageFails: false, rawFails: false, detailFails: false, pageLoading: false, chat: undefined as unknown, page: undefined as unknown }));
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosSession: (environmentId: string, sector: string) => ({ environmentId, sector, client: {}, state: "connected" }),
  useLifeosQuery: (_session: unknown, name: string, args: { id?: string; chatId?: string }) => {
    lifeos.asked.push({ name, args });
    if (!lifeos.answer) return { status: "loading" };
    if (name === "chats:get" && lifeos.detailFails) return { status: "failed", error: "LifeOS did not answer" };
    if (name === "chats:get") return { status: "ready", value: { chat: lifeos.chat ?? CHATS.find((c) => c._id === args.id), source: null, route: { can: true } } };
    if (name === "chats:messages" && lifeos.pageLoading) return { status: "loading" };
    if (name === "chats:messages" && lifeos.page) return { status: "ready", value: { page: lifeos.page } };
    if (name === "chats:messages") return lifeos.pageFails ? { status: "failed", error: "LifeOS did not answer" } : { status: "ready", value: { page: MESSAGES[args.chatId!] ?? [] } };
    if (name === "rawMessages:get") return lifeos.rawFails ? { status: "failed", error: "LifeOS did not answer" } : lifeos.raw === undefined ? { status: "loading" } : { status: "ready", value: lifeos.raw };
    return { status: "loading" };
  },
}));

const { View, answeredOf, replyOf } = await import("./ChatReplyAct");

afterEach(() => {
  cleanup();
  lifeos.asked.length = 0;
  lifeos.answer = true;
  lifeos.raw = undefined;
  lifeos.pageFails = false;
  lifeos.rawFails = false;
  lifeos.detailFails = false;
  lifeos.pageLoading = false;
  lifeos.chat = undefined;
  lifeos.page = undefined;
});

const item = (payload: unknown): HeldItem =>
  ({ ref: { at: "host", id: "h1" }, kind: "chat.reply", workspaceId: "ws", sessionId: "s1", sector: "cosmic", summary: "", verb: "Send", account: null, state: "held", payload, createdAt: 1, decidedBy: null, decidedAt: null }) as HeldItem;

const place = () => document.querySelector("[data-place]")!.textContent;

describe("the held reply's view", () => {
  it("is the kind's own view, not the generic one", () => {
    expect(ACT_VIEWS["chat.reply"].chunk).not.toBeNull();
  });

  it("says where it lands, quotes what it answers, then his name and the words exactly", () => {
    render(<View env="box" item={item({ chatId: "c_dana", source: "slack", chat: "Dana Lee", text: "Thursday works.\nI'll send it Wednesday." })} />);
    expect(place()).toBe("Slack, Starboard Games, Dana Lee");
    expect(document.querySelector("[data-posted]")!.textContent).toMatch(/You/);
    expect(document.querySelector("[data-answers]")!.textContent).toMatch(/^Also, the art team wants/);
    expect(screen.getByText(/Thursday works\./).textContent).toBe("Thursday works.\nI'll send it Wednesday.");
    expect(lifeos.asked.find((q) => q.name === "chats:get")?.args).toEqual({ id: "c_dana" });
  });

  it("quotes the message a Slack thread reply names", () => {
    render(<View env="box" item={item({ chatId: "c_design", replyTo: "c_design_m1", source: "slack", chat: "#design-review", to: "Ana Ruiz", text: "Agreed." })} />);
    expect(place()).toBe("Slack, Starboard Games, #design-review");
    expect(document.querySelector("[data-answers]")!.textContent).toMatch(/^Ana Ruiz: Love the rarity sort/);
  });

  it("stands on the payload's own words while LifeOS has not answered", () => {
    lifeos.answer = false;
    render(<View env="box" item={item({ chatId: "c_dana", source: "slack", chat: "Dana Lee", text: "Yes" })} />);
    // The title says "Reply in Slack to Dana Lee": with no workspace known yet the line has nothing to add.
    expect(document.querySelector("[data-place]")).toBeNull();
    // A line of bones holds the quote's place, so the words do not move when it comes.
    expect(document.querySelector("[data-answers]")!.getAttribute("data-answers")).toBe("loading");
  });

  it("reads a payload it cannot use as nothing", () => {
    expect(replyOf({ text: "x" })).toBeNull();
    render(<View env="box" item={item({ text: "x" })} />);
    expect(screen.getByText("This reply could not be read")).toBeTruthy();
  });

  it("names no answered message older than the page it holds", () => {
    expect(answeredOf({ replyTo: "gone" }, undefined, MESSAGES.c_dana)).toBeNull();
    const mine = { chat: { ...CHATS[0]!, lastFromMe: true, lastInId: undefined } } as never;
    expect(answeredOf({}, mine, [])).toBeNull();
  });

  it("reads a message it answers past the newest page by its id, holding its place meanwhile", async () => {
    const payload = { chatId: "c_dana", replyTo: "old_1", source: "slack", chat: "Dana Lee", text: "Agreed." };
    const view = render(<View env="box" item={item(payload)} />);
    expect(lifeos.asked.some((q) => q.name === "rawMessages:get" && (q.args as { id: string }).id === "old_1")).toBe(true);
    expect(document.querySelector("[data-answers]")!.getAttribute("data-answers")).toBe("loading");
    lifeos.raw = { message: { author: { name: "Dana Lee" }, fromMe: false, text: "Can we move the review to Friday?" }, thread: null };
    view.rerender(<View env="box" item={item(payload)} />);
    // The quote comes in over its bones, which go a tick later.
    await waitFor(() => expect(document.querySelector("[data-answers]")!.textContent).toBe("Can we move the review to Friday?"));
  });

  it("says the message it answers is no longer here when it cannot be read", () => {
    lifeos.raw = null;
    render(<View env="box" item={item({ chatId: "c_dana", replyTo: "gone_1", source: "slack", chat: "Dana Lee", text: "Agreed." })} />);
    expect(document.querySelector("[data-answers]")!.textContent).toBe("The message it answers is no longer here");
  });

  it("quotes in muted ink, the writer in medium", () => {
    render(<View env="box" item={item({ chatId: "c_dana", source: "slack", chat: "Dana Lee", text: "Yes" })} />);
    expect(document.querySelector("[data-answers]")!.innerHTML).not.toContain("faint");
  });

  it("reads a named message by its id when the page itself did not load", () => {
    lifeos.pageFails = true;
    lifeos.raw = { message: { author: { name: "Ana Ruiz" }, fromMe: false, text: "Ship it Friday?" }, thread: null };
    render(<View env="box" item={item({ chatId: "c_design", replyTo: "far_1", source: "slack", chat: "#design-review", to: "Ana Ruiz", text: "Yes." })} />);
    expect(lifeos.asked.some((q) => q.name === "rawMessages:get" && (q.args as { id: string }).id === "far_1")).toBe(true);
    expect(document.querySelector("[data-answers]")!.textContent).toBe("Ana Ruiz: Ship it Friday?");
  });

  it("says the message it answers could not be read, with Retry, when that read fails", () => {
    lifeos.rawFails = true;
    render(<View env="box" item={item({ chatId: "c_dana", replyTo: "far_2", source: "slack", chat: "Dana Lee", text: "Yes." })} />);
    const line = document.querySelector<HTMLElement>("[data-answers='unreadable']")!;
    expect(line.textContent).toContain("The message it answers could not be read");
    const asked = lifeos.asked.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(lifeos.asked.length).toBeGreaterThan(asked);
  });

  it("says the message it answers could not be read, with Retry, when the conversation's read failed and the reply names none", () => {
    lifeos.detailFails = true;
    render(<View env="box" item={item({ chatId: "c_dana", source: "slack", chat: "Dana Lee", text: "Yes." })} />);
    const line = document.querySelector<HTMLElement>("[data-answers='unreadable']")!;
    expect(line.textContent).toContain("The message it answers could not be read");
    expect(within(line).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("naming nothing in a conversation of only his own words, quotes his newest there as You, the message LifeOS will answer", () => {
    const at = Date.UTC(2026, 10, 23, 17);
    lifeos.chat = { ...CHATS.find((c) => c._id === "c_design")!, lastInId: undefined, lastFromMe: true };
    lifeos.page = [
      { _id: "o2", who: { name: "Alex Kim", me: true }, text: "Ship it Friday?", sentAt: at, files: [] },
      { _id: "o1", who: { name: "Alex Kim", me: true }, text: "Build is up.", sentAt: at - 60_000, files: [] },
    ];
    render(<View env="box" item={item({ chatId: "c_design", source: "slack", chat: "#design-review", text: "Going with Friday." })} />);
    expect(document.querySelector("[data-answers]")!.textContent).toBe("You: Ship it Friday?");
    // With nothing of his on the page it is left unsaid.
    expect(answeredOf({}, { chat: lifeos.chat } as never, [])).toBeNull();
  });

  it("skips his replies still on their way or failed: the quote is the newest stored message of his", () => {
    const at = Date.UTC(2026, 10, 23, 17);
    lifeos.chat = { ...CHATS.find((c) => c._id === "c_design")!, lastInId: undefined, lastFromMe: true };
    lifeos.page = [
      { _id: "q1", who: { name: "Alex Kim", me: true }, text: "Queued words", sentAt: at, files: [], reply: { outboxId: "ob1", status: "queued" } },
      { _id: "f1", who: { name: "Alex Kim", me: true }, text: "Failed words", sentAt: at - 1000, files: [], reply: { outboxId: "ob2", status: "failed", error: "Slack refused it" } },
      { _id: "o2", who: { name: "Alex Kim", me: true }, text: "Ship it Friday?", sentAt: at - 60_000, files: [] },
    ];
    render(<View env="box" item={item({ chatId: "c_design", source: "slack", chat: "#design-review", text: "Going with Friday." })} />);
    expect(document.querySelector("[data-answers]")!.textContent).toBe("You: Ship it Friday?");
  });

  it("naming nothing with no message from anyone else and a page that failed, says it could not be read, with Retry", () => {
    lifeos.chat = { ...CHATS.find((c) => c._id === "c_design")!, lastInId: undefined, lastFromMe: true };
    lifeos.pageFails = true;
    render(<View env="box" item={item({ chatId: "c_design", source: "slack", chat: "#design-review", text: "Going with Friday." })} />);
    const line = document.querySelector<HTMLElement>("[data-answers='unreadable']")!;
    expect(within(line).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  // Round 10: the body's keeper (keptKeys.tsx) holds the keys across Retry, in place of the slot's own hand-off.
  // Round 12: the line stays while the reads are out, its Retry spinning in place, until the answer replaces it.
  it("keeps the keys in the body's keeper while Retry reads afresh, the line kept with Retry spinning", async () => {
    lifeos.rawFails = true;
    render(<View env="box" item={item({ chatId: "c_dana", replyTo: "far_4", source: "slack", chat: "Dana Lee", text: "Yes." })} />);
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    lifeos.rawFails = false;
    lifeos.raw = undefined;
    await act(async () => fireEvent.click(retry));
    expect(document.querySelector("[data-kept-keys]")!.contains(document.activeElement)).toBe(true);
    const line = document.querySelector<HTMLElement>("[data-answers]")!;
    expect(line.getAttribute("data-answers")).toBe("unreadable");
    expect(within(line).getByRole("button", { name: "Retry" }).hasAttribute("disabled")).toBe(true);
    expect(line.querySelector("[data-slot=busy-label][data-busy]")).toBeTruthy();
    expect(document.querySelector("[data-answers='loading']")).toBeNull();
  });

  it("gives the keys back to Retry when the quote still cannot be read", async () => {
    lifeos.rawFails = true;
    render(<View env="box" item={item({ chatId: "c_dana", replyTo: "far_5", source: "slack", chat: "Dana Lee", text: "Yes." })} />);
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    await act(async () => fireEvent.click(retry));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry" }));
    expect(document.activeElement).not.toBe(retry);
  });

  it("says at once that it could not be read when the conversation failed, the page still loading", () => {
    lifeos.detailFails = true;
    lifeos.pageLoading = true;
    render(<View env="box" item={item({ chatId: "c_dana", source: "slack", chat: "Dana Lee", text: "Yes." })} />);
    expect(document.querySelector("[data-answers]")!.getAttribute("data-answers")).toBe("unreadable");
  });

  it("says what a parent with no words is, and keeps 'no longer here' for one that is absent", () => {
    lifeos.raw = { message: { author: { name: "Ana Ruiz" }, fromMe: false, text: "" }, thread: null };
    render(<View env="box" item={item({ chatId: "c_design", replyTo: "far_3", source: "slack", chat: "#design-review", to: "Ana Ruiz", text: "Nice." })} />);
    expect(document.querySelector("[data-answers]")!.textContent).toBe("Ana Ruiz: A picture or file");
  });

  it("in a direct chat leaves out only the recipient's name, so his own words still say You", () => {
    lifeos.raw = { message: { author: { name: "Alex Kim" }, fromMe: true, text: "I'll send the build tonight." }, thread: null };
    render(<View env="box" item={item({ chatId: "c_dana", replyTo: "mine_1", source: "slack", chat: "Dana Lee", text: "Sent." })} />);
    expect(document.querySelector("[data-answers]")!.textContent).toBe("You: I'll send the build tonight.");
  });
});
