import { describe, expect, it, vi } from "vitest";
import type { TellOpen } from "@shared/work/tell";
import { go, routeOf, type Routes } from "./open";

/** Each place a tell can open, turned into the app's own route. */

const route = (open?: TellOpen) => routeOf({ host: "box", ...(open ? { open } : {}) });
const routes = (): Routes & Record<keyof Routes, ReturnType<typeof vi.fn>> => ({ thread: vi.fn(), view: vi.fn(), place: vi.fn(() => true), outbox: vi.fn(), settings: vi.fn() });

describe("routeOf", () => {
  it("a thread opens the thread", () => {
    expect(route({ thread: "t1" })).toEqual({ to: "thread", sessionId: "t1" });
  });
  it("a view opens the view of its workspace, standing on what `at` names in that view's own field", () => {
    expect(route({ view: "agenda", workspaceId: "ws", at: "ev1" })).toEqual({ to: "view", view: { workspaceId: "ws", view: "agenda", event: "ev1" } });
    expect(route({ view: "prep", workspaceId: "ws", at: "ev1" })).toEqual({ to: "view", view: { workspaceId: "ws", view: "prep", event: "ev1" } });
    expect(route({ view: "mail", workspaceId: "ws", at: "m1" })).toEqual({ to: "view", view: { workspaceId: "ws", view: "mail", mail: "m1" } });
    expect(route({ view: "tasks", workspaceId: "ws", at: "k1" })).toEqual({ to: "view", view: { workspaceId: "ws", view: "tasks", task: "k1" } });
    expect(route({ view: "people", workspaceId: "ws", at: "p1" })).toEqual({ to: "view", view: { workspaceId: "ws", view: "people", person: "p1" } });
    // a view that takes no place opens as it is
    expect(route({ view: "docs", workspaceId: "ws", at: "d1" })).toEqual({ to: "view", view: { workspaceId: "ws", view: "docs" } });
    expect(route({ view: "routines", workspaceId: "ws" })).toEqual({ to: "view", view: { workspaceId: "ws", view: "routines" } });
  });
  it("a page above the workspaces opens by its id", () => {
    expect(route({ place: "review", at: "2026-11-16" })).toEqual({ to: "place", id: "review", at: "2026-11-16" });
    expect(route({ place: "today" })).toEqual({ to: "place", id: "today" });
  });
  it("a held item opens the Outbox on that item, by the page's own key, whether or not a thread made it", () => {
    expect(route({ held: { at: "host", id: "h1" } })).toEqual({ to: "outbox", item: "box:host:h1" });
    expect(route({ held: { at: "lifeos", table: "calendarOps", id: "op1" }, thread: "t1" })).toEqual({ to: "outbox", item: "box:lifeos:op1" });
  });
  it("a settings section opens Settings there, and a tell with no target opens nothing", () => {
    expect(route({ settings: "connections" })).toEqual({ to: "settings", section: "connections" });
    expect(route()).toEqual({ to: "none" });
  });
});

describe("go", () => {
  it("runs the one way in the route names, and says when there was nothing to open", () => {
    const r = routes();
    expect(go({ to: "thread", sessionId: "t1" }, r)).toBe(true);
    expect(go({ to: "view", view: { workspaceId: "ws", view: "agenda" } }, r)).toBe(true);
    expect(go({ to: "outbox", item: "box:host:h1" }, r)).toBe(true);
    expect(go({ to: "settings", section: "work" }, r)).toBe(true);
    expect(go({ to: "place", id: "review", at: "2026-11-16" }, r)).toBe(true);
    expect(go({ to: "none" }, r)).toBe(false);
    expect(r.thread).toHaveBeenCalledWith("t1");
    expect(r.view).toHaveBeenCalledWith({ workspaceId: "ws", view: "agenda" });
    expect(r.outbox).toHaveBeenCalledWith("box:host:h1");
    expect(r.settings).toHaveBeenCalledWith("work");
    expect(r.place).toHaveBeenCalledWith("review", "2026-11-16");
  });
  it("a page this build does not have opens nothing", () => {
    const r = { ...routes(), place: vi.fn(() => false) };
    expect(go({ to: "place", id: "review" }, r)).toBe(false);
  });
});
