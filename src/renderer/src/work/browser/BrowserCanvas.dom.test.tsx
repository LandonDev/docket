// @vitest-environment jsdom
/**
 * The browser kind's bar and body against a host that answers from memory
 * (docs/agents/work-browser.md "The canvas"): who drives, Take over and
 * Hand back, a page that needs him, and a held submit pressed from the bar
 * with the page's values and their sources under the picture. No window is
 * live here (jsdom draws no stream), so the body shows the held picture.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserState } from "@shared/contract-work-browser";
import type { OutboxItem } from "@shared/contract-work-outbox";
import type { CanvasItem } from "@shared/work";
import type { CanvasShell } from "../canvas/kind";

const host = vi.hoisted(() => ({
  state: null as unknown as BrowserState,
  items: [] as OutboxItem[],
  calls: [] as Array<{ method: string; params: Record<string, unknown> }>,
  pushes: [] as Array<(p: unknown) => void>,
  stopped: [] as string[],
}));
vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "local",
    connected: true,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      host.calls.push({ method, params });
      if (method === "work.browser.state") return host.state;
      if (method === "work.browser.drive") return (host.state = { ...host.state, driver: params.driver as BrowserState["driver"], needs: null });
      if (method === "work.outbox.list") return { items: host.items, waiting: host.items.length };
      if (method === "work.outbox.get") return { ...host.items[0], payload: { ...(host.items[0]!.payload as object), picture: { mimeType: "image/png", width: 16, height: 10, data: "AAAA" } } };
      if (method === "work.outbox.send") return { ...host.items[0], state: "sent", decidedAt: Date.now() };
      if (method === "work.outbox.discard") return { ...host.items[0], state: "discarded", decidedAt: Date.now() };
      throw new Error(`unexpected ${method}`);
    },
    onPush: (fn: (p: unknown) => void) => (host.pushes.push(fn), () => undefined),
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
  };
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf: () => link, link: () => link, onLink: () => () => undefined, environment: () => ({ name: "Landon's MacBook" }), statusOf: () => ({}) } };
});
vi.mock("../../lib/computerSection", async (original) => ({
  ...(await original<typeof import("../../lib/computerSection")>()),
  useComputerSection: () => ({ entries: [{ host: "local", row: { threadId: "t1", since: 0, lastCallAt: 1, apps: [], running: null, tier: null }, previewable: false }], keys: [], histories: {}, exists: true, loading: false, live: true }),
}));
vi.mock("../../lib/computerSessions", async (original) => ({
  ...(await original<typeof import("../../lib/computerSessions")>()),
  stopComputer: async (entry: { row: { threadId: string } }) => void host.stopped.push(entry.row.threadId),
}));

vi.mock("../../lib/threadResources", () => ({ hostName: () => "Landon's MacBook" }));

import { Bar, Body } from "./BrowserCanvas";

const ITEM: CanvasItem = { id: "i1", sessionId: "t1", workspaceId: "w1", kind: "browser", title: "Report: Columbus trip", source: { at: "browser", host: "local", sessionId: "t1" }, state: "open", position: 0, rev: 0, createdAt: 1, updatedAt: 1 };
const MARK = JSON.stringify(["com.google.Chrome", ["textField|Hotel|$389.20", "textField|Mileage|$184.20"]]);
const HELD = {
  ref: { at: "host", id: "h1" },
  kind: "computer.act",
  sessionId: "t1",
  workspaceId: "w1",
  sector: null,
  summary: "Click Submit Report in Chrome",
  verb: "Submit Report",
  account: null,
  state: "live",
  payload: { app: { name: "Google Chrome", bundleId: "com.google.Chrome" }, label: "Submit Report", mark: MARK, picture: { mimeType: "image/png", width: 16, height: 10 } },
  createdAt: 200,
  decidedBy: null,
  decidedAt: null,
  n: 1,
  why: "screen",
  grantId: null,
  error: null,
  result: null,
  routineRunId: null,
  updatedAt: 200,
} as OutboxItem;

const shell = (): CanvasShell => ({ review: vi.fn(), selection: vi.fn(), presence: vi.fn(), mode: vi.fn(), statusLine: vi.fn(), written: vi.fn(), detail: vi.fn(), openHistory: vi.fn(), held: vi.fn() });
const props = () => ({ item: ITEM, source: ITEM.source, env: "local", state: undefined, setState: () => undefined, shell: shell() });
const methods = () => host.calls.map((c) => c.method).filter((m) => m !== "work.browser.state" && m !== "work.outbox.list");

beforeEach(() => {
  host.state = { sessionId: "t1", driver: "agent", needs: null, site: { url: "https://us2.concursolutions.com/report", name: "Concur" }, sources: [{ field: "Hotel", source: "Hilton folio.pdf, page 1" }], since: 100 };
  host.items = [];
  host.calls = [];
  host.pushes = [];
  host.stopped = [];
});
afterEach(cleanup);

describe("the browser's bar", () => {
  it("shows the site's host and who drives; Take over stops the agent's computer use, Hand back gives it back", async () => {
    render(<Bar {...props()} />);
    await screen.findByText("The agent is driving");
    expect(screen.getByText("us2.concursolutions.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(host.stopped).toEqual(["t1"]));
    expect(methods()).toEqual(["work.browser.drive"]);
    act(() => host.pushes.forEach((p) => p({ push: "work.browser", state: host.state })));
    await screen.findByText("You are driving");
    fireEvent.click(screen.getByRole("button", { name: "Hand back" }));
    await waitFor(() => expect(host.calls.filter((c) => c.method === "work.browser.drive").map((c) => c.params.driver)).toEqual(["owner", "agent"]));
  });

  it("a page that needs him says so in its words, with Take over as the one primary", async () => {
    host.state = { ...host.state, needs: "Concur wants you to sign in" };
    render(<Bar {...props()} />);
    await screen.findByText("Concur wants you to sign in");
    expect(screen.getByRole("button", { name: "Take over" }).getAttribute("data-variant")).toBe("default");
  });

  it("a held submit ends the bar in the one primary named for it, which presses it once", async () => {
    host.items = [HELD];
    render(<Bar {...props()} />);
    const submit = await screen.findByRole("button", { name: "Submit Report in Concur" });
    expect(submit.getAttribute("data-variant")).toBe("default");
    expect(screen.getByRole("button", { name: "Discard" }).getAttribute("data-variant")).toBe("ghost");
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(methods()).toEqual(["work.outbox.send"]));
    expect(host.calls.find((c) => c.method === "work.outbox.send")?.params).toEqual({ ref: { at: "host", id: "h1" } });
  });
});

describe("the browser's body", () => {
  it("at a held submit shows the page's picture and each value beside where it came from", async () => {
    host.items = [HELD];
    const p = props();
    render(<Body {...p} />);
    const rows = await screen.findAllByRole("row");
    expect(rows.map((r) => r.textContent)).toEqual(["Hotel$389.20Hilton folio.pdf, page 1", "Mileage$184.20"]);
    await waitFor(() => expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,AAAA"));
    expect(p.shell.detail).toHaveBeenCalledWith("Landon's MacBook");
  });

  it("with nothing held and no window to draw, says so in one line", async () => {
    render(<Body {...props()} />);
    await screen.findByText("The agent is not driving the browser now");
  });
});
