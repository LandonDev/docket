import { describe, expect, it } from "vitest";
import {
  BACKOFF,
  HEARTBEAT_GRACE_MISSES,
  HEARTBEAT_METHOD,
  HEARTBEAT_MISS_MS,
  HEARTBEAT_MISSES,
  HEARTBEAT_MS,
  PROBE_LIMIT_MS,
  Supervisor,
  VISIBLE_RETRY_MS,
  backoffDelay,
  type SupervisorOptions,
} from "./supervisor";
import { FakeClock, FakeTransport, HELLO, flush } from "./testing";
import type { Environment, EnvironmentStatus } from "./types";

const ROUTES = {
  lan: { url: "ws://10.0.0.5:7677/ws", kind: "lan" as const, credential: "key" as const },
  tunnel: { url: "wss://box.example/ws", kind: "tunnel" as const, credential: "key" as const },
};

function harness(overrides: Partial<SupervisorOptions> = {}, environment?: Partial<Environment>) {
  const clock = new FakeClock();
  const transports: FakeTransport[] = [];
  const statuses: EnvironmentStatus[] = [];
  const sessions: (FakeTransport | null)[] = [];
  const tickets: string[] = [];
  const env: Environment = {
    id: "env_host",
    name: "box",
    routes: [ROUTES.lan, ROUTES.tunnel],
    credentialRef: "env_host",
    ...environment,
  };
  const supervisor = new Supervisor({
    environment: env,
    resolveUrl: async (route) => {
      tickets.push(route.url);
      return `${route.url}?ticket=t${tickets.length}`;
    },
    profileFor: () => "remote",
    transport: (url, profile) => {
      const t = new FakeTransport(url, profile);
      transports.push(t);
      return t.asTransport();
    },
    clock,
    onStatus: (s) => statuses.push(s),
    onSession: (s) => sessions.push(s as unknown as FakeTransport | null),
    ...overrides,
  });
  return { clock, transports, statuses, sessions, tickets, supervisor, env };
}

/** Fail every transport still opening, letting the walk move on to the next route. */
async function failAll(h: ReturnType<typeof harness>) {
  for (;;) {
    await flush();
    const t = h.transports.find((x) => x.state === "opening");
    if (!t) return;
    t.failOpen();
    await flush();
  }
}

/** Start, fail the first route, answer the second: a session on route 1. */
async function openOnTunnel(h: ReturnType<typeof harness>) {
  h.supervisor.start();
  await flush();
  h.transports[0].failOpen();
  await flush();
  h.transports[1].answerHello();
  await flush();
  return h.transports[1];
}

describe("backoffDelay", () => {
  it("doubles from 1 s and caps at 5 min, with ±25 % jitter", () => {
    expect(backoffDelay(0, 0.5)).toBe(1000);
    expect(backoffDelay(1, 0.5)).toBe(2000);
    expect(backoffDelay(3, 0.5)).toBe(8000);
    expect(backoffDelay(0, 0)).toBe(750);
    expect(backoffDelay(0, 1)).toBe(1250);
    expect(backoffDelay(20, 0.5)).toBe(BACKOFF.capMs);
    expect(backoffDelay(20, 1)).toBe(BACKOFF.capMs);
    expect(backoffDelay(8, 1)).toBe(BACKOFF.capMs); // 256 s × 1.25 clamps
  });
});

