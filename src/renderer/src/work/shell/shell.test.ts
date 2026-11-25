import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MenuRow } from "../../chrome/menuRows";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { switchLine } from "../../surfaces/settings/Work";
import { sectorName } from "./actions";
import { columnProjects } from "./WorkColumn";
import { keyLine } from "./settings";
import { addMenuRows, addMenuState, freeSectors, sectorMenuRows, sectorMenuShown } from "./WorkRailHost";
import { rowOfView, TEMPLATES_ROW, WORK_VIEWS, workViewList, workViewRows } from "../views/registry";

vi.mock("../../lib/linkMay", async (original) => (await import("../../lib/linkMay.testkit")).linkMayMock(await original()));
const { GIVEN_KEY, OWNER_KEY, resetTestKey, testKey } = await import("../../lib/linkMay.testkit");
afterEach(resetTestKey);

describe("a code workspace's sector menu on the rail", () => {
  const code = { kind: "code", environmentId: "env_box" } as Pick<WorkspaceMeta, "kind" | "environmentId">;
  const on = new Set(["env_box"]);

  it("is offered to a key that may link a sector there, and never to a given computer's, which the host would refuse", () => {
    expect(sectorMenuShown(code, on)).toBe(true);
    testKey.current = OWNER_KEY;
    expect(sectorMenuShown(code, on)).toBe(true);
    testKey.current = GIVEN_KEY;
    expect(sectorMenuShown(code, on)).toBe(false);
  });

  it("is offered on a code workspace alone, on a host with Work on", () => {
    expect(sectorMenuShown({ ...code, kind: "work" }, on)).toBe(false);
    expect(sectorMenuShown(code, new Set())).toBe(false);
  });
});

const ids = (rows: MenuRow[]): string[] => rows.map((r) => (r.kind === "sep" ? "—" : r.kind === "label" ? r.label : r.id));

