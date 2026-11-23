import { afterEach, describe, expect, it } from "vitest";
import { openWorkView, workViewNow } from "../../lib/workSwitch";
import { openerOf } from "../canvas/SentChips";

/** The ways into the Messages view from outside it: a sent chip, a search hit, a tell. */
describe("opening a conversation from outside the view", () => {
  afterEach(() => openWorkView(null));

  const at = { environmentId: "box", sessionId: "s", workspaceId: "ws" };

  it("a sent conversation chip opens Messages on that conversation", () => {
    const opener = openerOf({ noun: "conversation", label: "Dana Lee in Slack", ref: "LifeOS chats c_dana" } as never, at);
    void opener!();
    expect(workViewNow()).toEqual({ workspaceId: "ws", view: "messages", chat: "c_dana" });
  });

  it("opens nothing for a thread with no workspace", () => {
    expect(openerOf({ noun: "conversation", label: "Dana Lee in Slack", ref: "LifeOS chats c_dana" } as never, { ...at, workspaceId: null })).toBeNull();
  });

  it("a second open on another message of the same conversation is a new place, and the same one is not", () => {
    let told = 0;
    const seen: unknown[] = [];
    const read = (): void => void (told++, seen.push(workViewNow()));
    openWorkView({ workspaceId: "ws", view: "messages", chat: "c_dana", message: "m1" });
    read();
    openWorkView({ workspaceId: "ws", view: "messages", chat: "c_dana", message: "m2" });
    read();
    expect(seen).toEqual([
      { workspaceId: "ws", view: "messages", chat: "c_dana", message: "m1" },
      { workspaceId: "ws", view: "messages", chat: "c_dana", message: "m2" },
    ]);
    const held = workViewNow();
    openWorkView({ workspaceId: "ws", view: "messages", chat: "c_dana", message: "m2" });
    // The same place again keeps the same object: no listener is told.
    expect(workViewNow()).toBe(held);
    expect(told).toBe(2);
  });
});
