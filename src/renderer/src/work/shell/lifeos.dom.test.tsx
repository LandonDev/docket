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

  it("closes soon after the last screen that read it goes, and at once when Work goes off", async () => {
    vi.useFakeTimers();
    fakeHost();
    setWorkOn("env_box", true);
    setLifeosStatus("env_box", connected);
    const probe = mountProbe(<Reader sector="purdue" />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    probe.unmount();
    expect(clients[0]!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
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
    expect(sessionFailure("unreachable", false, "The box")).toBe("LifeOS did not answer");
    expect(sessionFailure("off")).toBe("Work is off on this host");
    expect(sessionFailure("unanswered")).toBe("The host did not answer");
  });

  it("never marks a host whose status is known, nor one that refused", async () => {
    resetLifeos();
    vi.spyOn(registry, "linkOf").mockReturnValue({ connected: true, onPush: () => () => {}, onOpen: () => () => {}, request: () => Promise.reject(new Error("Work is off on this host")) } as never);
    const { watchLifeos, refreshLifeos, useLifeosUnanswered } = await import("./lifeos");
    const { result } = renderHook(() => useLifeosUnanswered("env_far"));
    watchLifeos("env_far");
    await act(flush);
    expect(result.current).toBe(false);
    vi.spyOn(registry, "linkOf").mockReturnValue({ connected: true, request: () => Promise.reject(Object.assign(new Error("x"), { name: "TimeoutError" })) } as never);
    await act(() => expect(refreshLifeos("env_far")).rejects.toThrow());
    expect(result.current).toBe(false);
  });
});
