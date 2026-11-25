// @vitest-environment jsdom
/**
 * A job he returns to is there at once (docs/agents/work-lifeos.md "Sessions kept" and "Rows kept"): the sessions of
 * the Work workspaces stay open, the column's queries stay subscribed on them, a query reads in its first render, and
 * the rows this window last read paint while the live ones come back. Every assertion counts asks, clients or renders.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { mountProbe } from "../../test/renderProbe";
import { registry } from "../../lib/connection";
import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { HOLD, keepLifeosOf, KeptRegion, resetLifeos, setLifeosStatus, startLifeosSession, useKeptRegion, useLifeosQuery, useLifeosSession, type LifeosQuery } from "./lifeos";

/**
 * A fake Convex client: LifeOS's rows live in `server`; a query has a local result only while it is subscribed and,
 * once `answers` is false, only if it was answered before (a client whose socket never answers again).
 */
type Fake = { url: string; closed: boolean; subs: Map<string, Set<() => void>>; local: Map<string, unknown>; answers: boolean };
const clients = vi.hoisted(() => [] as Fake[]);
const server = vi.hoisted(() => new Map<string, unknown>());
vi.mock("convex/react", async () => {
  const { getFunctionName: nameOf } = await import("convex/server");
  return {
    ConvexReactClient: class {
      fake: Fake;
      constructor(url: string) {
        this.fake = { url, closed: false, subs: new Map(), local: new Map(), answers: true };
        clients.push(this.fake);
      }
      setAuth() {}
      close() {
        this.fake.closed = true;
        return Promise.resolve();
      }
      watchQuery(ref: never, args: Record<string, unknown>) {
        const key = `${nameOf(ref)}|${JSON.stringify(args)}`;
        const fake = this.fake;
        return {
          localQueryResult: () => (fake.subs.get(key)?.size ? fake.local.get(key) : undefined),
          onUpdate(fn: () => void) {
            const set = fake.subs.get(key) ?? new Set();
            fake.subs.set(key, set);
            set.add(fn);
            if (fake.answers && server.has(key) && !fake.local.has(key)) queueMicrotask(() => answer(fake, key));
            return () => {
              set.delete(fn);
              // Convex drops a query's result when its last subscriber leaves.
              if (!set.size) fake.local.delete(key);
            };
          },
        };
      }
    },
  };
});

function answer(fake: Fake, key: string): void {
  if (!fake.subs.get(key)?.size) return;
  fake.local.set(key, server.get(key));
  for (const fn of fake.subs.get(key) ?? []) fn();
}
/** A change made elsewhere (a task ticked on the phone): every client that holds the query hears it. */
function changeElsewhere(key: string, value: unknown): void {
  server.set(key, value);
  for (const fake of clients) if (fake.answers && fake.subs.get(key)?.size) answer(fake, key);
}

const connected = { lifeos: { state: "connected" as const, ownerId: "landon", since: 1 }, keys: [] };
const signedOut = { lifeos: { state: "signed-out" as const }, keys: [] } as never;
let jwt: () => Promise<unknown> = () => Promise.resolve({ ok: true, jwt: "jwt-1", expiresAt: 2, url: "https://lifeos.test" });
let status: () => Promise<unknown> = () => Promise.resolve(connected);
let opens: (() => void)[] = [];
const asked: string[] = [];
function fakeHost(linkConnected = true) {
  const link = {
    environmentId: "env_box",
    connected: linkConnected,
    request: vi.fn((method: string) => {
      asked.push(method);
      return method === "work.lifeos.status" ? status() : jwt();
    }),
    onPush: () => () => {},
    onOpen: (fn: () => void) => {
      opens.push(fn);
      return () => void (opens = opens.filter((f) => f !== fn));
    },
  };
  vi.spyOn(registry, "linkOf").mockReturnValue(link as never);
  vi.spyOn(registry, "has").mockReturnValue(true);
  return link;
}
const count = (method: string) => asked.filter((m) => m === method).length;
const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

const TASKS = (sector: string) => `tasks:list|${JSON.stringify({ sector })}`;

/** The column's head: holds its sector's open tasks, as the Tasks fact does. */
function Column({ sector }: { sector: "purdue" | "cosmic" }) {
  const session = useLifeosSession("env_box", sector);
  const q = useLifeosQuery<unknown[]>(session, "tasks:list", { sector }, HOLD);
  return <span data-column={sector} data-q={q.status} />;
}

