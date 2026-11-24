// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { forgetReturnWindow, keepReturn, returnOf } from "./returnRecord";
import { keepPlace, keptPlace } from "./place";
import { spotOfWindow, threadOf } from "./ReturnHost";
import { keptMailOf, pageOf as mailPageOf, pages as mailPages, patch as patchMail } from "../mail/page";
import { keptChatOf, pageOf as messagesPageOf, patchPage, resetPages } from "../messages/page";
import { agendaPlace, keepAgendaPlace, resetAgendaPlace, restoreAgendaPlace } from "../agenda/place";
import type { WorkspaceMeta } from "../../lib/tcserver/types";

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  forgetReturnWindow(true);
  mailPages.clear();
  resetPages();
  resetAgendaPlace();
});

/** A window before this one left `ws` so; this window reads it afresh. */
function left(places: Record<string, unknown>): void {
  keepReturn("ws", { places });
  forgetReturnWindow();
  mailPages.clear();
  resetPages();
}

describe("a view's kept place", () => {
  it("reads only the fields it names, of their type", () => {
    keepPlace("ws", "mail", { box: "sent", threadId: 7, chat: true, other: "x" });
    expect(keptPlace<{ box: string; threadId: string; chat: boolean }>("ws", "mail", { box: "string", threadId: "string", chat: "boolean" })).toEqual({ box: "sent", chat: true });
    keepReturn("ws", { places: { mail: "a string" } });
    expect(keptPlace("ws", "mail", { box: "string" })).toEqual({});
  });
});

describe("the window's spot", () => {
  it("is the view open in this workspace, a meeting's event with its page, and the thread", () => {
    expect(spotOfWindow({ workspaceId: "ws", view: "prep", event: "e1" }, "ws", "t1")).toEqual({ view: "prep", event: "e1", thread: "t1" });
    expect(spotOfWindow({ workspaceId: "ws", view: "agenda", event: "e1" }, "ws", undefined)).toEqual({ view: "agenda", event: undefined });
    expect(spotOfWindow(null, "ws", "t1")).toEqual({ view: null, event: undefined, thread: "t1" });
  });

  it("writes nothing while the view open is another workspace's (the window on its way)", () => {
    expect(spotOfWindow({ workspaceId: "other", view: "mail" }, "ws", "t1")).toBeNull();
  });

  it("keeps a thread only of this workspace", () => {
    const ws = { id: "ws", path: "/w/purdue", kind: "work" } as WorkspaceMeta;
    const catalog = { loaded: true, workspaces: [ws, { id: "ws2", path: "/w/ref", kind: "work" } as WorkspaceMeta], projects: [] };
    expect(threadOf({ id: "t1", cwd: "/w/purdue", projectId: null, workspaceId: "ws" }, ws, catalog)).toBe("t1");
    expect(threadOf({ id: "t2", cwd: "/w/ref", projectId: null, workspaceId: "ws2" }, ws, catalog)).toBeUndefined();
    expect(threadOf(undefined, ws, catalog)).toBeUndefined();
  });
});

describe("Mail comes back", () => {
  it("on its box, its open mail and its chat, after a reload", () => {
    patchMail("ws", { box: "sent", threadId: "m1", chat: true, compose: null });
    expect(returnOf("ws").places?.mail).toEqual({ account: null, box: "sent", threadId: "m1", chat: true });
    forgetReturnWindow();
    mailPages.clear();
    expect(mailPageOf("ws")).toMatchObject({ box: "sent", threadId: "m1", chat: true, compose: null, chatAt: null });
    // The kept mail is checked once: his next move lets it go.
    expect(keptMailOf("ws")).toBe("m1");
    patchMail("ws", { threadId: "m2" });
    expect(keptMailOf("ws")).toBeNull();
  });

  it("on the inbox when the kept box is not one Mail has", () => {
    left({ mail: { box: "folder-from-a-later-release" } });
    expect(mailPageOf("ws").box).toBe("inbox");
  });
});

describe("Messages comes back", () => {
  it("on its conversation and its filter, never a search", () => {
    patchPage("ws", { chatId: "c1", filter: "direct", query: "budget" });
    forgetReturnWindow();
    resetPages();
    expect(messagesPageOf("ws")).toEqual({ chatId: "c1", filter: "direct", query: "" });
    expect(keptChatOf("ws")).toBe("c1");
  });

  it("on all of them when the kept filter is unknown", () => {
    left({ messages: { chatId: "c1", filter: "starred" } });
    expect(messagesPageOf("ws").filter).toBe("all");
  });
});

describe("Agenda comes back", () => {
  const day = (iso: string) => new Date(iso).getTime();

  it("on its view, and its day when that visit was today", () => {
    agendaPlace.set({ view: "week", day: day("2026-11-30T00:00:00"), adding: null });
    keepAgendaPlace("ws", day("2026-11-24T10:00:00"));
    resetAgendaPlace();
    restoreAgendaPlace("ws", day("2026-11-24T16:00:00"));
    expect(agendaPlace.get()).toEqual({ view: "week", day: day("2026-11-30T00:00:00"), adding: null });
  });

  it("on today, in its view, when the visit was another day", () => {
    agendaPlace.set({ view: "month", day: day("2026-11-01T00:00:00"), adding: null });
    keepAgendaPlace("ws", day("2026-11-20T10:00:00"));
    resetAgendaPlace();
    restoreAgendaPlace("ws", day("2026-11-24T16:00:00"));
    expect(agendaPlace.get()).toEqual({ view: "month", day: day("2026-11-24T00:00:00"), adding: null });
  });

  it("once a visit: the view mounting after the header takes nothing back", () => {
    keepPlace("ws", "agenda", { view: "week", day: day("2026-11-24T00:00:00"), on: day("2026-11-24T00:00:00") });
    restoreAgendaPlace("ws", day("2026-11-24T12:00:00"));
    agendaPlace.set({ ...agendaPlace.get(), day: day("2026-12-01T00:00:00") });
    restoreAgendaPlace("ws", day("2026-11-24T12:00:00"));
    expect(agendaPlace.get().day).toBe(day("2026-12-01T00:00:00"));
  });

  it("on today's list for a workspace never visited", () => {
    restoreAgendaPlace("ws", day("2026-11-24T12:00:00"));
    expect(agendaPlace.get()).toEqual({ view: "list", day: day("2026-11-24T00:00:00"), adding: null });
  });
});