describe("the Work heading's + menu", () => {
  const work = (sector: string | null) => ({ kind: "work", sector }) as Pick<WorkspaceMeta, "kind" | "sector">;

  it("lists the sectors with no Work workspace yet, in LifeOS's order, then Without a sector", () => {
    const free = freeSectors([work("purdue"), work("hypixel"), { kind: undefined, sector: "cosmic" }, work(null)]);
    // A code workspace linked to a sector does not take it.
    expect(free).toEqual(["cosmic", "ref", "unify", "life"]);
    expect(ids(addMenuRows("connected", ["cosmic", "life"], new Map([["cosmic", "CosmicGames"]])))).toEqual(["work:add:cosmic", "work:add:life", "—", "work:add-unlinked"]);
    const first = addMenuRows("connected", ["cosmic"], new Map([["cosmic", "CosmicGames"]]))[0];
    expect(first.kind === "item" && first.label).toBe("CosmicGames");
  });

  it("offers the sign-in signed out, Retry when LifeOS is down, and Without a sector always", () => {
    expect(ids(addMenuRows("signed-out", ["cosmic"]))).toEqual(["work:signin", "—", "work:add-unlinked"]);
    expect(ids(addMenuRows("pairing", ["cosmic"]))).toEqual(["work:code", "—", "work:add-unlinked"]);
    expect(ids(addMenuRows("refused", []))).toEqual(["work:signin", "—", "work:add-unlinked"]);
    expect(ids(addMenuRows("unreachable", ["cosmic"]))).toEqual(["work:retry", "—", "work:add-unlinked"]);
    expect(ids(addMenuRows("connecting", ["cosmic"]))).toEqual(["work:connecting", "—", "work:add-unlinked"]);
    // Council round 12 (Opus, the rest 1): no status heard yet is a muted bone, never a wait the host has not said.
    expect(ids(addMenuRows(null, ["cosmic"]))).toEqual(["work:reading", "—", "work:add-unlinked"]);
    // Every sector taken: Without a sector alone.
    expect(ids(addMenuRows("connected", []))).toEqual(["work:add-unlinked"]);
  });

  /** Council round 11 (Sol rest 2): the wait names its computer, and Retry answers in the open menu. */
  it("names the computer in the wait, and keeps the menu open on Retry, its row spinning while it asks", () => {
    const [wait] = addMenuRows("connecting", ["cosmic"], undefined, undefined, null, "The box");
    expect(wait.kind === "note" && renderToStaticMarkup(wait.content as never)).toContain("LifeOS is still connecting on the box");
    const [retry] = addMenuRows("unreachable", ["cosmic"], undefined, "LifeOS did not answer the box", null, "The box");
    expect(retry).toMatchObject({ id: "work:retry", keepOpen: true });
    expect(retry.kind === "item" && retry.busy).toBeFalsy();
    const [asking] = addMenuRows("unreachable", ["cosmic"], undefined, "LifeOS did not answer the box", null, "The box", true);
    expect(asking).toMatchObject({ id: "work:retry", keepOpen: true, busy: true });
    // Only Retry stays: Sign in opens its dialog, which closes the menu.
    const [signIn] = addMenuRows("signed-out", ["cosmic"], undefined, "Not signed in to LifeOS on the box", null, "The box", true);
    expect(signIn.kind === "item" && (signIn.keepOpen || signIn.busy)).toBeFalsy();
  });

  /** Council round 5 (Opus, the rail's Work menu): a host whose status went unanswered read "Connecting to LifeOS…" for good. */
  it("reads a home host whose status went unanswered as down, with Retry, the computer named as the views name it", () => {
    expect(addMenuState(null, { client: null, state: "connecting", unanswered: true })).toBe("unanswered");
    expect(addMenuState(null, { client: null, state: "connecting" })).toBeNull();
    const off = { lifeos: { state: "off" as const }, keys: [] };
    expect(addMenuState(off, { client: null, state: "off", unanswered: true })).toBe("off");
    const [retry] = addMenuRows(addMenuState(null, { client: null, state: "connecting", unanswered: true }), ["cosmic"], undefined, "The box did not answer");
    expect(retry).toMatchObject({ id: "work:retry", label: "Retry", description: "The box did not answer" });
    // Work off: Open Settings, where the switch is, for a key that may turn it on; else who can, with no press.
    const [settings] = addMenuRows("off", [], undefined, "Work is off on the box");
    expect(settings).toMatchObject({ kind: "item", id: "work:settings", label: "Open Settings", description: "Work is off on the box" });
    const [note] = addMenuRows("off", [], undefined, "Work is off on the box", "Changed from a computer that manages the box");
    expect(note.kind).toBe("note");
    expect(ids(addMenuRows("off", [], undefined, "Work is off on the box", "Changed from a computer that manages the box"))).toEqual(["work:off", "—", "work:add-unlinked"]);
  });

  /** Council round 6: a sign-in is offered only where this window may sign the host in, as every reader offers it. */
  it("offers Sign in and Show the code only where this window may sign the host in; else the state and who can", () => {
    const elsewhere = "Sign in from a computer that manages the box";
    expect(addMenuRows("signed-out", [], undefined, "Not signed in to LifeOS on the box")[0]).toMatchObject({ kind: "item", id: "work:signin", label: "Sign in…", description: "Not signed in to LifeOS on the box" });
    // Council round 7 (Sol, the rest 1): the row is named for what its press does, the code, and the state is its words.
    expect(addMenuRows("pairing", [], undefined, "The LifeOS sign-in on the box waits for your approval")[0]).toMatchObject({ kind: "item", id: "work:code", label: "Show the code…", description: "The LifeOS sign-in on the box waits for your approval" });
    for (const state of ["signed-out", "refused", "pairing"] as const) {
      const rows = addMenuRows(state, [], undefined, "Said", elsewhere);
      expect(rows[0]).toMatchObject({ kind: "note", id: "work:signin-elsewhere" });
      expect(rows.some((row) => row.kind === "item" && (row.id === "work:signin" || row.id === "work:code"))).toBe(false);
    }
  });

  /** Council round 7 (Sol, the rest 1): a host signed in to LifeOS that keeps its session from this computer took the connected branch, with no word. */
  it("reads this window's own session once the host says connected: a withheld one is a note, with no press and no sectors", () => {
    const connected = { lifeos: { state: "connected" as const, ownerId: "landon", since: 1 }, keys: [] };
    expect(addMenuState(connected, { client: null, state: "unreachable", withheld: true })).toBe("withheld");
    expect(addMenuState(connected, { client: null, state: "unreachable", unanswered: true })).toBe("unanswered");
    // Its JWT still out: on its way, and the sectors stand.
    expect(addMenuState(connected, { client: null, state: "connected" })).toBe("connected");
    const rows = addMenuRows("withheld", ["cosmic"], undefined, "This computer cannot read LifeOS through the box");
    expect(ids(rows)).toEqual(["work:withheld", "—", "work:add-unlinked"]);
    expect(rows[0].kind).toBe("note");
  });
});

describe("a code workspace's LifeOS sector submenu", () => {
  it("is None and each sector, the linked one ticked", () => {
    const [sub] = sectorMenuRows("purdue", "connected");
    expect(sub.kind).toBe("sub");
    if (sub.kind !== "sub") return;
    expect(ids(sub.items)).toEqual(["work:link:none", "work:link:cosmic", "work:link:hypixel", "work:link:purdue", "work:link:ref", "work:link:unify", "work:link:life"]);
    expect(sub.items.filter((r) => r.kind === "item" && r.checked).map((r) => (r.kind === "item" ? r.id : ""))).toEqual(["work:link:purdue"]);
  });

  it("waits for a sign-in when nothing is linked yet, and never hides a link that exists", () => {
    const [unlinked] = sectorMenuRows(null, "signed-out");
    expect(unlinked.kind === "sub" && unlinked.disabled).toBe(true);
    const [linked] = sectorMenuRows("ref", "signed-out");
    expect(linked.kind === "sub" && linked.disabled).toBe(false);
  });
});