/** A view's list: what each render saw, so a test reads the first commit's. */
const seen: string[] = [];
function List({ sector = "purdue" as "purdue" | "cosmic" }) {
  const session = useLifeosSession("env_box", sector);
  const q: LifeosQuery<{ title: string; done?: boolean }[]> = useLifeosQuery(session, "tasks:list", { sector });
  seen.push(q.status === "ready" ? `${q.kept ? "kept" : "live"}:${q.value.map((t) => `${t.title}${t.done ? "✓" : ""}`).join(",")}` : q.status);
  return q.status === "ready" ? (
    <ul data-rows>
      {q.value.map((t) => (
        <li key={t.title} data-done={t.done ? "yes" : "no"}>
          {t.title}
        </li>
      ))}
    </ul>
  ) : (
    <div data-bones />
  );
}
function Frame({ sector = "purdue" as "purdue" | "cosmic" }) {
  const kept = useKeptRegion();
  return (
    <div role="region" aria-busy={kept.busy || undefined}>
      <KeptRegion value={kept.scope}>
        <List sector={sector} />
      </KeptRegion>
    </div>
  );
}

afterEach(() => {
  cleanup();
  resetLifeos();
  workSwitch.reset();
  clients.length = 0;
  server.clear();
  seen.length = 0;
  asked.length = 0;
  opens = [];
  jwt = () => Promise.resolve({ ok: true, jwt: "jwt-1", expiresAt: 2, url: "https://lifeos.test" });
  status = () => Promise.resolve(connected);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sessions kept", () => {
  it("switching A→B→A→B ten times, a minute apart, asks for 2 JWTs and makes 2 clients", async () => {
    vi.useFakeTimers();
    fakeHost();
    setLifeosStatus("env_box", connected);
    server.set(TASKS("purdue"), [{ title: "Book the arena" }]);
    server.set(TASKS("cosmic"), [{ title: "Patch notes" }]);
    for (let i = 0; i < 10; i++) {
      for (const sector of ["purdue", "cosmic"] as const) {
        const probe = mountProbe(<Column sector={sector} />);
        await act(() => vi.advanceTimersByTimeAsync(0));
        probe.unmount();
        await act(() => vi.advanceTimersByTimeAsync(60_000));
      }
    }
    expect(count("work.lifeos.jwt")).toBe(2);
    expect(clients).toHaveLength(2);
    expect(clients.every((c) => !c.closed)).toBe(true);
  });

  it("keeps the column's query subscribed on its session, so a return reads it live in its first commit", async () => {
    fakeHost();
    setLifeosStatus("env_box", connected);
    server.set(TASKS("purdue"), [{ title: "Book the arena" }]);
    const column = mountProbe(<Column sector="purdue" />);
    await flush();
    column.unmount();
    // The column's reader is gone; its hold is not.
    expect(clients[0]!.subs.get(TASKS("purdue"))?.size).toBe(1);
    const view = mountProbe(<Frame />);
    expect(seen[0]).toBe("live:Book the arena");
    expect(view.container.querySelector("[data-bones]")).toBeNull();
    expect(view.container.querySelector("[role=region]")?.hasAttribute("aria-busy")).toBe(false);
    view.unmount();
  });

  it("keeps at most 8 open, closing the least recently read with no reader; a session read now is never closed", async () => {
    vi.useFakeTimers();
    fakeHost();
    setLifeosStatus("env_box", connected);
    const sectors = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"] as never[];
    function Reader({ sector }: { sector: never }) {
      useLifeosSession("env_box", sector);
      return null;
    }
    const first = mountProbe(<Reader sector={sectors[0]!} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    for (const sector of sectors.slice(1)) {
      const probe = mountProbe(<Reader sector={sector} />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      probe.unmount();
    }
    // Nine opened: the oldest without a reader (s2) closed; s1, still read, stays.
    expect(clients.map((c) => c.closed)).toEqual([false, true, false, false, false, false, false, false, false]);
    first.unmount();
  });

  it("gives one session object while nothing changes and no session exists", () => {
    fakeHost();
    status = () => new Promise(() => {});
    const { result, rerender } = renderHook(() => useLifeosSession("env_box", "purdue"));
    const was = result.current;
    rerender();
    expect(result.current).toBe(was);
  });
});

describe("rows kept", () => {
  it("paints the last rows on a remount against a client that never answers, busy until the live rows land in place", async () => {
    fakeHost();
    setLifeosStatus("env_box", connected);
    server.set(TASKS("purdue"), [{ title: "Book the arena" }, { title: "Order jerseys" }]);
    const first = mountProbe(<Frame />);
    await flush();
    expect(seen.at(-1)).toBe("live:Book the arena,Order jerseys");
    first.unmount();
    clients[0]!.answers = false;
    seen.length = 0;

    const again = mountProbe(<Frame />);
    expect(seen[0]).toBe("kept:Book the arena,Order jerseys");
    expect(again.container.querySelectorAll("li")).toHaveLength(2);
    expect(again.container.querySelector("[data-bones]")).toBeNull();
    expect(again.container.querySelector("[role=region]")?.getAttribute("aria-busy")).toBe("true");

    // A task he ticked on the phone: the live answer shows it, in the same rows (no fade, no remount), and busy ends.
    const row = again.container.querySelector("li");
    clients[0]!.answers = true;
    act(() => changeElsewhere(TASKS("purdue"), [{ title: "Book the arena", done: true }, { title: "Order jerseys" }]));
    expect(seen.at(-1)).toBe("live:Book the arena✓,Order jerseys");
    expect(again.container.querySelector("li")).toBe(row);
    expect(row?.getAttribute("data-done")).toBe("yes");
    expect(again.container.querySelector("[role=region]")?.hasAttribute("aria-busy")).toBe(false);
    again.unmount();
  });

  it("paints kept rows while the session itself is on its way again", async () => {
    vi.useFakeTimers();
    fakeHost();
    setLifeosStatus("env_box", connected);
    server.set(TASKS("purdue"), [{ title: "Book the arena" }]);
    const first = mountProbe(<Frame />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    first.unmount();
    // Fifteen idle minutes: the session closes, the rows stay kept.
    await act(() => vi.advanceTimersByTimeAsync(15 * 60_000));
    expect(clients[0]!.closed).toBe(true);
    jwt = () => new Promise(() => {});
    seen.length = 0;
    const again = mountProbe(<Frame />);
    expect(seen[0]).toBe("kept:Book the arena");
    again.unmount();
  });

  /** After each drop, a remount against a client that never answers paints nothing kept. */
  async function keptThenRemount(drop: () => void, sector: "purdue" | "cosmic" = "purdue"): Promise<string | undefined> {
    server.set(TASKS(sector), [{ title: "Book the arena" }]);
    const first = mountProbe(<Frame sector={sector} />);
    await flush();
    first.unmount();
    for (const c of clients) c.answers = false;
    act(drop);
    await flush();
    seen.length = 0;
    const again = mountProbe(<Frame sector={sector} />);
    await flush();
    const firstSeen = seen[0];
    again.unmount();
    return firstSeen;
  }

  it("drops on sign-out", async () => {
    fakeHost();
    setLifeosStatus("env_box", connected);
    const firstSeen = await keptThenRemount(() => {
      setLifeosStatus("env_box", signedOut);
      setLifeosStatus("env_box", connected);
    });
    expect(firstSeen).toBe("loading");
    expect(clients[0]!.closed).toBe(true);
  });

  it("drops when Work goes off", async () => {
    fakeHost();
    setWorkOn("env_box", true);
    setLifeosStatus("env_box", connected);
    expect(await keptThenRemount(() => setWorkOn("env_box", false))).toBe("loading");
  });

  it("drops, and closes the session, when Work goes off on its host alone (Sol round 1, S8)", async () => {
    fakeHost();
    setWorkOn("env_box", true);
    setWorkOn("env_mac", true);
    setLifeosStatus("env_box", connected);
    expect(await keptThenRemount(() => setWorkOn("env_box", false))).toBe("loading");
    expect(clients[0]!.closed).toBe(true);
  });

  it("drops for a session gone down", async () => {
    vi.useFakeTimers();
    fakeHost();
    setLifeosStatus("env_box", connected);
    server.set(TASKS("purdue"), [{ title: "Book the arena" }]);
    const first = mountProbe(<Frame />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    first.unmount();
    await act(() => vi.advanceTimersByTimeAsync(15 * 60_000));
    // Its JWT is refused when it opens again: down. The query fails with the session's words, never kept rows under them.
    jwt = () => Promise.resolve({ ok: false, state: "refused" });
    seen.length = 0;
    const down = mountProbe(<Frame />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(seen[0]).toBe("kept:Book the arena");
    expect(seen.at(-1)).toBe("failed");
    down.unmount();
    // And once it is on its way again, nothing kept is left to paint.
    jwt = () => new Promise(() => {});
    act(() => setLifeosStatus("env_box", connected));
    const { reopenLifeos } = await import("./lifeos");
    void reopenLifeos("env_box", "purdue");
    await act(() => vi.advanceTimersByTimeAsync(0));
    seen.length = 0;
    const again = mountProbe(<Frame />);
    expect(seen[0]).toBe("loading");
    again.unmount();
  });

  it("drops for a workspace removed", async () => {
    fakeHost();
    setLifeosStatus("env_box", connected);
    const ws = (sector: string) => ({ environmentId: "env_box", kind: "work" as const, sector: sector as never });
    keepLifeosOf([ws("purdue"), ws("cosmic")]);
    const firstSeen = await keptThenRemount(() => keepLifeosOf([ws("cosmic")]));
    expect(firstSeen).toBe("loading");
  });

  it("never paints one sector's kept rows in another's", async () => {
    fakeHost();
    setLifeosStatus("env_box", connected);
    server.set(TASKS("purdue"), [{ title: "Book the arena" }]);
    const first = mountProbe(<Frame sector="purdue" />);
    await flush();
    first.unmount();
    for (const c of clients) c.answers = false;
    seen.length = 0;
    const other = mountProbe(<Frame sector="cosmic" />);
    await flush();
    expect(seen.every((s) => s === "loading")).toBe(true);
    other.unmount();
  });
});

describe("Work off on one host (Sol round 1, S8)", () => {
  it("a JWT still out when Work goes off on its host makes no client", async () => {
    fakeHost();
    setWorkOn("env_box", true);
    setWorkOn("env_mac", true);
    setLifeosStatus("env_box", connected);
    let release: (v: unknown) => void = () => {};
    jwt = () => new Promise((resolve) => (release = resolve));
    startLifeosSession("env_box", "purdue");
    act(() => setWorkOn("env_box", false));
    await act(async () => {
      release({ ok: true, jwt: "late", expiresAt: 2, url: "https://lifeos.test" });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(clients).toHaveLength(0);
  });
});

describe("a launch's session", () => {
  it("asks for the JWT beside the status when the last status said connected: one round trip, not two", async () => {
    localStorage.setItem("work.lifeos.connected.v1", JSON.stringify(["env_box"]));
    const link = fakeHost(false);
    status = () => new Promise(() => {});
    const probe = mountProbe(<Column sector="purdue" />);
    await flush();
    // The socket is not up yet: nothing is asked.
    expect(asked).toEqual([]);
    link.connected = true;
    act(() => {
      for (const open of [...opens]) open();
    });
    await flush();
    // The status ask is still out, and the session reads.
    expect(count("work.lifeos.status")).toBe(1);
    expect(count("work.lifeos.jwt")).toBe(1);
    expect(clients).toHaveLength(1);
    probe.unmount();
  });

  it("asks the status first for a host whose last status was not connected", async () => {
    fakeHost();
    status = () => new Promise(() => {});
    const probe = mountProbe(<Column sector="purdue" />);
    await flush();
    expect([count("work.lifeos.status"), count("work.lifeos.jwt")]).toEqual([1, 0]);
    probe.unmount();
  });

  it("closes a session a launch opened ahead once the status says signed out", async () => {
    localStorage.setItem("work.lifeos.connected.v1", JSON.stringify(["env_box"]));
    fakeHost();
    let say: (s: unknown) => void = () => {};
    status = () => new Promise((resolve) => (say = resolve));
    startLifeosSession("env_box", "purdue");
    await flush();
    expect(clients).toHaveLength(1);
    await act(async () => say(signedOut));
    expect(clients[0]!.closed).toBe(true);
    expect(localStorage.getItem("work.lifeos.connected.v1")).toBe("[]");
  });
});
