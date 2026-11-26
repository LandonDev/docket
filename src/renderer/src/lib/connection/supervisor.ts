import type { WireProfile } from "@server/shared/wire";
import { SAFE_READS } from "./link";
import { Transport } from "./transport";
import {
  IDLE_STATUS,
  isUnauthorizedMessage,
  type CloseReason,
  type Environment,
  type EnvironmentStatus,
  type Hello,
  type Route,
  type TransportState,
} from "./types";

/** Timers and randomness, injectable so tests run on fake time. */
export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random(): number;
};

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

export type Backoff = { baseMs: number; capMs: number; resetAfterMs: number; jitter: number };

/** 1 s doubling to a 5 min cap, ±25 % jitter, reset only after 30 s up. */
export const BACKOFF: Backoff = { baseMs: 1_000, capMs: 300_000, resetAfterMs: 30_000, jitter: 0.25 };
/** How often a session on a later route tries the earlier (better) ones. */
export const PREFLIGHT_MS = 2 * 60_000;
/** A probe fails after this long with nothing at all arriving on the socket. */
export const PROBE_TIMEOUT_MS = 5_000;
/** A socket still delivering (its answer queued behind others) is given this long in all. */
export const PROBE_LIMIT_MS = 30_000;
/** A cheap read the probe sends over the live session. */
export const PROBE_METHOD = "workspace.list";
/** A visible window asks once when this long passes with no frame in. */
export const HEARTBEAT_MS = 10_000;
/** A heartbeat missed: this long after its ask, nothing at all came in. */
export const HEARTBEAT_MISS_MS = 5_000;
/** Misses in a row that close the socket and redial: a dead link is found 20 s after its last frame. */
export const HEARTBEAT_MISSES = 2;
/** More misses allowed while a call that is never asked again (a write, a press: anything outside SAFE_READS) is
 *  out: a host stalled for a few seconds should not lose that call's answer to our close. 35 s from the last frame. */
export const HEARTBEAT_GRACE_MISSES = 3;
/** The heartbeat's ask: answered from memory, with no effect, to any key (capability `read`). */
export const HEARTBEAT_METHOD = "away.get";
/**
 * A visible window's wait between dials that could not reach the host: the
 * link's return is met within this, not after a doubled backoff. A host that
 * answered and then pushed back (a close code of its own) keeps the backoff.
 */
export const VISIBLE_RETRY_MS = 2_000;

export type ProbeTrigger = "foreground" | "online" | "offline" | "retry";

/** A close the host chose with a code that asks us to stay away (overloaded, policy, its own 4xxx). */
export function isPushback(reason: CloseReason): boolean {
  const code = reason.code;
  return code !== undefined && (code === 1008 || code === 1011 || code === 1013 || code >= 4000);
}

/** The delay before attempt `attempt` (0-based, after that many failures). */
export function backoffDelay(attempt: number, random: number, b: Backoff = BACKOFF): number {
  const raw = Math.min(b.capMs, b.baseMs * 2 ** attempt);
  const jittered = raw * (1 - b.jitter + 2 * b.jitter * random);
  return Math.min(b.capMs, Math.max(0, Math.round(jittered)));
}

export type SupervisorOptions = {
  environment: Environment;
  /**
   * The URL to open for a route, asked again on every attempt: a key route
   * gets a fresh 30 s ticket from the main process. Throws `unauthorized: …`
   * when the credential is refused and `unavailable: …` when the host did
   * not answer; either moves the walk to the next route.
   */
  resolveUrl: (route: Route) => Promise<string>;
  profileFor: (route: Route) => WireProfile;
  transport?: (url: string, profile: WireProfile) => Transport;
  clock?: Clock;
  backoff?: Backoff;
  preflightMs?: number;
  probeTimeoutMs?: number;
  probeMethod?: string;
  heartbeatMs?: number;
  heartbeatMissMs?: number;
  visibleRetryMs?: number;
  onStatus?: (status: EnvironmentStatus) => void;
  /** The live session changed: a replacement transport, or null while none. */
  onSession?: (session: Transport | null) => void;
};

