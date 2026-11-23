// @vitest-environment jsdom
/**
 * A deck and the real PowerPoint, against the window's real registry of hosts (ConnectionRegistry on a scripted
 * socket): a file names its host by the host's own id, which the window knows as "local". Asking PowerPoint of a
 * host the window has no name for must offer nothing, never throw: a throw in the canvas takes the whole Files
 * place down ("Files did not load: unknown environment").
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckView } from "@shared/contract-work-slides";
import type { CanvasSource } from "@shared/work";
import { localEnvironment, savedEnvironment } from "../../lib/connection";
import { HELLO, flush, type FakeTransport } from "../../lib/connection/testing";

const h = vi.hoisted(() => ({ registry: null as unknown as import("../../lib/connection").ConnectionRegistry, transports: [] as FakeTransport[] }));
vi.mock("../../lib/connection", async (original) => {
  const real = await original<typeof import("../../lib/connection")>();
  const { FakeClock, FakeTransport } = await import("../../lib/connection/testing");
  const registry = new real.ConnectionRegistry({
    clock: new FakeClock(),
    fetch: (async () => new Response(JSON.stringify({ environmentId: "env_mac", key: { id: "k" } }))) as typeof fetch,
    transport: (url, profile) => {
      const t = new FakeTransport(url, profile);
      h.transports.push(t);
      return t.asTransport();
    },
  });
  h.registry = registry;
  return { ...real, registry };
});

import { forgetPowerPoint, hostOf, openInPowerPoint, presentInPowerPoint, useInPowerPoint, useOpening } from "./powerpoint";

const VIEW = { slides: [] } as unknown as DeckView;
const deckOn = (host: string): CanvasSource => ({ at: "file", host, path: "/work/deck.pptx" });

function Probe({ source }: { source: CanvasSource }) {
  const ask = useInPowerPoint(VIEW, source, "local");
  const opening = useOpening("item");
  return (
    <span data-testid="probe">
      {ask ? "offered" : "none"} {opening?.state ?? ""}
    </span>
  );
}
/** Answers the next waiting request of a method on a socket. */
async function answer(t: FakeTransport, method: string, value: unknown): Promise<unknown> {
  await waitFor(() => expect(t.pendingMethods()).toContain(method));
  const at = t.requests.findIndex((r) => r.method === method);
  const [request] = t.requests.splice(at, 1);
  request.resolve(value);
  return request.params;
}

beforeEach(async () => {
  // The window's own host: known here as "local", and by its own id to every file on it.
  if (!h.registry.has("local")) {
    h.registry.add(localEnvironment(4000));
    await flush();
    h.transports[0].answerHello({ ...HELLO, environmentId: "env_box" });
    await flush();
  }
  forgetPowerPoint();
});
afterEach(cleanup);

describe("a deck's computer, as this window names it", () => {
  it("asks the window's own host about a file that names it by the host's own id, and offers In PowerPoint", async () => {
    const source = deckOn("env_box");
    expect(hostOf(source, "local")).toBe("local");
    render(<Probe source={source} />);
    expect(await answer(h.transports[0], "work.office.present", { can: true })).toEqual({ source, check: true });
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toContain("offered"));
  });

  it("offers nothing, and throws nothing, for a file on a computer this window has no link to", async () => {
    const source = deckOn("env_elsewhere");
    expect(hostOf(source, "local")).toBeNull();
    render(<Probe source={source} />);
    await flush();
    expect(screen.getByTestId("probe").textContent).toContain("none");
    expect(h.transports[0].pendingMethods()).not.toContain("work.office.present");
    await expect(presentInPowerPoint(source, "local")).rejects.toThrow("PowerPoint did not answer");
    await openInPowerPoint("item", source, "local");
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toContain("failed"));
  });

  it("asks a saved host by its own id, and the thread's host for a deck with no host of its own", async () => {
    h.registry.add(savedEnvironment({ id: "env_mac", name: "mac", routes: [{ url: "wss://mac.example/ws", kind: "tunnel" }] }));
    // A saved host's route opens with a ticket the window's own host hands out.
    await answer(h.transports[0], "remote.environments.ticket", { ticket: "tk_1", expiresIn: 30000 });
    await waitFor(() => expect(h.transports).toHaveLength(2));
    const mac = h.transports[1];
    mac.answerHello({ ...HELLO, environmentId: "env_mac" });
    await waitFor(() => expect(h.registry.linkOf("env_mac").connected).toBe(true));
    expect(hostOf(deckOn("env_mac"), "local")).toBe("env_mac");
    expect(hostOf({ at: "thread", path: "deck.pptx" } as CanvasSource, "local")).toBe("local");
    void presentInPowerPoint(deckOn("env_mac"), "local");
    expect(await answer(mac, "work.office.present", { presented: true })).toEqual({ source: deckOn("env_mac") });
  });
});
