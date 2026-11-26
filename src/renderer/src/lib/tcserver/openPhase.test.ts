import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterOpen, markUsable, RELEASE_AFTER_MS, resetOpenPhase } from "./openPhase";

/** A link as afterOpen reads it: its id, whether its socket is up, and its closes. */
function fakeLink(environmentId: string) {
  const closes = new Set<() => void>();
  return {
    environmentId,
    connected: true,
    onClose(fn: () => void) {
      closes.add(fn);
      return () => closes.delete(fn);
    },
    close() {
      this.connected = false;
      for (const fn of closes) fn();
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => resetOpenPhase());

describe("the second phase of a host's open", () => {
  it("waits until the window is usable, then runs in an idle slot", async () => {
    const link = fakeLink("local");
    const ran: string[] = [];
    afterOpen(link, () => void ran.push("inbox"));
    afterOpen(link, () => void ran.push("dev servers"));
    await flush();
    expect(ran).toEqual([]);
    markUsable();
    await flush();
    expect(ran).toEqual(["inbox", "dev servers"]);
  });

  it("runs one task at a time on a remote host", async () => {
    markUsable();
    const link = fakeLink("env_box");
    const steps: string[] = [];
    let finishFirst!: () => void;
    afterOpen(link, () => {
      steps.push("first asked");
      return new Promise<void>((resolve) => (finishFirst = resolve));
    });
    afterOpen(link, () => void steps.push("second asked"));
    await flush();
    expect(steps).toEqual(["first asked"]);
    finishFirst();
    await flush();
    expect(steps).toEqual(["first asked", "second asked"]);
  });

  it("asks nothing for an open whose socket has closed since: the next open asks again, once", async () => {
    const link = fakeLink("local");
    let asks = 0;
    afterOpen(link, () => void asks++);
    link.close();
    link.connected = true; // the next socket
    afterOpen(link, () => void asks++);
    markUsable();
    await flush();
    expect(asks).toBe(1);
  });

  it("a failed task does not stop the next on the same host", async () => {
    markUsable();
    const link = fakeLink("env_box");
    const ran: string[] = [];
    afterOpen(link, () => Promise.reject(new Error("older host")));
    afterOpen(link, () => void ran.push("next"));
    await flush();
    expect(ran).toEqual(["next"]);
  });
});

describe("the second phase's release and its socket", () => {
  afterEach(() => vi.useRealTimers());

  it("runs a bounded time after its first task when no shell paint ever comes", async () => {
    vi.useFakeTimers();
    const link = fakeLink("local");
    let asks = 0;
    afterOpen(link, () => void asks++);
    await vi.advanceTimersByTimeAsync(RELEASE_AFTER_MS - 1);
    expect(asks).toBe(0);
    // the release, then its idle slot
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(asks).toBe(1);
  });

  it("a route swapped with no close between runs the queued work once, on the new socket", async () => {
    const link = { ...fakeLink("env_box"), transport: { id: 1 } as unknown };
    const asked: unknown[] = [];
    const loader = () => afterOpen(link, () => void asked.push(link.transport));
    loader(); // the fallback route opened
    link.transport = { id: 2 }; // a better route adopted before the old one closed: onOpen again, no close
    loader();
    markUsable();
    await flush();
    expect(asked).toEqual([{ id: 2 }]);
  });
});

/** The asks a host hears on open, by phase: the window's own loaders against a scripted socket. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: { method: string }[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    const frame = JSON.parse(data) as { method?: string };
    if (frame.method) this.sent.push({ method: frame.method });
  }
  close() {}
  hello(environmentId: string) {
    this.readyState = 1;
    this.onmessage?.({ data: JSON.stringify({ push: "hello", environmentId, contract: 3, caps: ["read", "operate", "approve", "admin"] }) });
  }
}

const native = vi.hoisted(() => ({ port: 4321 }));
vi.mock("../native", async (original) => ({
  ...(await original<typeof import("../native")>()),
  isWebMode: () => false,
  getServerPort: () => Promise.resolve(native.port),
  readLaunchMirror: () => Promise.resolve(null),
  writeLaunchMirror: () => undefined,
  thisDesktopName: () => "This Mac",
}));
vi.mock("./smoke", () => ({ smoke: () => Promise.reject(new Error("not in tests")) }));

describe("a host's open, counted by phase", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks at most 15 before usable, none twice, and the rest after, once, with a saved host that never connects", async () => {
    const { registry, savedEnvironment } = await import("../connection");
    const { sessionStore } = await import("./store");
    const { workspaceStore } = await import("./workspaces");
    const { inboxStore } = await import("../inboxStore");
    const { rulesStore } = await import("./rules");
    const { slashCommandStore } = await import("./slashCommands");
    const { accountsStore } = await import("../../stores/accounts");
    const { workSwitch } = await import("../workSwitch");
    const { initServerLink } = await import("./link");
    const { startDevServers } = await import("../devServers");
    const { startThreadResources } = await import("../threadResources");
    const { startComputerHistory } = await import("../computerHistory");
    const { watchJob } = await import("../hostJobs");
    // a saved host with no mirror rows that never answers: the rail is never whole (no tc:rail-complete)
    registry.add(savedEnvironment({ id: "env_box", name: "box", routes: [{ url: "wss://box.example/ws", kind: "tunnel" }] }));
    // as main.tsx connects them, then the parts App starts
    sessionStore.connect(registry);
    workspaceStore.connect(registry);
    inboxStore.connect(registry);
    rulesStore.connect(registry);
    slashCommandStore.connect(registry);
    accountsStore.connect(registry);
    workSwitch.connect(registry);
    initServerLink();
    startDevServers();
    startThreadResources();
    startComputerHistory();
    watchJob("local", "deploy");
    await flush();
    const socket = FakeSocket.instances.find((s) => s.url === `ws://127.0.0.1:${native.port}`)!;
    socket.hello("env_mac");
    await flush();
    const first = socket.sent.map((f) => f.method);
    const twice = first.filter((m, i) => first.indexOf(m) !== i);
    expect(twice).toEqual([]);
    expect(first.length).toBeLessThanOrEqual(15);
    for (const later of ["doctor.get", "github.inbox", "devServer.runs", "resources.listAll", "host.log", "host.deployStatus"]) expect(first).not.toContain(later);
    // no shell paint is marked here: the bounded release lets the primary host's second phase go regardless
    await new Promise((r) => setTimeout(r, RELEASE_AFTER_MS + 100));
    await flush();
    const second = socket.sent
      .slice(first.length)
      .map((f) => f.method)
      .filter((m) => m !== "remote.environments.ticket");
    expect(second.filter((m) => m === "doctor.get")).toHaveLength(1);
    expect([...second].sort()).toEqual(["devServer.runs", "doctor.get", "github.inbox", "host.deployStatus", "host.log", "resources.listAll"]);
  });
});