describe("Settings → Work's lines", () => {
  const envs = [
    { id: "local", name: "This Mac" },
    { id: "env_box", name: "tempcode-box" },
  ];
  it("says what the switch adds while off, nothing while every host agrees, and which hosts differ", () => {
    expect(switchLine(envs, new Set())).toBe("On adds the Outbox, Work Chats and your Work workspaces to the rail");
    expect(switchLine(envs, new Set(["local", "env_box"]))).toBeUndefined();
    expect(switchLine(envs, new Set(["env_box"]))).toBe("On for tempcode-box, off for this Mac");
    // "the box" mid-line, as every Work line names it.
    expect(switchLine([{ id: "env_box", name: "The box" }, { id: "local", name: "This Mac" }], new Set(["env_box"]))).toBe("On for the box, off for this Mac");
  });

  it("says nothing of a ready key, and why another is not", () => {
    expect(keyLine(undefined)).toBeNull();
    expect(keyLine({ workspaceId: "w", sectors: ["purdue"], state: "ready" })).toBeNull();
    expect(keyLine({ workspaceId: "w", sectors: ["purdue"], state: "failed", error: "a lifeos row is in the way" })).toEqual({ line: "a lifeos row is in the way", failed: true });
    expect(keyLine({ workspaceId: "w", sectors: ["purdue"], state: "elsewhere" })?.failed).toBeUndefined();
    // Council round 9 (Opus, Settings 2): a key that waits names the workspace's computer, never "this host" from afar.
    expect(keyLine({ workspaceId: "w", sectors: ["purdue"], state: "waiting" }, "The box")).toEqual({ line: "Its key is made once LifeOS is signed in on the box" });
    expect(keyLine({ workspaceId: "w", sectors: ["purdue"], state: "waiting" }, "MacBook")?.line).toBe("Its key is made once LifeOS is signed in on MacBook");
  });
});

describe("the column's LifeOS projects", () => {
  it("are those still under way, in the Projects view's order: oldest first, the id settling a tie", () => {
    const rows = columnProjects([
      { _id: "a", name: "Wrap-up", status: "done", _creationTime: 1 },
      { _id: "b", name: "Spring LAN", status: "active", _creationTime: 30 },
      { _id: "c", name: "Nationals", status: "backlog", _creationTime: 10 },
      { _id: "d", name: "Dropped", status: "dropped", _creationTime: 2 },
      { _id: "f", name: "Tryouts", status: "paused", _creationTime: 20 },
      { _id: "e", name: "Sponsors", status: "paused", _creationTime: 20 },
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Nationals", "Sponsors", "Tryouts", "Spring LAN"]);
    // Only what a card needs leaves: nothing of the order's own fields.
    expect(rows[0]).toEqual({ id: "c", name: "Nationals" });
  });
  it("name a sector as LifeOS does, else by its key", () => {
    expect(sectorName("ref")).toBe("Ref");
    expect(sectorName("ref", new Map([["ref", "Referee"]]))).toBe("Referee");
  });
});

describe("WORK_VIEWS", () => {
  it("is Mail, Messages, Tasks, Projects, Agenda, People, Money, Docs, Files and Forms in that order, then Templates (once its row is on), Plays and Routines; none of them says a fact it has not read", async () => {
    expect(workViewRows().map((v) => v.label)).toEqual(["Mail", "Messages", "Tasks", "Projects", "Agenda", "People", "Money", "Files", "Forms", ...(TEMPLATES_ROW ? ["Templates"] : []), "Plays", "Routines"]);
    for (const view of Object.values(WORK_VIEWS)) {
      expect(view.chunk.name).toBe(`work-${view.id}-view`);
      expect(view.fact({} as WorkspaceMeta)).toBeNull();
      expect(typeof (await view.chunk.load()).View).toBe("function");
    }
  });

  it("has every view say whether it reads LifeOS: Money, Files, Forms, Templates, Plays and Routines read the host alone, so no sign-in or LifeOS line stands over them", () => {
    const reads = Object.fromEntries(Object.values(WORK_VIEWS).map((view) => [view.id, view.readsLifeos]));
    expect(reads).toEqual({ mail: true, messages: true, tasks: true, projects: true, agenda: true, prep: true, people: true, money: false, files: false, forms: false, templates: false, plays: false, routines: false });
  });

  it("draws no row for a view that stands inside another, and reads its parent's row as open while it shows", () => {
    // A meeting's page is a view of the workspace reached from an event: the column keeps its nine rows.
    expect(WORK_VIEWS.prep.inside).toBe("agenda");
    expect(workViewList().map((v) => v.id)).toContain("prep");
    expect(workViewRows().map((v) => v.id)).not.toContain("prep");
    expect(rowOfView("prep")).toBe("agenda");
    // Every other view is its own row, and an id the registry does not know is left as it is.
    for (const view of workViewRows()) expect(rowOfView(view.id)).toBe(view.id);
    expect(rowOfView("nowhere")).toBe("nowhere");
    for (const view of workViewList()) if (view.inside) expect(workViewRows().map((v) => v.id)).toContain(view.inside);
  });
});
