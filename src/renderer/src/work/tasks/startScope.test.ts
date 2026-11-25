import { describe, expect, it, vi } from "vitest";
import type { ContextChip } from "@shared/work";
import { looseLine, startFiled, startScope, type StartPlace } from "./startScope";

/** A view's Start thread on a task files the thread under the task's LifeOS project, or loose with one quiet line. */

vi.mock("../shell/actions", () => ({ openLifeosProject: vi.fn() }));
vi.mock("../../components/ui/toaster", () => ({ loadToast: vi.fn() }));

const place: StartPlace = { id: "ws_purdue", environmentId: "box", path: "/w/Purdue" };
const chip: ContextChip = { kind: "task", label: "Book the hall", ref: { at: "lifeos", table: "tasks", id: "t1" } };
const opens = (id = "p_lan") => vi.fn(async () => ({ id }));

describe("where a start about a task files", () => {
  it("a task in an active project: under the project's mirror, opened with its id and name", async () => {
    const open = opens();
    expect(await startScope(place, { id: "lp_lan", name: "Spring LAN", status: "active" }, open)).toEqual({ at: { cwd: "/w/Purdue", projectId: "p_lan" }, line: null });
    expect(open).toHaveBeenCalledWith(place, "lp_lan", "Spring LAN");
  });

  it("a done or dropped project: loose, with its line, and the host is not asked", async () => {
    const open = opens();
    expect(await startScope(place, { id: "lp_old", name: "Fall LAN", status: "done" }, open)).toEqual({ at: null, line: "Not filed in Fall LAN: it is done" });
    expect(await startScope(place, { id: "lp_x", name: "Raffle", status: "dropped" }, open)).toEqual({ at: null, line: "Not filed in Raffle: it is dropped" });
    expect(open).not.toHaveBeenCalled();
  });

  it("no project: loose, saying nothing", async () => {
    expect(await startScope(place, null, opens())).toEqual({ at: null, line: null });
  });

  it("a project the host refuses or never answers for: loose, its line in plain words", async () => {
    const refused = vi.fn(async () => Promise.reject(new Error("Fall LAN is done: reopen it to start a thread in it")));
    expect(await startScope(place, { id: "lp_old", name: "Fall LAN" }, refused)).toEqual({ at: null, line: "Not filed in Fall LAN: it is done" });
    const down = vi.fn(async () => Promise.reject(new Error("LifeOS is not connected")));
    expect(await startScope(place, { id: "lp_lan" }, down)).toEqual({ at: null, line: looseLine({ id: "lp_lan" }, null) });
    expect(looseLine({ id: "lp_lan" }, null)).toBe("Not filed in its project: it could not be opened");
    const silent = vi.fn(() => new Promise<{ id: string }>(() => {}));
    expect(await startScope(place, { id: "lp_lan", name: "Spring LAN" }, silent, 10)).toEqual({ at: null, line: "Not filed in Spring LAN: it could not be opened" });
  });
});

describe("a view's start", () => {
  it("opens the composer under the project, and tells nothing", async () => {
    const start = vi.fn();
    const tell = vi.fn();
    await startFiled(start, place, chip, { id: "lp_lan", name: "Spring LAN" }, { open: opens(), tell });
    expect(start).toHaveBeenCalledWith(chip, { cwd: "/w/Purdue", projectId: "p_lan" });
    expect(tell).not.toHaveBeenCalled();
  });

  it("opens it loose and says one line when the project is finished; with no place or project, loose and quiet", async () => {
    const start = vi.fn();
    const tell = vi.fn();
    await startFiled(start, place, chip, { id: "lp_old", name: "Fall LAN", status: "done" }, { open: opens(), tell });
    expect(start).toHaveBeenLastCalledWith(chip);
    expect(tell).toHaveBeenCalledWith("Not filed in Fall LAN: it is done");
    await startFiled(start, null, chip, { id: "lp_lan" }, { open: opens(), tell });
    await startFiled(start, place, chip, null, { open: opens(), tell });
    expect(start).toHaveBeenCalledTimes(3);
    expect(start.mock.calls.slice(1).every((c) => c.length === 1)).toBe(true);
    expect(tell).toHaveBeenCalledTimes(1);
  });
});

describe("a mail's start", () => {
  it("files where its open task's project is, else loose", async () => {
    const { projectOfMail } = await import("./startScope");
    expect(await projectOfMail(async () => ({ task: { projectId: "lp_lan" } }), "m1")).toEqual({ id: "lp_lan" });
    expect(await projectOfMail(async () => ({ task: { projectId: null } }), "m1")).toBeNull();
    expect(await projectOfMail(async () => ({ task: null }), "m1")).toBeNull();
    expect(await projectOfMail(async () => null, "m1")).toBeNull();
    expect(await projectOfMail(() => Promise.reject(new Error("down")), "m1")).toBeNull();
    expect(await projectOfMail(() => new Promise(() => {}), "m1", 10)).toBeNull();
  });
});
