import { describe, expect, it } from "vitest";
import type { MenuRow } from "../../chrome/menuRows";
import type { WorkspaceMeta } from "../../lib/tcserver/types";
import { switchLine } from "../../surfaces/settings/Work";
import { sectorName } from "./actions";
import { columnProjects } from "./WorkColumn";
import { keyLine, lifeosLine } from "./settings";
import { addMenuRows, freeSectors, sectorMenuRows } from "./WorkRailHost";
import { rowOfView, TEMPLATES_ROW, WORK_VIEWS, workViewList, workViewRows } from "../views/registry";

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
    expect(ids(addMenuRows("refused", []))).toEqual(["work:signin", "—", "work:add-unlinked"]);
    expect(ids(addMenuRows("unreachable", ["cosmic"]))).toEqual(["work:retry", "—", "work:add-unlinked"]);
    expect(ids(addMenuRows("connecting", ["cosmic"]))).toEqual(["work:connecting", "—", "work:add-unlinked"]);
    // Every sector taken: Without a sector alone.
    expect(ids(addMenuRows("connected", []))).toEqual(["work:add-unlinked"]);
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
    expect(switchLine(envs, new Set(["env_box"]))).toBe("On for tempcode-box, off for This Mac");
  });

  it("draws every LifeOS state a screen must draw", () => {
    const now = 1_000_000;
    expect(lifeosLine({ state: "connected", ownerId: "landon", since: 1 })).toEqual({ line: "Signed in" });
    expect(lifeosLine({ state: "signed-out" })).toEqual({ line: "Not signed in" });
    expect(lifeosLine({ state: "pairing", expiresAt: now + 4 * 60_000 }, now)).toEqual({ line: "Waiting for approval, 4 min left" });
    expect(lifeosLine({ state: "connecting" })).toEqual({ line: "Connecting…" });
    expect(lifeosLine({ state: "unreachable", since: now, error: "x" }).failed).toBe(true);
    expect(lifeosLine({ state: "refused", error: "revoked" })).toEqual({ line: "LifeOS refused this host's sign-in", failed: true });
  });

  it("says nothing of a ready key, and why another is not", () => {
    expect(keyLine(undefined)).toBeNull();
    expect(keyLine({ workspaceId: "w", sectors: ["purdue"], state: "ready" })).toBeNull();
    expect(keyLine({ workspaceId: "w", sectors: ["purdue"], state: "failed", error: "a lifeos row is in the way" })).toEqual({ line: "a lifeos row is in the way", failed: true });
    expect(keyLine({ workspaceId: "w", sectors: ["purdue"], state: "elsewhere" })?.failed).toBeUndefined();
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
  it("is Mail, Messages, Tasks, Projects, Agenda, People, Money, Docs and Files in that order, then Templates (once its row is on), Plays and Routines; none of them says a fact it has not read", async () => {
    expect(workViewRows().map((v) => v.label)).toEqual(["Mail", "Messages", "Tasks", "Projects", "Agenda", "People", "Money", "Docs", "Files", ...(TEMPLATES_ROW ? ["Templates"] : []), "Plays", "Routines"]);
    for (const view of Object.values(WORK_VIEWS)) {
      expect(view.chunk.name).toBe(`work-${view.id}-view`);
      expect(view.fact({} as WorkspaceMeta)).toBeNull();
      expect(typeof (await view.chunk.load()).View).toBe("function");
    }
  });

  it("has every view say whether it reads LifeOS: Money, Files, Templates, Plays and Routines read the host alone, so no sign-in or LifeOS line stands over them", () => {
    const reads = Object.fromEntries(Object.values(WORK_VIEWS).map((view) => [view.id, view.readsLifeos]));
    expect(reads).toEqual({ mail: true, messages: true, tasks: true, projects: true, agenda: true, prep: true, people: true, money: false, docs: true, files: false, templates: false, plays: false, routines: false });
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