/**
 * One environment's connection owner. It walks the routes best-first, keeps
 * one session, retries involuntary losses on a jittered exponential backoff
 * that resets only after the session stays up, probes the live session on
 * foreground / online / explicit retry and reconnects only when the probe
 * fails, beats a heartbeat while the window is visible (a link that went
 * silent is closed and redialed after two missed asks), meets a link's
 * return within VISIBLE_RETRY_MS while visible, preflights earlier routes while sitting on a later one, and never
 * retries a refused credential or a host that changed identity by itself.
 */
export class Supervisor {
  status: EnvironmentStatus = { ...IDLE_STATUS };
  session: Transport | null = null;
  environment: Environment;
  private readonly clock: Clock;
  private readonly backoff: Backoff;
  private retryTimer: unknown = null;
  private upTimer: unknown = null;
  private preflightTimer: unknown = null;
  private attempting: Promise<void> | null = null;
  private probing: Promise<void> | null = null;
  private heartbeatTimer: unknown = null;
  /** The heartbeat counts quiet from here at least: the session's adoption, or the window coming on
   *  screen (which probes on its own, so a beat then would be a second ask). */
  private quietFrom = 0;
  /** The window is on screen: only then does the heartbeat run and a failed dial retry soon. */
  private visible = false;
  private everOpened = false;
  private stopped = true;
  private online = true;
  /** The host answered with another environment's id: wait for an explicit retry. */
  private halted = false;
  /** The route the live session was opened over (its URL carries no ticket). */
  private liveRoute: Route | null = null;
  /** Bumps on stop/retry so a walk still in flight drops its result. */
  private generation = 0;

  constructor(private readonly options: SupervisorOptions) {
    this.environment = options.environment;
    this.clock = options.clock ?? realClock;
    this.backoff = options.backoff ?? BACKOFF;
  }

  /** Begin connecting. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.halted = false;
    void this.attempt();
  }

  /** Stop for good (the environment was removed): close the session, retry nothing. */
  stop(): void {
    this.stopped = true;
    this.generation++;
    this.clearRetry();
    this.clearUp();
    this.clearPreflight();
    this.clearHeartbeat();
    const session = this.session;
    this.session = null;
    this.liveRoute = null;
    session?.close({ kind: "local", message: "stopped" });
    this.set({ ...IDLE_STATUS, lastHello: this.status.lastHello });
    this.options.onSession?.(null);
  }

  /** The user asked: probe an open session, else try now, out of any state. */
  retry(): void {
    if (this.stopped) return;
    this.halted = false;
    if (this.status.transport === "unauthorized" || this.status.transport === "offline")
      this.status = { ...this.status, attempts: 0 };
    void this.probe("retry");
  }