describe("Supervisor", () => {
  it("walks the routes best-first and sits on the first that answers", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    expect(h.tickets).toEqual([ROUTES.lan.url, ROUTES.tunnel.url]);
    expect(h.transports[1].url).toBe(`${ROUTES.tunnel.url}?ticket=t2`);
    expect(h.supervisor.session).toBe(live.asTransport());
    expect(h.supervisor.status).toMatchObject({ transport: "open", route: 1, lastHello: HELLO, attempts: 0, fresh: false });
    expect(h.sessions).toEqual([live]);
    expect(h.statuses[0].transport).toBe("connecting");
  });

  it("retries a dead host on a jittered exponential backoff capped at five minutes", async () => {
    const h = harness();
    h.supervisor.start();
    await flush();
    await failAll(h);
    expect(h.supervisor.status).toMatchObject({ transport: "connecting", attempts: 1, nextRetryAt: h.clock.now() + 1000 });
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      const wait = h.supervisor.status.nextRetryAt! - h.clock.now();
      delays.push(wait);
      await h.clock.advance(wait);
      await failAll(h);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000]);
    expect(h.supervisor.status.attempts).toBe(11);
    expect(h.supervisor.status.lastError).toBe("could not connect");
  });

  it("jitter stays inside ±25 % of the step", async () => {
    const low = harness();
    low.clock.randomValue = 0;
    low.supervisor.start();
    await failAll(low);
    expect(low.supervisor.status.nextRetryAt! - low.clock.now()).toBe(750);
    const high = harness();
    high.clock.randomValue = 1;
    high.supervisor.start();
    await failAll(high);
    expect(high.supervisor.status.nextRetryAt! - high.clock.now()).toBe(1250);
  });

  it("resets the backoff only after a session stays up 30 s", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    // Lost after 5 s: the first retry waits 1 s, a second quick loss 2 s.
    await h.clock.advance(5_000);
    live.drop();
    await flush();
    expect(h.supervisor.status).toMatchObject({ transport: "reconnecting", attempts: 1 });
    expect(h.supervisor.status.nextRetryAt! - h.clock.now()).toBe(1000);
    await h.clock.advance(1000);
    h.transports[2].failOpen();
    await flush();
    h.transports[3].answerHello();
    await flush();
    expect(h.supervisor.status).toMatchObject({ transport: "open", attempts: 1 });
    await h.clock.advance(10_000);
    h.transports[3].drop();
    await flush();
    expect(h.supervisor.status.attempts).toBe(2);
    expect(h.supervisor.status.nextRetryAt! - h.clock.now()).toBe(2000);
    await h.clock.advance(2000);
    h.transports[4].failOpen();
    await flush();
    h.transports[5].answerHello();
    await flush();
    // Up for 30 s: the count clears, and the next loss waits 1 s again.
    await h.clock.advance(BACKOFF.resetAfterMs);
    expect(h.supervisor.status.attempts).toBe(0);
    h.transports[5].drop();
    await flush();
    expect(h.supervisor.status.nextRetryAt! - h.clock.now()).toBe(1000);
  });

  it("a probe that answers keeps the session and marks it fresh", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    const probe = h.supervisor.probe("foreground");
    await flush();
    expect(live.requests.map((r) => r.method)).toEqual(["workspace.list"]);
    live.requests[0].resolve([]);
    await probe;
    expect(h.supervisor.session).toBe(live.asTransport());
    expect(h.supervisor.status).toMatchObject({ transport: "open", fresh: true });
    expect(h.transports).toHaveLength(2);
  });

  it("a probe that times out reconnects at once, without a backoff wait", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    void h.supervisor.probe("foreground");
    await flush();
    await h.clock.advance(5_000);
    expect(live.state).toBe("closed");
    expect(live.closeReason?.message).toContain("probe on foreground failed");
    expect(h.sessions.at(-1)).toBeNull();
    // The new walk started with no timer in between.
    expect(h.transports).toHaveLength(3);
    expect(h.supervisor.status).toMatchObject({ transport: "reconnecting", nextRetryAt: null, attempts: 0 });
    h.transports[2].answerHello();
    await flush();
    expect(h.supervisor.status).toMatchObject({ transport: "open", route: 0 });
  });

  it("a probe behind a long answer waits while frames still arrive, up to the limit", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    void h.supervisor.probe("foreground");
    await flush();
    // The host is still sending a catch-up ahead of the probe's answer.
    for (let t = 0; t < 4; t++) {
      live.bytesIn += 1_000_000;
      await h.clock.advance(5_000);
      expect(live.state).toBe("open");
    }
    live.requests[0].resolve([]);
    await flush();
    expect(h.supervisor.session).toBe(live.asTransport());
    expect(h.transports).toHaveLength(2);
  });

  it("a probe whose socket keeps delivering but never answers fails at the limit", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    void h.supervisor.probe("foreground");
    await flush();
    for (let t = 0; t < PROBE_LIMIT_MS / 5_000; t++) {
      live.bytesIn += 1_000;
      await h.clock.advance(5_000);
    }
    expect(live.state).toBe("closed");
    expect(live.closeReason?.message).toContain("probe on foreground failed");
  });

  it("with no session, a probe fires the pending retry now", async () => {
    const h = harness();
    h.supervisor.start();
    await failAll(h);
    expect(h.clock.pending).toEqual([1000]);
    void h.supervisor.probe("online");
    await flush();
    expect(h.clock.pending).toEqual([]);
    expect(h.transports).toHaveLength(3);
  });

  it("a refused credential stops automatic retries; only an explicit retry tries again", async () => {
    const h = harness({
      resolveUrl: async (route) => {
        if (route.kind === "lan") throw new Error("unavailable: no answer");
        throw new Error("unauthorized: box rejected the key");
      },
    });
    h.supervisor.start();
    await flush();
    expect(h.supervisor.status).toMatchObject({ transport: "unauthorized", nextRetryAt: null });
    expect(h.supervisor.status.lastError).toMatch(/^unauthorized/);
    expect(h.clock.pending).toEqual([]);
    await h.supervisor.probe("foreground");
    await h.supervisor.probe("online");
    expect(h.transports).toHaveLength(0);
    h.supervisor.retry();
    await flush();
    expect(h.supervisor.status.transport).toBe("unauthorized"); // still refused, but it did ask again
    expect(h.supervisor.status.attempts).toBe(0);
  });

  it("a server close with 4401 is unauthorized too", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    live.close({ kind: "unauthorized", code: 4401, message: "key revoked" });
    await flush();
    expect(h.supervisor.status).toMatchObject({ transport: "unauthorized", lastError: "key revoked", nextRetryAt: null });
    expect(h.clock.pending).toEqual([]);
  });

  it("preflights the better route while on a later one and switches when it answers", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    expect(h.clock.pending).toEqual([30_000, 120_000]);
    await h.clock.advance(120_000);
    expect(h.transports).toHaveLength(3);
    expect(h.transports[2].url).toBe(`${ROUTES.lan.url}?ticket=t3`);
    expect(h.supervisor.session).toBe(live.asTransport()); // the old session serves until the new one is up
    h.transports[2].answerHello();
    await flush();
    expect(h.supervisor.session).toBe(h.transports[2].asTransport());
    expect(h.supervisor.status).toMatchObject({ transport: "open", route: 0, attempts: 0 });
    expect(live.state).toBe("closed");
    expect(live.closeReason?.kind).toBe("replaced");
    expect(h.sessions.at(-1)).toBe(h.transports[2]);
    expect(h.supervisor.status.nextRetryAt).toBeNull();
    // On the best route there is nothing left to preflight.
    expect(h.clock.pending).toEqual([30_000]);
  });

  it("a failed preflight keeps the session and tries again later", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    await h.clock.advance(120_000);
    h.transports[2].failOpen();
    await flush();
    expect(h.supervisor.session).toBe(live.asTransport());
    expect(h.clock.pending).toContain(120_000);
  });

  it("a saved host that answers with another id is held offline until retried", async () => {
    const h = harness();
    h.supervisor.start();
    await flush();
    h.transports[0].answerHello({ ...HELLO, environmentId: "env_other" });
    await flush();
    expect(h.transports[0].state).toBe("closed");
    expect(h.supervisor.session).toBeNull();
    expect(h.supervisor.status).toMatchObject({ transport: "offline", nextRetryAt: null });
    expect(h.supervisor.status.lastError).toContain("expected env_host, got env_other");
    expect(h.clock.pending).toEqual([]);
    await h.supervisor.probe("online");
    expect(h.transports).toHaveLength(1);
    h.supervisor.retry();
    await flush();
    expect(h.transports).toHaveLength(2);
  });

  it("the local environment accepts whatever id its server reports", async () => {
    const h = harness({}, { id: "local", credentialRef: null, routes: [{ url: "ws://127.0.0.1:4000", kind: "loopback", credential: "implicit" }] });
    h.supervisor.start();
    await flush();
    h.transports[0].answerHello({ ...HELLO, environmentId: "env_mac" });
    await flush();
    expect(h.supervisor.status).toMatchObject({ transport: "open", lastHello: { environmentId: "env_mac" } });
  });

  it("offline pauses retries; online probes or attempts", async () => {
    const h = harness();
    h.supervisor.start();
    await failAll(h);
    h.supervisor.setOnline(false);
    expect(h.supervisor.status.transport).toBe("offline");
    expect(h.clock.pending).toEqual([]);
    await h.supervisor.probe("foreground");
    expect(h.transports).toHaveLength(2);
    h.supervisor.setOnline(true);
    await flush();
    expect(h.transports).toHaveLength(3); // the walk opens one route at a time
    h.transports[2].answerHello();
    await flush();
    expect(h.supervisor.status.transport).toBe("open");
    // An offline report with a session up probes it rather than dropping it.
    h.supervisor.setOnline(false);
    await flush();
    expect(h.transports[2].requests.map((r) => r.method)).toEqual(["workspace.list"]);
  });

  it("stop closes the session and schedules nothing", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    h.supervisor.stop();
    expect(live.state).toBe("closed");
    expect(live.closeReason?.kind).toBe("local");
    expect(h.supervisor.status).toMatchObject({ transport: "offline", route: null, lastHello: HELLO });
    expect(h.clock.pending).toEqual([]);
    expect(h.sessions.at(-1)).toBeNull();
  });

  it("update keeps a session whose route survived and drops one whose route went", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    h.supervisor.update({ ...h.env, routes: [ROUTES.tunnel] });
    expect(h.supervisor.session).toBe(live.asTransport());
    expect(h.supervisor.status.route).toBe(0);
    h.supervisor.update({ ...h.env, routes: [ROUTES.lan] });
    await flush();
    expect(live.state).toBe("closed");
    expect(h.transports).toHaveLength(3);
    expect(h.transports[2].url).toContain(ROUTES.lan.url);
  });

  it("markFresh is the stores' word and a lost session clears it", async () => {
    const h = harness();
    const live = await openOnTunnel(h);
    h.supervisor.markFresh(true);
    expect(h.supervisor.status.fresh).toBe(true);
    live.drop();
    await flush();
    expect(h.supervisor.status.fresh).toBe(false);
  });
});

