// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { mountProbe } from "../../test/renderProbe";
import { registry } from "../../lib/connection";
import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { resetLifeos, sessionWaits, setLifeosStatus, useLifeosQuery, useLifeosSession } from "./lifeos";

/** One fake Convex client per session the screens open; the test reads what each was asked. */
const clients = vi.hoisted(() => [] as { url: string; closed: boolean; auth: (() => Promise<string | null>) | null }[]);
vi.mock("convex/react", () => ({
  ConvexReactClient: class {
    record: { url: string; closed: boolean; auth: (() => Promise<string | null>) | null };
    constructor(url: string) {
      this.record = { url, closed: false, auth: null };
      clients.push(this.record);
    }
    setAuth(fetch: () => Promise<string | null>) {
      this.record.auth = fetch;
    }
    close() {
      this.record.closed = true;
      return Promise.resolve();
    }
  },
}));

const connected = { lifeos: { state: "connected" as const, ownerId: "landon", since: 1 }, keys: [] };
let answer: () => Promise<unknown> = () => Promise.resolve({ ok: true, jwt: "jwt-1", expiresAt: 2, url: "https://lifeos.test" });
function fakeHost() {
  vi.spyOn(registry, "linkOf").mockReturnValue({
    environmentId: "env_box",
    connected: true,
    request: vi.fn(() => answer()),
    onPush: () => () => {},
    onOpen: () => () => {},
  } as never);
}
function Reader({ sector }: { sector: "purdue" | null }) {
  const session = useLifeosSession("env_box", sector);
  return <span data-state={session.state} data-client={session.client ? "yes" : "no"} />;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  resetLifeos();
  workSwitch.reset();
  clients.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a screen's LifeOS session", () => {
  it("opens a client on the address the JWT is good for, and hands the first JWT to it", async () => {
    fakeHost();
    setLifeosStatus("env_box", connected);
    const probe = mountProbe(<Reader sector="purdue" />);
    await act(flush);
    expect(probe.container.querySelector("[data-client]")?.getAttribute("data-client")).toBe("yes");
    expect(clients.map((c) => c.url)).toEqual(["https://lifeos.test"]);
    expect(await clients[0]!.auth!()).toBe("jwt-1");
    probe.unmount();
  });

  it("closes 15 idle minutes after the last screen that read it goes, and at once when Work goes off", async () => {
    vi.useFakeTimers();
    fakeHost();
    setWorkOn("env_box", true);
    setLifeosStatus("env_box", connected);
    const probe = mountProbe(<Reader sector="purdue" />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    probe.unmount();
    expect(clients[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(clients[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(clients[0]!.closed).toBe(true);
    const again = mountProbe(<Reader sector={null} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(clients).toHaveLength(2);
    act(() => setWorkOn("env_box", false));
    expect(clients[1]!.closed).toBe(true);
    again.unmount();
  });

  it("drops a JWT that comes back after the host signed out", async () => {
    fakeHost();
    let release: (v: unknown) => void = () => {};
    answer = () => new Promise((resolve) => (release = resolve));
    setLifeosStatus("env_box", connected);
    const probe = mountProbe(<Reader sector="purdue" />);
    await act(flush);
    act(() => setLifeosStatus("env_box", { lifeos: { state: "signed-out" }, keys: [] } as never));
    await act(async () => {
      release({ ok: true, jwt: "late", expiresAt: 2, url: "https://lifeos.test" });
      await flush();
    });
    expect(clients).toHaveLength(0);
    expect(probe.container.querySelector("[data-state]")?.getAttribute("data-state")).toBe("signed-out");
    probe.unmount();
    answer = () => Promise.resolve({ ok: true, jwt: "jwt-1", expiresAt: 2, url: "https://lifeos.test" });
  });

  it("draws bones only while a session is on its way, and fails a query once it cannot read", async () => {
    expect(sessionWaits({ client: null, state: "connecting" })).toBe(true);
    expect(sessionWaits({ client: null, state: "connected" })).toBe(true);
    expect(sessionWaits({ client: null, state: "unreachable" })).toBe(false);
    expect(sessionWaits({ client: null, state: "signed-out" })).toBe(false);
    // The host says connected, but the JWT goes unanswered: the session is unreachable and so is every query on it.
    fakeHost();
    answer = () => Promise.reject(new Error("socket closed"));
    setLifeosStatus("env_box", connected);
    function Query() {
      const session = useLifeosSession("env_box", "purdue");
      const q = useLifeosQuery<unknown>(session, "tasks:list", {});
      return <span data-session={session.state} data-query={q.status} data-error={q.status === "failed" ? q.error : ""} />;
    }
    const probe = mountProbe(<Query />);
    await act(flush);
    const span = probe.container.querySelector("span")!;
    expect(span.getAttribute("data-session")).toBe("unreachable");
    expect(span.getAttribute("data-query")).toBe("failed");
    expect(span.getAttribute("data-error")).toBe("LifeOS did not answer");
    probe.unmount();
    answer = () => Promise.resolve({ ok: true, jwt: "jwt-1", expiresAt: 2, url: "https://lifeos.test" });
  });
});

describe("a host's status that could not be read", () => {
  const read = async (err: Error) => {
    resetLifeos();
    vi.spyOn(registry, "linkOf").mockReturnValue({ connected: true, onPush: () => () => {}, onOpen: () => () => {}, request: () => Promise.reject(err) } as never);
    const { watchLifeos, useLifeosStatus } = await import("./lifeos");
    watchLifeos("env_far");
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    const { result, unmount } = renderHook(() => useLifeosStatus("env_far"));
    const state = result.current?.lifeos.state ?? null;
    unmount();
    return state;
  };
  it("is Work off when the host refused, never signed out; unknown while the host is out of reach", async () => {
    expect(await read(new Error("Work is off on this host"))).toBe("off");
    expect(await read(Object.assign(new Error("not connected"), { name: "ConnectionLostError" }))).toBeNull();
  });

  /** Sol round 3 P1: a first ask that timed out on an open link is marked, so no screen keeps its bones for good. */
  it("marks a first ask that went unanswered, and Retry clears the mark once the host answers", async () => {
    resetLifeos();
    let reply: () => Promise<unknown> = () => Promise.reject(Object.assign(new Error("no answer in 15 s"), { name: "TimeoutError" }));
    vi.spyOn(registry, "linkOf").mockReturnValue({ connected: true, onPush: () => () => {}, onOpen: () => () => {}, request: () => reply() } as never);
    const { watchLifeos, refreshLifeos, useLifeosStatus, useLifeosUnanswered } = await import("./lifeos");
    const { result } = renderHook(() => ({ status: useLifeosStatus("env_far"), unanswered: useLifeosUnanswered("env_far") }));
    expect(result.current.unanswered).toBe(false);
    watchLifeos("env_far");
    await act(flush);
    expect(result.current).toEqual({ status: null, unanswered: true });
    // A Retry that goes unanswered keeps the mark and rejects, so the line stays as it is.
    await act(() => expect(refreshLifeos("env_far")).rejects.toThrow());
    expect(result.current.unanswered).toBe(true);
    reply = () => Promise.resolve(connected);
    await act(() => refreshLifeos("env_far"));
    expect(result.current).toEqual({ status: connected, unanswered: false });
  });

  /** Council round 4 (Opus P2, Sol P1): the session itself is down while the host's status went unanswered, never waiting. */
  it("reads a host whose status went unanswered as down, named, with Retry; a push, a reopened link or Retry brings it back", async () => {
    resetLifeos();
    const silent = () => Promise.reject(Object.assign(new Error("no answer in 15 s"), { name: "TimeoutError" }));
    let status: () => Promise<unknown> = silent;
    let push: ((p: unknown) => void) | null = null;
    let open: (() => void) | null = null;
    vi.spyOn(registry, "environment").mockReturnValue({ name: "The box" } as never);
    vi.spyOn(registry, "linkOf").mockReturnValue({
      connected: true,
      onPush: (fn: (p: unknown) => void) => ((push = fn), () => {}),
      onOpen: (fn: () => void) => ((open = fn), () => {}),
      request: (method: string) => (method === "work.lifeos.status" ? status() : answer()),
    } as never);
    const { reopenLifeos, sessionWords } = await import("./lifeos");
    const { downOf, downPress, downWords } = await import("./lifeosDown");
    const { result } = renderHook(() => useLifeosSession("env_far", "purdue"));
    await act(flush);
    const down = result.current;
    expect([down.state, down.unanswered, sessionWaits(down)]).toEqual(["unreachable", true, false]);
    expect(sessionWords(down)).toBe("The box did not answer");
    expect(downOf(down)).toBe("unanswered");
    expect([downWords("unanswered", "The box"), downPress("unanswered")]).toEqual(["The box did not answer", "retry"]);
    // A query on it fails at once with the same words: no reader keeps its bones.
    const query = renderHook(() => useLifeosQuery(result.current, "tasks:list", {}));
    await act(flush);
    expect(query.result.current).toEqual({ status: "failed", error: "The box did not answer" });
    query.unmount();

    // The host's push answers: the session opens.
    await act(async () => push!({ push: "work.lifeos", status: connected }));
    await act(flush);
    expect([result.current.state, !!result.current.client, result.current.unanswered]).toEqual(["connected", true, undefined]);

    // From the start again: a reopened link asks afresh, and its answer opens the session.
    resetLifeos();
    status = silent;
    const again = renderHook(() => useLifeosSession("env_far", null));
    await act(flush);
    expect(again.result.current.unanswered).toBe(true);
    status = () => Promise.resolve(connected);
    await act(async () => open!());
    await act(flush);
    expect(!!again.result.current.client).toBe(true);

    // And once more by Retry: the status asked again through refreshLifeos, then the session reopened.
    resetLifeos();
    status = silent;
    const third = renderHook(() => useLifeosSession("env_far", "purdue"));
    await act(flush);
    expect(third.result.current.unanswered).toBe(true);
    status = () => Promise.resolve(connected);
    await act(() => reopenLifeos("env_far", "purdue"));
    await act(flush);
    expect([third.result.current.state, !!third.result.current.client]).toEqual(["connected", true]);
  });

  it("names the computer a down session reads through, and says this host for one it does not know", async () => {
    const { sessionFailure } = await import("./lifeos");
    expect(sessionFailure("off", false, "The box")).toBe("Work is off on the box");
    expect(sessionFailure("unreachable", true, "The box")).toBe("This computer cannot read LifeOS through the box");
    expect(sessionFailure("refused", false, "MacBook")).toBe("LifeOS refused MacBook's sign-in");
    expect(sessionFailure("unanswered", false, "MacBook")).toBe("MacBook did not answer");
    // Council round 7: LifeOS's silence, signed out and a sign-in that waits name the computer too.
    expect(sessionFailure("unreachable", false, "The box")).toBe("LifeOS did not answer the box");
    expect(sessionFailure("signed-out", false, "The box")).toBe("Not signed in to LifeOS on the box");
    expect(sessionFailure("pairing", false, "MacBook")).toBe("The LifeOS sign-in on MacBook waits for your approval");
    expect(sessionFailure("unreachable")).toBe("LifeOS did not answer");
    expect(sessionFailure("signed-out")).toBe("Not signed in to LifeOS");
    expect(sessionFailure("off")).toBe("Work is off on this host");
    expect(sessionFailure("unanswered")).toBe("The host did not answer");
  });

  /** Council round 8 (Sol, Mail 1): the cached status hid a Retry the host did not answer. */
  it("marks a host whose status is known once its Retry goes unanswered, until its next answer; never one that refused", async () => {
    resetLifeos();
    vi.spyOn(registry, "linkOf").mockReturnValue({ connected: true, onPush: () => () => {}, onOpen: () => () => {}, request: () => Promise.reject(new Error("Work is off on this host")) } as never);
    const { watchLifeos, refreshLifeos, useLifeosUnanswered } = await import("./lifeos");
    const { result } = renderHook(() => useLifeosUnanswered("env_far"));
    watchLifeos("env_far");
    await act(flush);
    expect(result.current).toBe(false);
    vi.spyOn(registry, "linkOf").mockReturnValue({ connected: true, request: () => Promise.reject(Object.assign(new Error("x"), { name: "TimeoutError" })) } as never);
    await act(() => expect(refreshLifeos("env_far")).rejects.toThrow());
    expect(result.current).toBe(true);
    // Its next answer clears the mark.
    vi.spyOn(registry, "linkOf").mockReturnValue({ connected: true, request: async () => ({ lifeos: { state: "signed-out" }, keys: [] }) } as never);
    await act(() => refreshLifeos("env_far"));
    expect(result.current).toBe(false);
  });
});

/** Council round 5 (Sol P1): Retry and the session's own effect both opened the session; a late failure replaced the client. */
describe("one JWT ask a session", () => {
  function deferredHost(status: () => Promise<unknown>) {
    const asks: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
    vi.spyOn(registry, "linkOf").mockReturnValue({
      connected: true,
      onPush: () => () => {},
      onOpen: () => () => {},
      request: (method: string) => (method === "work.lifeos.status" ? status() : new Promise((resolve, reject) => asks.push({ resolve, reject }))),
    } as never);
    return asks;
  }
  const ok = { ok: true, jwt: "jwt-1", expiresAt: 2, url: "https://lifeos.test" };
  const timeout = () => Object.assign(new Error("no answer in 15 s"), { name: "TimeoutError" });

  it("answers the effect and Retry with one ask when the effect asks first, and keeps the client it made", async () => {
    resetLifeos();
    let status: () => Promise<unknown> = () => Promise.reject(timeout());
    const asks = deferredHost(() => status());
    const { reopenLifeos } = await import("./lifeos");
    const { result } = renderHook(() => useLifeosSession("env_one", "purdue"));
    await act(flush);
    expect(result.current.unanswered).toBe(true);
    status = () => Promise.resolve(connected);
    let retried: Promise<void> = Promise.resolve();
    await act(async () => {
      retried = reopenLifeos("env_one", "purdue");
      await flush();
    });
    expect(asks).toHaveLength(1);
    await act(async () => {
      asks[0]!.resolve(ok);
      await retried;
      await flush();
    });
    expect([result.current.state, !!result.current.client]).toEqual(["connected", true]);
    expect(clients).toHaveLength(1);
  });

  it("answers Retry and a reader that mounts while its ask is out with one ask, and says one failure", async () => {
    resetLifeos();
    const asks = deferredHost(() => Promise.resolve(connected));
    const { reopenLifeos } = await import("./lifeos");
    setLifeosStatus("env_two", connected);
    const retried = reopenLifeos("env_two", null).catch(() => {});
    await act(flush);
    const { result } = renderHook(() => useLifeosSession("env_two", null));
    await act(flush);
    expect(asks).toHaveLength(1);
    await act(async () => {
      asks[0]!.reject(timeout());
      await retried;
      await flush();
    });
    expect([result.current.state, result.current.client]).toEqual(["unreachable", null]);
  });

  it("never lets a failure that answers after a client was made take its place", async () => {
    resetLifeos();
    const asks = deferredHost(() => Promise.resolve(connected));
    setLifeosStatus("env_three", connected);
    const { result } = renderHook(() => useLifeosSession("env_three", "purdue"));
    await act(flush);
    await act(async () => {
      asks[0]!.resolve(ok);
      await flush();
    });
    expect(!!result.current.client).toBe(true);
    // A second ask of the same session once it reads starts nothing.
    const { reopenLifeos } = await import("./lifeos");
    await act(() => reopenLifeos("env_three", "purdue"));
    expect(asks).toHaveLength(1);
    expect([result.current.state, !!result.current.client]).toEqual(["connected", true]);
  });
});
