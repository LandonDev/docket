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

const LIVE_ENTRIES = vi.hoisted(() => [{ host: "local", row: { threadId: "t1", since: 0, lastCallAt: 1, apps: [], running: null, tier: null }, previewable: false }]);
const host = vi.hoisted(() => ({
  state: null as unknown as BrowserState,
  items: [] as OutboxItem[],
  calls: [] as Array<{ method: string; params: Record<string, unknown> }>,
  pushes: [] as Array<(p: unknown) => void>,
  stopped: [] as string[],
  pictureDown: false,
  stateDown: false,
  /** what the act kept: its bytes, no picture at all, or a picture whose bytes did not come */
  picture: "bytes" as "bytes" | "none" | "empty",
  /** while set, the picture's read waits on it */
  pictureGate: null as Promise<void> | null,
  /** the windows this desktop can draw live */
  drawn: [] as unknown[],
  /** the live view's stream, as the viewport would report it; null for the real one (jsdom draws no frame) */
  stream: null as null | { status: "starting" } | { status: "live"; app: string; window: null; width: number; height: number; drawn: boolean } | { status: "ended"; reason: "lost" },
  streamRetries: 0,
}));
vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "local",
    connected: true,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      host.calls.push({ method, params });
      if (method === "work.browser.state" && host.stateDown) throw new Error("not connected");
      if (method === "work.browser.state") return host.state;
      if (method === "work.browser.drive") return (host.state = { ...host.state, driver: params.driver as BrowserState["driver"], needs: null });
      if (method === "work.outbox.list") return params.show === "decided" ? { items: [], waiting: 0 } : { items: host.items, waiting: host.items.length };
      if (method === "work.outbox.get" && host.pictureGate) await host.pictureGate;
      if (method === "work.outbox.get" && host.pictureDown) throw new Error("socket closed");
      if (method === "work.outbox.get") {
        const picture = host.picture === "none" ? null : { mimeType: "image/png", width: 16, height: 10, ...(host.picture === "bytes" ? { data: "AAAA" } : {}) };
        return { ...host.items[0], payload: { ...(host.items[0]!.payload as object), picture } };
      }
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
  useComputerSection: () => ({ entries: host.drawn, keys: [], histories: {}, exists: true, loading: false, live: false }),
}));
// A session this desktop cannot draw (the box, the browser /ui): Take over still stops it.
vi.mock("../../lib/computerSessions", async (original) => ({
  ...(await original<typeof import("../../lib/computerSessions")>()),
  useComputerEntries: () => LIVE_ENTRIES,
  stopComputer: async (entry: { row: { threadId: string } }) => void host.stopped.push(entry.row.threadId),
}));

vi.mock("../../surfaces/threads/computer/Viewport", async (original) => {
  const real = await original<typeof import("../../surfaces/threads/computer/Viewport")>();
  return {
    ...real,
    useLiveStream: (...args: Parameters<typeof real.useLiveStream>) => {
      const stream = real.useLiveStream(...args);
      return host.stream ? { ...stream, state: host.stream, retry: () => void (host.streamRetries += 1) } : stream;
    },
  };
});

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
/** The presses: the reads (who drives, the held acts, the held picture) left out. */
const methods = () => host.calls.map((c) => c.method).filter((m) => m !== "work.browser.state" && m !== "work.outbox.list" && m !== "work.outbox.get");