/** One route: a session opened on it with nothing else scheduled but the 30 s reset. */
async function openOne(visible: boolean) {
  const h = harness({}, { routes: [ROUTES.tunnel] });
  h.supervisor.setVisible(visible);
  h.supervisor.start();
  await flush();
  h.transports[0].answerHello();
  await flush();
  const live = h.transports[0];
  live.receive(200, h.clock.now()); // the hello
  return { h, live };
}

const asks = (t: FakeTransport): number => t.requests.filter((r) => r.method === HEARTBEAT_METHOD).length;

describe("Supervisor heartbeat (M6)", () => {
  it("a visible window finds a blackholed link and redials it within 20 s: two asks, one new socket", async () => {
    const { h, live } = await openOne(true);
    // Nothing comes in from here on: no bytes, no close.
    await h.clock.advance(HEARTBEAT_MS - 1);
    expect(asks(live)).toBe(0);
    await h.clock.advance(1);
    expect(asks(live)).toBe(1);
    await h.clock.advance(HEARTBEAT_MISS_MS);
    expect(asks(live)).toBe(2);
    expect(live.state).toBe("open");
    await h.clock.advance(HEARTBEAT_MISS_MS);
    // 20 s after the last frame: closed, and the redial already out, with no backoff wait.
    expect(live.state).toBe("closed");
    expect(live.closeReason?.message).toContain("heartbeat");
    expect(h.transports).toHaveLength(2);
    expect(h.tickets).toHaveLength(2);
    expect(h.supervisor.status).toMatchObject({ transport: "reconnecting", nextRetryAt: null });
  });

  it("a hidden window sends no heartbeat and keeps a silent socket", async () => {
    const { h, live } = await openOne(false);
    await h.clock.advance(100_000);
    expect(live.requests).toHaveLength(0);
    expect(live.state).toBe("open");
    expect(h.transports).toHaveLength(1);
  });

  it("hiding stops the heartbeat; coming back on screen starts it again, counted from then", async () => {
    const { h, live } = await openOne(true);
    await h.clock.advance(HEARTBEAT_MS);
    expect(asks(live)).toBe(1);
    h.supervisor.setVisible(false);
    await h.clock.advance(60_000);
    expect(asks(live)).toBe(1);
    expect(live.state).toBe("open");
    // Coming forward probes on its own (the registry's hook), so the next beat is a full quiet spell away.
    h.supervisor.setVisible(true);
    await h.clock.advance(HEARTBEAT_MS - 1);
    expect(asks(live)).toBe(1);
    await h.clock.advance(1);
    expect(asks(live)).toBe(2);
  });

  it("a link that keeps delivering is never asked; an answer to an ask keeps the socket", async () => {
    const { h, live } = await openOne(true);
    for (let i = 0; i < 20; i++) {
      await h.clock.advance(3_000);
      live.receive(500, h.clock.now());
    }
    expect(live.requests).toHaveLength(0);
    await h.clock.advance(HEARTBEAT_MS);
    expect(asks(live)).toBe(1);
    // The answer lands inside the miss window: alive, and the next ask waits another full quiet spell.
    await h.clock.advance(1_000);
    live.receive(40, h.clock.now());
    await h.clock.advance(HEARTBEAT_MISS_MS);
    expect(live.state).toBe("open");
    expect(asks(live)).toBe(1);
    await h.clock.advance(HEARTBEAT_MS - HEARTBEAT_MISS_MS);
    expect(asks(live)).toBe(2);
  });
});

