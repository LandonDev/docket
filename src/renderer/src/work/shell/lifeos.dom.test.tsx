// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { mountProbe } from "../../test/renderProbe";
import { registry } from "../../lib/connection";
import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { resetLifeos, setLifeosStatus, useLifeosSession } from "./lifeos";

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
});
