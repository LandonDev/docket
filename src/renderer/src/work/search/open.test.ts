import { describe, expect, it, vi } from "vitest";
import type { ContextChip } from "@shared/work";
import type { SearchHit } from "@shared/work/search";
import type { WorkspaceMeta } from "../../lib/tcserver/types";

// The opener's own doors are the app's stores and ports: each test hands in its own.
vi.mock("../canvas/held", () => ({ openHeld: vi.fn() }));
vi.mock("../shell/WorkColumn", () => ({ startThreadAbout: vi.fn() }));
const { canStartAbout, openHit, startAbout } = await import("./open");
type OpenDeps = import("./open").OpenDeps;

/** Return on a hit: the window enters the hit's job when it is elsewhere, the thing opens in place, and the hit's host is told. */

const ws = (id: string, environmentId = "box"): WorkspaceMeta => ({ id, name: id, path: `/w/${id}`, kind: "work", sector: id, environmentId }) as unknown as WorkspaceMeta;
const hit = (over: Partial<SearchHit> = {}): SearchHit => ({ key: "lifeos:mailThreads:m1", kind: "mail", title: "Budget for the LAN", workspaceId: "purdue", open: { to: "view", view: "mail", with: { mail: "m1" } }, ...over });

function rig(selected: string[] = ["purdue"], over: Partial<OpenDeps> = {}) {
  const did: unknown[][] = [];
  const known = [ws("purdue"), ws("cosmic"), ws("mac-purdue", "mac")];
  const deps: OpenDeps = {
    workspace: (id) => known.find((w) => w.id === id),
    selected: () => selected,
    enter: (w) => void did.push(["enter", w.path]),
    view: (next) => void did.push(["view", next]),
    thread: (sessionId, seq) => void did.push(["thread", sessionId, seq]),
    request: async (hostId, method, params) => void did.push(["request", hostId, method, params]),
    held: (id, hostId) => void did.push(["held", id, hostId]),
    startThread: (chip, w) => void did.push(["startThread", chip.label, w.id]),
    opened: (hostId, h) => void did.push(["opened", hostId, h.key]),
    clear: () => void did.push(["clear"]),
    ...over,
  };
  return { did, deps };
}