describe("Supervisor heartbeat never cuts a healthy link (M6 review, finding 9)", () => {
  it("a frame dispatched after the miss deadline passed, before its check ran, keeps the socket", async () => {
    const { h, live } = await openOne(true);
    await h.clock.advance(HEARTBEAT_MS + HEARTBEAT_MISS_MS);
    expect(asks(live)).toBe(2);
    // The second deadline passes while the window is busy: its timer runs, and the check waits one macrotask.
    const clock = h.clock as unknown as { timers: { at: number; fn: () => void; id: number }[]; t: number };
    const due = clock.timers.filter((x) => x.at <= clock.t + HEARTBEAT_MISS_MS).sort((a, b) => a.at - b.at)[0]!;
    clock.t = due.at;
    clock.timers = clock.timers.filter((x) => x !== due);
    due.fn();
    expect(live.state).toBe("open");
    // The frame that was queued behind it is dispatched first.
    live.receive(64, h.clock.now());
    await h.clock.advance(0);
    expect(live.state).toBe("open");
    expect(h.transports).toHaveLength(1);
  });

  it("while a press is out it waits three misses more (35 s) before closing; with a read or a read mark out, 20 s", async () => {
    const held = await openOne(true);
    void held.live.request("work.outbox.decide", { ids: ["held_1"] }).catch(() => undefined);
    await held.h.clock.advance(HEARTBEAT_MS + HEARTBEAT_MISSES * HEARTBEAT_MISS_MS);
    expect(held.live.state).toBe("open");
    expect(asks(held.live)).toBe(HEARTBEAT_MISSES + 1);
    await held.h.clock.advance(HEARTBEAT_GRACE_MISSES * HEARTBEAT_MISS_MS - 1);
    expect(held.live.state).toBe("open");
    expect(asks(held.live)).toBe(HEARTBEAT_MISSES + HEARTBEAT_GRACE_MISSES);
    await held.h.clock.advance(1);
    expect(held.live.state).toBe("closed");
    // A window's own bookkeeping write (a read mark) and a read earn no grace: closed at 20 s.
    for (const method of ["session.events", "session.markRead"]) {
      const read = await openOne(true);
      void read.live.request(method, { sessionId: "s" }).catch(() => undefined);
      await read.h.clock.advance(HEARTBEAT_MS + HEARTBEAT_MISSES * HEARTBEAT_MISS_MS);
      expect(read.live.state).toBe("closed");
    }
    // A press sent in the ui lane earns it.
    const press = await openOne(true);
    press.live.uiPending = true;
    await press.h.clock.advance(HEARTBEAT_MS + HEARTBEAT_MISSES * HEARTBEAT_MISS_MS);
    expect(press.live.state).toBe("open");
  });
});

