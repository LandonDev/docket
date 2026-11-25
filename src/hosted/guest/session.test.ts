import { describe, expect, it } from "vitest";
import { commentsOnPage, endWords, OpenFailed, openWhenUp, Session, STARTING_EVERY_MS, STARTING_FOR_MS, type Opened } from "./session";

describe("the hosted page's own Comment action", () => {
  it("shows for a guest who may comment or edit, and never for a viewer", () => {
    expect(commentsOnPage("guest", "comment")).toBe(true);
    expect(commentsOnPage("guest", "edit")).toBe(true);
    expect(commentsOnPage("guest", "view")).toBe(false);
  });

  it("does not show for the owner: his comments are made in TempCode, and the page would send none of his words", () => {
    expect(commentsOnPage("owner", "edit")).toBe(false);
    expect(commentsOnPage("owner", "comment")).toBe(false);
  });
});

const answer = (status: number, json: unknown) => ({ ok: status < 400, status, json: async () => json }) as Response;
const store = () => {
  let v: string | null = null;
  return { get: () => v, set: (next: string | null) => void (v = next) };
};

describe("a host that is starting", () => {
  it("answers 503, which the page reads as starting: never as gone, never as down", async () => {
    const session = new Session({ kind: "guest", id: "L1", secret: "s" }, "http://h", store(), async () => answer(503, { error: "starting" }));
    await expect(session.refresh()).rejects.toMatchObject({ why: "starting" });
    const gone = new Session({ kind: "guest", id: "L1", secret: "s" }, "http://h", store(), async () => answer(403, { error: "gone" }));
    await expect(gone.refresh()).rejects.toMatchObject({ why: "gone" });
  });

  it("is asked again every two seconds, and opens as soon as the host can say the link stands", async () => {
    let asked = 0;
    const slept: number[] = [];
    const opened = await openWhenUp(async () => (++asked < 4 ? Promise.reject(new OpenFailed("starting")) : ({ title: "Run of show" } as Opened)), { sleep: async (ms) => void slept.push(ms) });
    expect(opened.title).toBe("Run of show");
    expect(asked).toBe(4);
    expect(slept).toEqual([STARTING_EVERY_MS, STARTING_EVERY_MS, STARTING_EVERY_MS]);
  });

  it("after two minutes of starting the page cannot be reached; a link that is gone, or a busy host, is said at once", async () => {
    let clock = 0;
    let asked = 0;
    const waiting = openWhenUp(async () => (asked++, Promise.reject(new OpenFailed("starting"))), { now: () => clock, sleep: async (ms) => void (clock += ms) });
    await expect(waiting).rejects.toMatchObject({ why: "down" });
    expect(asked).toBe(STARTING_FOR_MS / STARTING_EVERY_MS + 1);
    for (const why of ["gone", "busy", "down"] as const) {
      let once = 0;
      await expect(openWhenUp(async () => (once++, Promise.reject(new OpenFailed(why))), { sleep: async () => {} })).rejects.toMatchObject({ why });
      expect(once).toBe(1);
    }
  });
});

describe("what the page keeps of a link between visits", () => {
  const opened = { kind: "doc", role: "edit", title: "Run of show", name: "Dana Lee", owner: "Landon Hale", expiresAt: Date.UTC(2026, 11, 18, 18), token: "t", tokenExp: 0, me: "guest:L1", doc: "kdocrun" };

  it("is when it ends, whose it is and the document it opened, written when it opens; a project's item and the owner's page write none", async () => {
    const memory = store();
    const session = new Session({ kind: "guest", id: "L1", secret: "s" }, "http://h", store(), async () => answer(200, opened), null, memory);
    expect(session.remembered()).toBeNull();
    await session.refresh();
    expect(session.remembered()).toEqual({ until: opened.expiresAt, owner: "Landon Hale", doc: "kdocrun" });
    const before = memory.get();
    await session.child({ table: "docs", id: "kother" }).refresh();
    expect(memory.get()).toBe(before);
    const own = store();
    await new Session({ kind: "owner", ticket: "t" }, "http://h", store(), async () => answer(200, { ...opened, renew: "r" }), null, own).refresh();
    expect(own.get()).toBeNull();
    // Something else under the key reads as nothing kept.
    memory.set("not json");
    expect(session.remembered()).toBeNull();
  });

  it("lets a link past its end say so, with the day and whose it was; any other link that opens nothing says only that", () => {
    const day = new Date(opened.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    expect(endWords({ until: opened.expiresAt, owner: "Landon Hale" }, opened.expiresAt + 1)).toEqual({ title: `This link ended ${day}`, detail: "Ask Landon Hale for a new one if you still need it." });
    expect(endWords({ until: opened.expiresAt }, opened.expiresAt + 1).detail).toBe("Ask the person who sent it for a new one if you still need it.");
    // Revoked, or a new address, before its end: nothing says which, on purpose.
    const plain = { title: "This link no longer opens anything", detail: "Ask the person who sent it if you still need it." };
    expect(endWords({ until: opened.expiresAt, owner: "Landon Hale" }, opened.expiresAt - 1)).toEqual(plain);
    expect(endWords(null)).toEqual(plain);
  });
});