describe("opening a hit", () => {
  it("in the window's own job opens the thing in its view, without moving the window, and tells the host", async () => {
    const r = rig(["purdue"]);
    expect(await openHit(hit(), "box", r.deps)).toBe("opened");
    expect(r.did).toEqual([["clear"], ["view", { workspaceId: "purdue", view: "mail", mail: "m1" }], ["opened", "box", "lifeos:mailThreads:m1"]]);
  });
  it("in another job moves the window there first, then opens the thing", async () => {
    const r = rig(["purdue"]);
    expect(await openHit(hit({ workspaceId: "cosmic" }), "box", r.deps)).toBe("opened");
    expect(r.did).toEqual([["clear"], ["enter", "/w/cosmic"], ["view", { workspaceId: "cosmic", view: "mail", mail: "m1" }], ["opened", "box", "lifeos:mailThreads:m1"]]);
  });
  it("on another host enters that host's workspace of the job, and tells that host", async () => {
    const r = rig(["purdue"]);
    expect(await openHit(hit({ workspaceId: "mac-purdue" }), "mac", r.deps)).toBe("opened");
    expect(r.did).toEqual([["clear"], ["enter", "/w/mac-purdue"], ["view", { workspaceId: "mac-purdue", view: "mail", mail: "m1" }], ["opened", "mac", "lifeos:mailThreads:m1"]]);
    // a linked copy the window is already in needs no move
    const there = rig(["purdue", "mac-purdue"]);
    await openHit(hit({ workspaceId: "mac-purdue" }), "mac", there.deps);
    expect(there.did.map((d) => d[0])).toEqual(["clear", "view", "opened"]);
  });
  it("whose job has gone opens nothing, moves nothing and keeps nothing for Recent", async () => {
    const r = rig();
    expect(await openHit(hit({ workspaceId: "removed" }), "box", r.deps)).toBe("gone");
    expect(r.did).toEqual([]);
  });
  it("a message opens the Messages view of its job on its conversation, at the message", async () => {
    const r = rig(["purdue"]);
    const message = hit({ key: "lifeos:rawMessages:r1", kind: "message", workspaceId: "cosmic", open: { to: "view", view: "messages", with: { chat: "c1", message: "r1" } } });
    expect(await openHit(message, "box", r.deps)).toBe("opened");
    expect(r.did).toEqual([["clear"], ["enter", "/w/cosmic"], ["view", { workspaceId: "cosmic", view: "messages", chat: "c1", message: "r1" }], ["opened", "box", "lifeos:rawMessages:r1"]]);
  });

  it("a thread opens through the app's own door, at the row the words are in: the window follows the thread", async () => {
    const r = rig();
    expect(await openHit(hit({ key: "thread:t1", kind: "thread", workspaceId: null, open: { to: "thread", sessionId: "t1", seq: 14 } }), "box", r.deps)).toBe("opened");
    expect(r.did).toEqual([["thread", "t1", 14], ["opened", "box", "thread:t1"]]);
  });
  it("a file opens as a Files tab of its job through Files' own door, then the Files view; a refusal opens nothing", async () => {
    const ref = { at: "file", host: "box", path: "/w/cosmic/Budget.xlsx" };
    const file = hit({ key: "file:k1", kind: "file", workspaceId: "cosmic", open: { to: "file", ref, name: "Budget.xlsx" } });
    const r = rig(["purdue"]);
    expect(await openHit(file, "box", r.deps)).toBe("opened");
    expect(r.did).toEqual([
      ["request", "box", "work.files.open", { workspaceId: "cosmic", ref, name: "Budget.xlsx" }],
      ["clear"],
      ["enter", "/w/cosmic"],
      ["view", { workspaceId: "cosmic", view: "files" }],
      ["opened", "box", "file:k1"],
    ]);
    const refused = rig(["purdue"], { request: async () => Promise.reject(new Error("refused")) });
    expect(await openHit(file, "box", refused.deps)).toBe("failed");
    expect(refused.did).toEqual([]);
  });
  it("a LifeOS document opens as a Files tab, whether its hit names its chip or the Docs view a host a release behind still names", async () => {
    const ref = { at: "lifeos", table: "docs", id: "d1" };
    for (const open of [{ to: "chip", chip: { kind: "doc", label: "Plan", ref } }, { to: "view", view: "docs", with: { doc: { id: "d1", title: "Plan" } } }] as SearchHit["open"][]) {
      const r = rig(["purdue"]);
      expect(await openHit(hit({ key: "lifeos:docs:d1", open }), "box", r.deps)).toBe("opened");
      expect(r.did).toEqual([["request", "box", "work.files.open", { workspaceId: "purdue", ref, name: "Plan" }], ["clear"], ["view", { workspaceId: "purdue", view: "files" }], ["opened", "box", "lifeos:docs:d1"]]);
    }
  });
  it("a hit that came through a mention source opens as its chip does: a task in Tasks on that task, a card in Projects, a held act in the Outbox, a routine in Routines", async () => {
    const chip = (kind: ContextChip["kind"], ref: ContextChip["ref"]): SearchHit => hit({ open: { to: "chip", chip: { kind, label: "X", ref } } });
    const views: unknown[] = [];
    for (const h of [
      chip("task", { at: "lifeos", table: "tasks", id: "t1" }),
      chip("card", { at: "lifeos", table: "tasks", id: "t2" }),
      chip("event", { at: "lifeos", table: "events", id: "e1" }),
      chip("person", { at: "lifeos", table: "people", id: "p1" }),
      chip("project", { at: "lifeos", table: "projects", id: "j1" }),
      chip("doc", { at: "lifeos", table: "docs", id: "d1" }),
      chip("routine", { at: "work", pillar: "routines", id: "r1" }),
    ]) {
      const r = rig();
      await openHit(h, "box", r.deps);
      views.push(r.did.find((d) => d[0] === "view")?.[1]);
    }
    expect(views).toEqual([
      { workspaceId: "purdue", view: "tasks", task: "t1" },
      { workspaceId: "purdue", view: "projects", task: "t2" },
      { workspaceId: "purdue", view: "agenda", event: "e1" },
      { workspaceId: "purdue", view: "people", person: "p1" },
      { workspaceId: "purdue", view: "projects", project: "j1" },
      { workspaceId: "purdue", view: "files" },
      { workspaceId: "purdue", view: "routines" },
    ]);
    const held = rig();
    expect(await openHit(chip("held", { at: "work", pillar: "outbox", id: "h1" }), "mac", held.deps)).toBe("opened");
    expect(held.did).toEqual([["clear"], ["held", "h1", "mac"], ["opened", "mac", "lifeos:mailThreads:m1"]]);
    const item = rig();
    expect(await openHit(chip("item", { at: "item", id: "i1" }), "box", item.deps)).toBe("nothing");
    expect(item.did).toEqual([]);
  });
});

describe("a new thread about a hit", () => {
  const chip: ContextChip = { kind: "mail", label: "Budget for the LAN", ref: { at: "lifeos", table: "mailThreads", id: "m1" } };
  it("starts in the hit's job with the thing as its chip", () => {
    const r = rig();
    expect(startAbout(hit({ chip, workspaceId: "cosmic" }), r.deps)).toBe(true);
    expect(r.did).toEqual([["clear"], ["startThread", "Budget for the LAN", "cosmic"]]);
  });
  it("is not offered for a kind that is no chip, a hit in no job, or a job that has gone", () => {
    const r = rig();
    expect(canStartAbout(hit())).toBe(false);
    expect(canStartAbout(hit({ chip, workspaceId: null }))).toBe(false);
    expect(canStartAbout(hit({ chip }))).toBe(true);
    expect(startAbout(hit(), r.deps)).toBe(false);
    expect(startAbout(hit({ chip, workspaceId: "removed" }), r.deps)).toBe(false);
    expect(r.did).toEqual([]);
  });
});