  /** The window came on screen or left it. A hidden window sends no heartbeat. */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!visible) return this.clearHeartbeat();
    this.quietFrom = this.clock.now();
    if (this.session && !this.stopped) this.armHeartbeat(this.session);
  }

  /** The OS or browser said the network came or went. */
  setOnline(online: boolean): void {
    this.online = online;
    if (this.stopped) return;
    if (online) void this.probe("online");
    else if (this.session) void this.probe("offline");
    else {
      this.clearRetry();
      this.set({ ...this.status, transport: "offline", nextRetryAt: null });
    }
  }

  /**
   * Check the live session with one cheap request; only a failed probe
   * reconnects, and then at once. With no session, a pending retry fires now.
   */
  probe(trigger: ProbeTrigger): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.status.transport === "unauthorized" && trigger !== "retry") return Promise.resolve();
    if (this.halted && trigger !== "retry") return Promise.resolve();
    if (!this.online && trigger !== "online" && trigger !== "retry") {
      if (this.session) return this.probeSession(this.session, trigger);
      return Promise.resolve();
    }
    if (this.session) return this.probeSession(this.session, trigger);
    this.clearRetry();
    return this.attempt();
  }

  /** The stores finished their re-list on the live session (or lost it). */
  markFresh(fresh: boolean): void {
    if (this.status.fresh === fresh) return;
    this.set({ ...this.status, fresh });
  }

  /** Routes or name changed: keep the session if its route survived. */
  update(environment: Environment): void {
    this.environment = environment;
    const live = this.session;
    if (!live) return;
    const index = environment.routes.findIndex((r) => r.url === this.liveRoute?.url);
    if (index < 0) {
      live.close({ kind: "replaced", message: "route removed" });
      this.lost(live, { kind: "replaced", message: "route removed" });
      void this.attempt();
      return;
    }
    this.set({ ...this.status, route: index });
    this.schedulePreflight(index, 1_000);
  }

  // ── attempts ───────────────────────────────────────────────────────

  private attempt(): Promise<void> {
    if (this.attempting) return this.attempting;
    const generation = ++this.generation;
    this.attempting = this.walk(generation).finally(() => {
      this.attempting = null;
    });
    return this.attempting;
  }

  private async walk(generation: number): Promise<void> {
    this.clearRetry();
    this.set({ ...this.status, transport: this.pendingState(), nextRetryAt: null });
    const routes = this.environment.routes;
    let unauthorized = 0;
    let lastError: string | null = routes.length ? null : "no routes";
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      let url: string;
      try {
        url = await this.options.resolveUrl(route);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isUnauthorizedMessage(message)) unauthorized++;
        lastError = message;
        continue;
      }
      if (generation !== this.generation) return;
      const transport = this.open(url, route);
      try {
        const hello = await transport.open();
        if (generation !== this.generation) {
          transport.close({ kind: "local", message: "superseded" });
          return;
        }
        if (!this.adopt(transport, i, hello)) return;
        return;
      } catch (err) {
        const reason = transport.closeReason;
        if (reason?.kind === "unauthorized") unauthorized++;
        lastError = reason?.message ?? (err instanceof Error ? err.message : String(err));
      }
    }
    if (generation !== this.generation) return;
    if (unauthorized > 0) {
      this.set({ ...this.status, transport: "unauthorized", lastError, nextRetryAt: null });
      return;
    }
    if (!this.online) {
      this.set({ ...this.status, transport: "offline", lastError, nextRetryAt: null });
      return;
    }
    // No route reached a hello: nothing on the host was asked to do work, so a visible window may try again soon.
    this.scheduleRetry(lastError, this.visible);
  }

  private open(url: string, route: Route): Transport {
    const profile = this.options.profileFor(route);
    return this.options.transport ? this.options.transport(url, profile) : new Transport(url, profile);
  }

  /** A hello arrived on `transport`: make it the session. False when the host is not who we saved. */
  private adopt(transport: Transport, index: number, hello: Hello): boolean {
    const route = this.environment.routes[index] ?? null;
    const expected = this.environment.credentialRef ? this.environment.id : null;
    if (expected && hello.environmentId !== expected) {
      const message = `host identity changed: expected ${expected}, got ${hello.environmentId}`;
      transport.close({ kind: "protocol", message });
      this.halted = true;
      this.set({ ...this.status, transport: "offline", lastError: message, nextRetryAt: null, lastHello: hello });
      return false;
    }
    const previous = this.session;
    this.session = transport;
    this.quietFrom = this.clock.now();
    this.liveRoute = route;
    this.everOpened = true;
    this.clearRetry();
    this.clearUp();
    transport.onClose((reason) => this.lost(transport, reason));
    this.upTimer = this.clock.setTimeout(() => {
      this.upTimer = null;
      if (this.session === transport) this.set({ ...this.status, attempts: 0 });
    }, this.backoff.resetAfterMs);
    this.set({
      ...this.status,
      transport: "open",
      fresh: false,
      lastHello: hello,
      lastError: null,
      nextRetryAt: null,
      route: index,
    });
    this.options.onSession?.(transport);
    previous?.close({ kind: "replaced", message: "a better route answered" });
    this.schedulePreflight(index);
    this.armHeartbeat(transport);
    return true;
  }

  /** The session closed under us. Our own closes already moved on. */
  private lost(transport: Transport, reason: CloseReason): void {
    if (this.session !== transport) return;
    this.session = null;
    this.liveRoute = null;
    this.clearUp();
    this.clearPreflight();
    this.clearHeartbeat();
    this.status = { ...this.status, fresh: false, route: null };
    this.options.onSession?.(null);
    if (this.stopped || reason.kind === "replaced") {
      this.emit();
      return;
    }
    if (reason.kind === "unauthorized") {
      this.set({ ...this.status, transport: "unauthorized", lastError: reason.message, nextRetryAt: null });
      return;
    }
    if (reason.kind === "local") {
      // A failed probe closes with `local` and reconnects at once.
      this.set({ ...this.status, transport: this.pendingState(), lastError: reason.message, nextRetryAt: null });
      void this.attempt();
      return;
    }
    if (!this.online) {
      this.set({ ...this.status, transport: "offline", lastError: reason.message, nextRetryAt: null });
      return;
    }
    // The link went (no close of the host's choosing): a visible window meets its return soon.
    this.scheduleRetry(reason.message, this.visible && !isPushback(reason));
  }

  /** The next try on the backoff; `soon` holds it to VISIBLE_RETRY_MS (jittered) at most. */
  private scheduleRetry(lastError: string | null, soon = false): void {
    const attempts = this.status.attempts + 1;
    const random = this.clock.random();
    const backoff = backoffDelay(attempts - 1, random, this.backoff);
    const cap = this.options.visibleRetryMs ?? VISIBLE_RETRY_MS;
    const delay = soon ? Math.min(backoff, Math.round(cap * (1 - this.backoff.jitter + 2 * this.backoff.jitter * random))) : backoff;
    this.clearRetry();
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      void this.attempt();
    }, delay);
    this.set({
      ...this.status,
      transport: this.pendingState(),
      lastError,
      attempts,
      nextRetryAt: this.clock.now() + delay,
    });
  }

  private pendingState(): TransportState {
    return this.everOpened ? "reconnecting" : "connecting";
  }

  // ── probes ─────────────────────────────────────────────────────────

  private probeSession(session: Transport, trigger: ProbeTrigger): Promise<void> {
    if (this.probing) return this.probing;
    this.probing = (async () => {
      const ok = await this.withTimeout(
        session,
        session.request(this.options.probeMethod ?? PROBE_METHOD, undefined),
        this.options.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
      );
      if (this.session !== session || session.state !== "open") return;
      if (ok) {
        this.markFresh(true);
        return;
      }
      session.close({ kind: "local", message: `probe on ${trigger} failed` });
      this.lost(session, { kind: "local", message: `probe on ${trigger} failed` });
    })().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  /**
   * Whether the probe's answer came. Its deadline is silence, not the
   * answer's lateness: the host answers a socket's frames in order, so a
   * probe behind a long answer waits while those bytes still arrive. Every
   * `ms` with frames received gives it another `ms`, up to PROBE_LIMIT_MS;
   * a socket that took nothing for `ms` is dead. Closing a socket that was
   * delivering a catch-up made the window ask for it all again on the next
   * one (2026-11-23: six sockets in two minutes, each 8 MiB deep).
   */
  private withTimeout(session: Transport, request: Promise<unknown>, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const startedAt = this.clock.now();
      let seen = session.bytesIn ?? 0;
      let timer: unknown = null;
      const arm = (): void => {
        timer = this.clock.setTimeout(() => {
          const now = session.bytesIn ?? 0;
          if (now > seen && this.clock.now() - startedAt + ms <= PROBE_LIMIT_MS) {
            seen = now;
            arm();
          } else resolve(false);
        }, ms);
      };
      arm();
      request.then(
        () => {
          this.clock.clearTimeout(timer);
          resolve(true);
        },
        () => {
          this.clock.clearTimeout(timer);
          resolve(false);
        },
      );
    });
  }

  // ── heartbeat ──────────────────────────────────────────────────────

  /**
   * While visible: when HEARTBEAT_MS pass with no frame in, one small ask;
   * HEARTBEAT_MISS_MS with nothing at all in after it is a miss, and a
   * second miss in a row closes the socket and redials at once. Any frame
   * (an answer, a push, part of a long answer) is the link alive. The host's
   * own ping finds a silent socket only at its third 30 s tick; a window
   * left on screen through a sleep or a Wi-Fi change waited 87 s for that.
   */
  private armHeartbeat(session: Transport, delay?: number): void {
    this.clearHeartbeat();
    if (!this.visible || this.stopped || this.session !== session) return;
    const every = this.options.heartbeatMs ?? HEARTBEAT_MS;
    const lastFrame = (): number => Math.max(session.lastFrameAt ?? 0, this.quietFrom);
    const quietFor = (): number => this.clock.now() - lastFrame();
    this.heartbeatTimer = this.clock.setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.session !== session) return;
      const quiet = quietFor();
      if (quiet < every) return this.armHeartbeat(session, every - quiet);
      this.beat(session, 0);
    }, delay ?? Math.max(0, every - quietFor()));
  }

  private beat(session: Transport, misses: number): void {
    const before = session.bytesIn ?? 0;
    session.request(HEARTBEAT_METHOD, undefined).catch(() => undefined);
    this.heartbeatTimer = this.clock.setTimeout(() => {
      // Judged one macrotask later: a window that was busy when the deadline passed may hold a frame not yet
      // dispatched, and that frame is the link alive.
      this.heartbeatTimer = this.clock.setTimeout(() => {
        this.heartbeatTimer = null;
        if (this.session !== session || session.state !== "open") return;
        if ((session.bytesIn ?? 0) !== before) return this.armHeartbeat(session);
        const allowed = HEARTBEAT_MISSES + (this.holdsUnrepeatable(session) ? HEARTBEAT_GRACE_MISSES : 0);
        if (misses + 1 < allowed) return this.beat(session, misses + 1);
        const message = "heartbeat: the link went silent";
        session.close({ kind: "local", message });
        this.lost(session, { kind: "local", message });
      }, 0);
    }, this.options.heartbeatMissMs ?? HEARTBEAT_MISS_MS);
  }

  /** A call is out on the session that nothing asks again after a close: its answer is worth a longer wait. */
  private holdsUnrepeatable(session: Transport): boolean {
    const probe = this.options.probeMethod ?? PROBE_METHOD;
    return (session.pendingMethods?.() ?? []).some((m) => m !== HEARTBEAT_METHOD && m !== probe && !SAFE_READS.has(m));
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) this.clock.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // ── preflight ──────────────────────────────────────────────────────

  private schedulePreflight(index: number, delay = this.options.preflightMs ?? PREFLIGHT_MS): void {
    this.clearPreflight();
    if (index <= 0) return;
    this.preflightTimer = this.clock.setTimeout(() => {
      this.preflightTimer = null;
      void this.preflight();
    }, delay);
  }

  /** Try the routes ahead of the live one; the first that answers takes over. */
  private async preflight(): Promise<void> {
    const live = this.session;
    const liveIndex = this.status.route;
    if (!live || liveIndex === null || liveIndex <= 0 || this.stopped) return;
    const generation = this.generation;
    for (let i = 0; i < liveIndex; i++) {
      if (this.session !== live || generation !== this.generation) return;
      const route = this.environment.routes[i];
      let url: string;
      try {
        url = await this.options.resolveUrl(route);
      } catch {
        continue;
      }
      if (this.session !== live || generation !== this.generation) return;
      const transport = this.open(url, route);
      try {
        const hello = await transport.open();
        if (this.session !== live || generation !== this.generation) {
          transport.close({ kind: "local", message: "superseded" });
          return;
        }
        this.adopt(transport, i, hello);
        return;
      } catch {
        /* this route is still down; try the next */
      }
    }
    if (this.session === live) this.schedulePreflight(liveIndex);
  }

  // ── status ─────────────────────────────────────────────────────────

  private set(status: EnvironmentStatus): void {
    this.status = status;
    this.emit();
  }

  private emit(): void {
    this.options.onStatus?.(this.status);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearUp(): void {
    if (this.upTimer !== null) this.clock.clearTimeout(this.upTimer);
    this.upTimer = null;
  }

  private clearPreflight(): void {
    if (this.preflightTimer !== null) this.clock.clearTimeout(this.preflightTimer);
    this.preflightTimer = null;
  }
}