beforeEach(() => {
  host.state = { sessionId: "t1", driver: "agent", needs: null, site: { url: "https://us2.concursolutions.com/report", name: "Concur" }, sources: [{ field: "Hotel", source: "Hilton folio.pdf, page 1" }], since: 100 };
  host.items = [];
  host.calls = [];
  host.pushes = [];
  host.stopped = [];
  host.pictureDown = false;
  host.stateDown = false;
  host.picture = "bytes";
  host.pictureGate = null;
  host.drawn = [];
  host.stream = null;
  host.streamRetries = 0;
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
    render(<Pane />);
    const submit = await screen.findByRole("button", { name: "Submit Report in Concur" });
    fireEvent.load(await screen.findByRole("img"));
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    expect(submit.getAttribute("data-variant")).toBe("default");
    expect(screen.getByRole("button", { name: "Discard" }).getAttribute("data-variant")).toBe("ghost");
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(methods()).toEqual(["work.outbox.send"]));
    expect(host.calls.find((c) => c.method === "work.outbox.send")?.params).toEqual({ ref: { at: "host", id: "h1" } });
  });

  it("who drives sits 8px before its verb, in one group at the bar's end", async () => {
    render(<Bar {...props()} />);
    const who = await screen.findByText("The agent is driving");
    const group = who.parentElement!;
    expect(group.className).toContain("ms-auto");
    expect(group.className).toContain("gap-2");
    expect(group.contains(screen.getByRole("button", { name: "Take over" }))).toBe(true);
  });

  it("at a held submit, Take over gives way by the pane's width (a container query), never the window's", async () => {
    host.items = [HELD];
    const { container } = render(<Bar {...props()} />);
    await screen.findByRole("button", { name: "Submit Report in Concur" });
    expect(container.querySelector("[data-slot=browser-bar]")!.className).toContain("@container/browser");
    const take = container.querySelector("[data-slot=browser-take-over]")!;
    expect(take.className).toContain("@max-[540px]/browser:hidden");
    expect(take.className).not.toMatch(/(^|\s)max-\[/);
  });

  it("who drives goes whole under a narrow bar, before its verb is cut; the verb stays", async () => {
    const { container } = render(<Bar {...props()} />);
    const who = await screen.findByText("The agent is driving");
    expect(who.hasAttribute("data-narrow-hide")).toBe(true);
    expect(who.className).toContain("@max-[320px]/browser:hidden");
    expect(container.querySelector("[data-slot=browser-bar]")!.contains(screen.getByRole("button", { name: "Take over" }))).toBe(true);
  });

  it("a first read that failed draws no bone in the bar that would never fill", async () => {
    host.stateDown = true;
    const { container } = render(<Bar {...props()} />);
    await waitFor(() => expect(container.querySelector("[data-slot=browser-bar]")).toBeNull());
    expect(container.querySelector("[data-slot=skeleton]")).toBeNull();
  });

  it("while he drives at a held submit, offers Hand back beside the primary, never a second Take over", async () => {
    host.items = [HELD];
    host.state = { ...host.state, driver: "owner" };
    render(<Bar {...props()} />);
    await screen.findByRole("button", { name: "Submit Report in Concur" });
    expect(screen.getByRole("button", { name: "Hand back" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });
});

/** The bar over the body, as the pane draws them: the two share the held page's picture. */
function Pane() {
  const p = props();
  return (
    <>
      <Bar {...p} />
      <Body {...p} />
    </>
  );
}

describe("a held submit's primary waits on the page he approves", () => {
  const submit = () => screen.getByRole("button", { name: "Submit Report in Concur" });

  it("is off while the kept picture comes, and on once it has drawn; Discard stays on", async () => {
    let open!: () => void;
    host.pictureGate = new Promise((resolve) => (open = resolve));
    host.items = [HELD];
    const { container } = render(<Pane />);
    await screen.findByRole("button", { name: "Submit Report in Concur" });
    await waitFor(() => expect(container.querySelector("[data-slot=skeleton]")).toBeTruthy());
    expect(submit().hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Discard" }).hasAttribute("disabled")).toBe(false);
    open();
    const img = await screen.findByRole("img");
    // The bytes came but the image has not drawn yet: still off.
    expect(submit().hasAttribute("disabled")).toBe(true);
    fireEvent.load(img);
    await waitFor(() => expect(submit().hasAttribute("disabled")).toBe(false));
    // One read serves the bar and the body.
    expect(host.calls.filter((c) => c.method === "work.outbox.get")).toHaveLength(1);
  });

  it("is off while the picture's read failed, and on after Retry draws it", async () => {
    host.pictureDown = true;
    host.items = [HELD];
    render(<Pane />);
    await screen.findByText("The page's picture did not load");
    expect(submit().hasAttribute("disabled")).toBe(true);
    host.pictureDown = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.load(await screen.findByRole("img"));
    await waitFor(() => expect(submit().hasAttribute("disabled")).toBe(false));
  });

  it("a picture the act kept whose bytes did not come is a failure with Retry, and the primary stays off", async () => {
    host.picture = "empty";
    host.items = [HELD];
    render(<Pane />);
    await screen.findByText("The page's picture did not load");
    expect(screen.queryByText("No picture of this page was kept")).toBeNull();
    expect(submit().hasAttribute("disabled")).toBe(true);
  });

  it("an image that fails to draw is a failure too", async () => {
    host.items = [HELD];
    render(<Pane />);
    fireEvent.error(await screen.findByRole("img"));
    await screen.findByText("The page's picture did not load");
    expect(submit().hasAttribute("disabled")).toBe(true);
  });

  it("with a window live here, shows the kept picture in place of the stream's placeholder, and waits on it", async () => {
    let open!: () => void;
    host.pictureGate = new Promise((resolve) => (open = resolve));
    host.drawn = [{ ...LIVE_ENTRIES[0], previewable: true }];
    host.items = [HELD];
    const { container } = render(<Pane />);
    await screen.findByRole("button", { name: "Submit Report in Concur" });
    expect(container.querySelector("[data-face=live]")).toBeNull();
    expect(submit().hasAttribute("disabled")).toBe(true);
    open();
    const img = await screen.findByRole("img", { name: HELD.summary });
    expect(submit().hasAttribute("disabled")).toBe(true);
    fireEvent.load(img);
    await waitFor(() => expect(submit().hasAttribute("disabled")).toBe(false));
  });

  it("with a window live here, a failed picture keeps the primary off until Retry draws it", async () => {
    host.pictureDown = true;
    host.drawn = [{ ...LIVE_ENTRIES[0], previewable: true }];
    host.items = [HELD];
    render(<Pane />);
    await screen.findByText("The page's picture did not load");
    expect(submit().hasAttribute("disabled")).toBe(true);
    host.pictureDown = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.load(await screen.findByRole("img", { name: HELD.summary }));
    await waitFor(() => expect(submit().hasAttribute("disabled")).toBe(false));
  });

  it("once he takes over a window live here, the body draws that window, not the still, and the primary waits on its first frame", async () => {
    host.pictureGate = new Promise(() => undefined);
    host.drawn = [{ ...LIVE_ENTRIES[0], previewable: true }];
    host.items = [HELD];
    const { container, rerender } = render(<Pane />);
    await screen.findByRole("button", { name: "Submit Report in Concur" });
    expect(container.querySelector("[data-face=live]")).toBeNull();
    expect(submit().hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(host.calls.some((c) => c.method === "work.browser.drive")).toBe(true));
    act(() => host.pushes.forEach((p) => p({ push: "work.browser", state: host.state })));
    await screen.findByRole("button", { name: "Hand back" });
    await waitFor(() => expect(container.querySelector("[data-face=live]")).toBeTruthy());
    expect(screen.queryByText("The page's picture did not load")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    // The live view has no frame yet: the primary waits on it, as it waited on the still.
    expect(submit().hasAttribute("disabled")).toBe(true);
    host.stream = { status: "live", app: "Google Chrome", window: null, width: 16, height: 10, drawn: true };
    rerender(<Pane />);
    await waitFor(() => expect(submit().hasAttribute("disabled")).toBe(false));
    // Hand back: the agent drives again, and the still and its wait come back.
    fireEvent.click(screen.getByRole("button", { name: "Hand back" }));
    await waitFor(() => expect(host.state.driver).toBe("agent"));
    act(() => host.pushes.forEach((p) => p({ push: "work.browser", state: host.state })));
    await waitFor(() => expect(container.querySelector("[data-face=live]")).toBeNull());
    expect(submit().hasAttribute("disabled")).toBe(true);
  });

  it("after he takes over, the primary stays off while the live view is a skeleton or its stream ended, and comes on with its first frame", async () => {
    host.state = { ...host.state, driver: "owner" };
    host.drawn = [{ ...LIVE_ENTRIES[0], previewable: true }];
    host.items = [HELD];
    host.stream = { status: "starting" };
    const { container, rerender } = render(<Pane />);
    await screen.findByRole("button", { name: "Hand back" });
    await waitFor(() => expect(container.querySelector("[data-face=live] [data-slot=skeleton]")).toBeTruthy());
    expect(submit().hasAttribute("disabled")).toBe(true);
    // A frame is coming but not drawn: still off.
    host.stream = { status: "live", app: "Google Chrome", window: null, width: 16, height: 10, drawn: false };
    rerender(<Pane />);
    expect(submit().hasAttribute("disabled")).toBe(true);
    // The stream ended: off, with the stream's own Retry; Take over's way back (Hand back) stays.
    host.stream = { status: "ended", reason: "lost" };
    rerender(<Pane />);
    await waitFor(() => expect(container.querySelector("[data-face=live] [data-slot=skeleton]")).toBeTruthy());
    expect(submit().hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Hand back" }).hasAttribute("disabled")).toBe(false);
    // The first frame on screen: on.
    host.stream = { status: "live", app: "Google Chrome", window: null, width: 16, height: 10, drawn: true };
    rerender(<Pane />);
    await waitFor(() => expect(submit().hasAttribute("disabled")).toBe(false));
    // Not one read of the kept still while he drives a window drawn here.
    expect(host.calls.filter((c) => c.method === "work.outbox.get")).toHaveLength(0);
  });

  it("where no window can be drawn here, taking over keeps the still and its wait", async () => {
    host.pictureGate = new Promise(() => undefined);
    host.state = { ...host.state, driver: "owner" };
    host.items = [HELD];
    const { container } = render(<Pane />);
    await screen.findByRole("button", { name: "Hand back" });
    await waitFor(() => expect(container.querySelector("[data-slot=skeleton]")).toBeTruthy());
    expect(submit().hasAttribute("disabled")).toBe(true);
  });

  it("an act that kept no picture has nothing to wait on", async () => {
    host.picture = "none";
    host.items = [HELD];
    render(<Pane />);
    await screen.findByText("No picture of this page was kept");
    await waitFor(() => expect(submit().hasAttribute("disabled")).toBe(false));
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

  it("a picture the host did not send says so with Retry, never that no picture was kept", async () => {
    host.items = [HELD];
    host.pictureDown = true;
    render(<Body {...props()} />);
    await screen.findByText("The page's picture did not load");
    expect(screen.queryByText("No picture of this page was kept")).toBeNull();
    host.pictureDown = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,AAAA"));
  });

  it("a first read that failed says so on the state line with Retry, and the body stops loading; Retry reads again", async () => {
    host.stateDown = true;
    const p = props();
    const { container } = render(<Body {...p} />);
    await waitFor(() => expect(p.shell.statusLine).toHaveBeenLastCalledWith(expect.objectContaining({ tone: "failed", word: "Couldn't open this browser", detail: "not connected" })));
    expect(container.querySelector("[data-slot=skeleton]")).toBeNull();
    const line = vi.mocked(p.shell.statusLine).mock.lastCall![0]!;
    expect(line.action?.label).toBe("Retry");
    host.stateDown = false;
    act(() => void line.action!.run());
    await screen.findByText("The agent is not driving the browser now");
    expect(p.shell.statusLine).toHaveBeenLastCalledWith(null);
  });

  it("the page fills the body inside its inset, with no cap on its width", async () => {
    const { container } = render(<Body {...props()} />);
    await screen.findByText("The agent is not driving the browser now");
    expect(container.innerHTML).not.toContain("max-w-[720px]");
  });

  it("under 480px of its own width a value's source goes under its label and value", async () => {
    host.items = [HELD];
    const { container } = render(<Body {...props()} />);
    await screen.findAllByRole("row");
    expect(container.querySelector("[data-slot=browser-values]")!.className).toContain("@container/values");
    const row = screen.getAllByRole("row")[0]!;
    expect(row.className).toContain("grid-cols-[112px_minmax(0,1fr)]");
    expect(row.className).toContain("@[480px]/values:grid-cols-[112px_minmax(80px,max-content)_minmax(0,1fr)]");
    const source = container.querySelector("[data-value-source]")!;
    expect(source.className).toContain("col-span-2");
    expect(source.className).toContain("@[480px]/values:col-span-1");
  });

  it("with nothing held and no window to draw, says so in one line", async () => {
    render(<Body {...props()} />);
    await screen.findByText("The agent is not driving the browser now");
  });
});
