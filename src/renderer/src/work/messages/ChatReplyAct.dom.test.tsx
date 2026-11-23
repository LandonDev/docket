// @vitest-environment jsdom
/**
 * A thread's held chat reply in the Outbox (`chat.reply`): where it goes, the message it answers as
 * one quoted line, then its words exactly as they go, read from LifeOS on the item's own sector.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeldItem } from "@shared/work";
import { ACT_VIEWS } from "../acts/registry";
import { CHATS, MESSAGES } from "./fixtures";

const lifeos = vi.hoisted(() => ({ asked: [] as { name: string; args: unknown }[], answer: true, raw: undefined as unknown }));
vi.mock("../shell/lifeos", async (original) => ({
  ...(await original<object>()),
  useLifeosSession: (environmentId: string, sector: string) => ({ environmentId, sector, client: {}, state: "connected" }),
  useLifeosQuery: (_session: unknown, name: string, args: { id?: string; chatId?: string }) => {
    lifeos.asked.push({ name, args });
    if (!lifeos.answer) return { status: "loading" };
    if (name === "chats:get") return { status: "ready", value: { chat: CHATS.find((c) => c._id === args.id), source: null, route: { can: true } } };
    if (name === "chats:messages") return { status: "ready", value: { page: MESSAGES[args.chatId!] ?? [] } };
    if (name === "rawMessages:get") return lifeos.raw === undefined ? { status: "loading" } : { status: "ready", value: lifeos.raw };
    return { status: "loading" };
  },
}));

const { View, answeredOf, replyOf } = await import("./ChatReplyAct");

afterEach(() => {
  cleanup();
  lifeos.asked.length = 0;
  lifeos.answer = true;
  lifeos.raw = undefined;
});

const item = (payload: unknown): HeldItem =>
  ({ ref: { at: "host", id: "h1" }, kind: "chat.reply", workspaceId: "ws", sessionId: "s1", sector: "cosmic", summary: "", verb: "Send", account: null, state: "held", payload, createdAt: 1, decidedBy: null, decidedAt: null }) as HeldItem;

describe("the held reply's view", () => {
  it("is the kind's own view, not the generic one", () => {
    expect(ACT_VIEWS["chat.reply"].chunk).not.toBeNull();
  });

  it("says to whom and where, quotes what it answers, then the words exactly", () => {
    render(<View env="box" item={item({ chatId: "c_dana", source: "slack", chat: "Dana Lee", text: "Thursday works.\nI'll send it Wednesday." })} />);
    const [to, where] = screen.getAllByRole("definition");
    expect(to!.textContent).toBe("Dana Lee");
    expect(where!.textContent).toBe("Slack, Starboard Games");
    expect(document.querySelector("[data-answers]")!.textContent).toMatch(/^Dana Lee Also, the art team wants/);
    expect(screen.getByText(/Thursday works\./).textContent).toBe("Thursday works.\nI'll send it Wednesday.");
    expect(lifeos.asked.find((q) => q.name === "chats:get")?.args).toEqual({ id: "c_dana" });
  });

  it("quotes the message a Slack thread reply names", () => {
    render(<View env="box" item={item({ chatId: "c_design", replyTo: "c_design_m1", source: "slack", chat: "#design-review", to: "Ana Ruiz", text: "Agreed." })} />);
    expect(screen.getAllByRole("definition")[0]!.textContent).toBe("Ana Ruiz");
    expect(document.querySelector("[data-answers]")!.textContent).toMatch(/^Ana Ruiz Love the rarity sort/);
  });

  it("stands on the payload's own words while LifeOS has not answered", () => {
    lifeos.answer = false;
    render(<View env="box" item={item({ chatId: "c_dana", source: "slack", chat: "Dana Lee", text: "Yes" })} />);
    expect(screen.getAllByRole("definition")[1]!.textContent).toBe("Slack");
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

  it("reads a message it answers past the newest page by its id, holding its place meanwhile", () => {
    const payload = { chatId: "c_dana", replyTo: "old_1", source: "slack", chat: "Dana Lee", text: "Agreed." };
    const view = render(<View env="box" item={item(payload)} />);
    expect(lifeos.asked.some((q) => q.name === "rawMessages:get" && (q.args as { id: string }).id === "old_1")).toBe(true);
    expect(document.querySelector("[data-answers]")!.getAttribute("data-answers")).toBe("loading");
    lifeos.raw = { message: { author: { name: "Dana Lee" }, fromMe: false, text: "Can we move the review to Friday?" }, thread: null };
    view.rerender(<View env="box" item={item(payload)} />);
    expect(document.querySelector("[data-answers]")!.textContent).toMatch(/^Dana Lee Can we move the review to Friday\?/);
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
});