describe("Supervisor retry pace while visible (M6)", () => {
  it("a visible window's failed dials wait at most VISIBLE_RETRY_MS, a hidden one's double", async () => {
    const paced = async (visible: boolean): Promise<number[]> => {
      const h = harness();
      h.supervisor.setVisible(visible);
      h.supervisor.start();
      await failAll(h);
      const delays: number[] = [];
      for (let i = 0; i < 6; i++) {
        const wait = h.supervisor.status.nextRetryAt! - h.clock.now();
        delays.push(wait);
        await h.clock.advance(wait);
        await failAll(h);
      }
      return delays;
    };
    expect(await paced(true)).toEqual([1000, 2000, 2000, 2000, 2000, 2000]);
    expect(await paced(false)).toEqual([1000, 2000, 4000, 8000, 16000, 32000]);
  });

  it("the link's return after a long cut is met within VISIBLE_RETRY_MS, not a doubled backoff", async () => {
    const h = harness({}, { routes: [ROUTES.tunnel] });
    h.supervisor.setVisible(true);
    h.supervisor.start();
    await flush();
    h.transports[0].answerHello();
    await flush();
    // Cut: the socket drops and every dial fails for a minute.
    h.transports[0].drop();
    await flush();
    const cutEnds = h.clock.now() + 60_000;
    while (h.clock.now() < cutEnds) {
      await h.clock.advance(h.supervisor.status.nextRetryAt! - h.clock.now());
      await failAll(h);
    }
    expect(h.supervisor.status.attempts).toBeGreaterThan(20);
    // Back: the next dial is at most VISIBLE_RETRY_MS × 1.25 away.
    const wait = h.supervisor.status.nextRetryAt! - h.clock.now();
    expect(wait).toBeLessThanOrEqual(VISIBLE_RETRY_MS * 1.25);
    const dials = h.transports.length;
    await h.clock.advance(wait);
    expect(h.transports).toHaveLength(dials + 1);
    h.transports.at(-1)!.answerHello();
    await flush();
    expect(h.supervisor.status.transport).toBe("open");
  });

  it("a host that pushed back (1013) keeps its backoff even when visible", async () => {
    const h = harness({}, { routes: [ROUTES.tunnel] });
    h.supervisor.start();
    await failAll(h);
    for (let i = 0; i < 4; i++) {
      await h.clock.advance(h.supervisor.status.nextRetryAt! - h.clock.now());
      await failAll(h);
    }
    await h.clock.advance(h.supervisor.status.nextRetryAt! - h.clock.now());
    h.transports.at(-1)!.answerHello();
    await flush();
    expect(h.supervisor.status).toMatchObject({ transport: "open", attempts: 5 });
    h.supervisor.setVisible(true);
    h.transports.at(-1)!.close({ kind: "network", code: 1013, message: "socket send queue exceeded 64 MiB" });
    await flush();
    expect(h.supervisor.status.nextRetryAt! - h.clock.now()).toBe(backoffDelay(5, 0.5));
  });
});

