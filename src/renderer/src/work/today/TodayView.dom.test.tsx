// @vitest-environment jsdom
/**
 * Today over two hosts that answer from memory as `work.outbox.*` does
 * (docs/agents/work-today.md): held rows in the first frame from the
 * Outbox's own store, the sheet with the Outbox's Send and its rule, the
 * run from one held item to the next, the folds, and a source that throws.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxItem } from "@shared/contract-work-outbox";

type Call = { env: string; method: string; params: Record<string, unknown> };
const world = vi.hoisted(() => ({
  calls: [] as Call[],
  items: new Map<string, OutboxItem[]>(),
  listDown: new Set<string>(),
  // a Send the host refuses, in its own words
  sendRefused: null as string | null,
  // the list a host has not answered yet
  listHeld: null as Promise<void> | null,
  // the whole read of a mail the host has not answered yet: it answers when the test lets it
  getHeld: null as Promise<void> | null,
  workspaces: [] as { id: string; environmentId: string; name: string; path: string; kind?: string; sector?: string | null }[],
  open: new Set(["box", "mac"]),
  owed: 0,
}));

vi.mock("../../lib/connection", async (original) => {
  const link = (env: string) => ({
    environmentId: env,
    connected: true,
    onPush: () => () => undefined,
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      world.calls.push({ env, method, params });
      // As the real link does for a read that is not safe to queue: a host whose link is down refuses at once.
      if (!world.open.has(env)) throw new Error("not connected");
      const items = world.items.get(env) ?? [];
      const find = () => items.find((i) => i.ref.id === (params.ref as { id: string }).id)!;
      const now = Date.now();
      switch (method) {
        case "work.outbox.list": {
          if (world.listHeld) await world.listHeld;
          if (world.listDown.has(env)) throw new Error("socket closed");
          const waiting = items.filter((i) => ["held", "live", "failed", "sending"].includes(i.state));
          return { items: params.show === "decided" ? items.filter((i) => i.state === "sent") : waiting, waiting: waiting.length };
        }
        case "work.outbox.grants":
          return { grants: [] };
        case "work.outbox.offers":
          return { offers: [] };
        case "work.outbox.get":
          if (world.getHeld) await world.getHeld;
          return find();
        case "work.outbox.send":
          if (world.sendRefused) throw new Error(world.sendRefused);
          Object.assign(find(), { state: "sent", decidedBy: "owner", decidedAt: now, updatedAt: now });
          return find();
        case "work.lifeos.status":
          return { lifeos: { state: "signed-out" }, keys: [] };
        case "work.test.owed":
          return { n: world.owed };
      }
      throw new Error(`unknown ${method}`);
    },
  });
  const links: Record<string, ReturnType<typeof link>> = { box: link("box"), mac: link("mac") };
  const environments = [
    { id: "box", name: "The box", routes: [], credentialRef: null, platform: "linux" },
    { id: "mac", name: "Mac", routes: [], credentialRef: null, platform: "darwin" },
  ];
  const statuses = () => new Map(environments.map((e) => [e.id, { transport: world.open.has(e.id) ? "open" : "offline" }]));
  let snapshot = statuses();
  const listeners = new Set<() => void>();
  return {
    ...(await original<typeof import("../../lib/connection")>()),
    // The hooks read the real registry: here they read the test's hosts.
    useEnvironments: () => environments,
    useEnvironmentStatuses: () => snapshot,
    useEnvironmentStatus: (id: string) => snapshot.get(id),
    registry: {
      linkOf: (env: string) => links[env]!,
      onLink: (listener: (l: ReturnType<typeof link>, event: string) => void) => {
        listener(links.box!, "added");
        listener(links.mac!, "added");
        return () => undefined;
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      statuses: () => snapshot,
      statusOf: (id: string) => snapshot.get(id),
      environmentsSnapshot: () => environments,
      environments: () => environments,
      environment: (id: string) => environments.find((e) => e.id === id),
      primaryEnvironmentId: "mac",
      /** The test's own: a host's link opened or dropped. */
      moved: () => {
        snapshot = statuses();
        for (const listener of listeners) listener();
      },
    },
  };
});
vi.mock("../../lib/tcserver/workspaces", async (original) => ({
  ...(await original<typeof import("../../lib/tcserver/workspaces")>()),
  useWorkspaces: () => world.workspaces,
}));

import { registry } from "../../lib/connection";
import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { loadOutbox, resetOutboxStore } from "../outbox/store";
import { source as held } from "./held";
import { toastAnchor } from "../../lib/toastAnchor";
import { nextHeld } from "./HeldSheet";
import { TIMED_OUT, useEachWorkspace } from "./read";
import { comeBack, leave, openHeld, putAnswer, resetToday, toastUp, todayNow } from "./store";
import { ROW_GRID, TITLE_EDGE } from "./TodayRow";
import { View } from "./TodayView";
import type { TodaySource } from "./types";

const mail = (id: string, to: string, subject: string, extra: Partial<OutboxItem> = {}): OutboxItem => ({
  ref: { at: "lifeos", table: "outbox", id },
  kind: "mail.send",
  workspaceId: "ws1",
  sessionId: null,
  sector: "purdue",
  summary: `Send to ${to}: ${subject}`,
  verb: "Send",
  account: "dana@example.edu",
  state: "held",
  payload: { id, status: "draft", message: { kind: "mail", accountId: "acc", to: [{ name: to, address: "someone@example.edu" }], cc: [], bcc: [], subject, html: `<p>Hello ${to}</p>`, text: `Hello ${to}` } },
  createdAt: 1_000 + Number(id.replace(/\D/g, "")),
  decidedBy: null,
  decidedAt: null,
  n: null,
  why: "lifeos",
  grantId: null,
  error: null,
  result: null,
  routineRunId: null,
  updatedAt: 500,
  ...extra,
});

const JOBS = [
  { id: "ws1", environmentId: "box", name: "Purdue Esports", path: "/w/purdue", kind: "work", sector: "purdue" },
  { id: "ws2", environmentId: "mac", name: "Ref", path: "/m/ref", kind: "work", sector: "ref" },
];

const rowTitles = (root: ParentNode = document) => [...root.querySelectorAll("[data-today-row] [data-row-title]")].map((el) => el.textContent);
const section = (id: string) => document.querySelector<HTMLElement>(`[data-today-section="${id}"]`)!;
const moved = () => (registry as unknown as { moved(): void }).moved();

beforeEach(() => {
  world.calls.length = 0;
  world.items.clear();
  world.listDown.clear();
  world.sendRefused = null;
  world.getHeld = null;
  world.listHeld = null;
  world.workspaces = [...JOBS];
  world.open = new Set(["box", "mac"]);
  world.owed = 0;
  moved();
  setWorkOn("box", true);
  setWorkOn("mac", true);
  resetOutboxStore();
  resetToday([held]);
});
afterEach(() => {
  cleanup();
  workSwitch.reset();
  vi.restoreAllMocks();
});

describe("Today", () => {
  it("has the held rows in its first frame, oldest first, each with its job and when it was held", async () => {
    world.items.set("box", [mail("o2", "Dana Reyes", "Spring budget"), mail("o1", "Marcus Bell", "Sponsor deck")]);
    world.items.set("mac", [mail("o3", "Northfield Parks", "Invoice 1042", { sector: "ref", workspaceId: "ws2" })]);
    await loadOutbox();
    render(<View onClose={() => {}} />);
    // No wait: the Outbox's store already holds them, and the source puts them in before paint.
    expect(rowTitles()).toEqual(["Send to Marcus Bell", "Send to Dana Reyes", "Send to Northfield Parks"]);
    const first = document.querySelector<HTMLElement>("[data-today-row]")!;
    expect(first.textContent).toContain("Sponsor deck");
    // The job is named as the rail names it: its workspace, never the sector's own word.
    expect(first.textContent).toContain("Purdue Esports");
    expect(first.querySelector('[data-sector="purdue"]')).not.toBeNull();
    expect(section("held").querySelector("h2")?.textContent).toBe("Waiting on you");
    // No verb is drawn on a held row: Send is never in the row.
    expect(first.querySelectorAll("button")).toHaveLength(1);
    // Its name is the title and second line; its job and its time describe it, as he sees them.
    const told = first.querySelector("[data-row-open]")!.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent);
    expect(told[0]).toBe("Purdue Esports");
    expect(told[1]).toMatch(/\S/);
  });

  it("draws bones only for a section that has never answered, beside the rows of one that has; then its empty line", async () => {
    let release!: () => void;
    world.listHeld = new Promise<void>((resolve) => (release = resolve));
    resetOutboxStore();
    const rows = { rows: [{ key: "owed:1", section: "money", sector: "unify" as const, title: "Northfield Parks owes 420", open: () => {} }] };
    resetToday([held, { id: "money", section: { id: "money", title: "Money", order: 60, empty: "Nothing owed" }, use: () => rows }]);
    render(<View onClose={() => {}} />);
    // Nothing waits for the whole page: the other section's row is there with the first frame.
    expect(rowTitles()).toEqual(["Northfield Parks owes 420"]);
    expect(section("held").querySelector('[role="status"][aria-busy]')).not.toBeNull();
    expect(section("held").textContent).not.toContain("Nothing waits on your press");
    await act(async () => release());
    await waitFor(() => expect(section("held").textContent).toContain("Nothing waits on your press"));
    expect(section("held").querySelector("[aria-busy]")).toBeNull();
  });

  it("says All clear when every section answered with nothing, and No jobs yet when no Work workspace has a sector", async () => {
    await loadOutbox();
    const { unmount } = render(<View onClose={() => {}} />);
    expect(screen.getByText("All clear")).toBeTruthy();
    expect(screen.getByText("Nothing needs you today.")).toBeTruthy();
    expect(document.querySelector("[data-today-section]")).toBeNull();
    unmount();
    world.workspaces = [{ id: "c1", environmentId: "box", name: "temp-code", path: "/r/temp-code" }];
    render(<View onClose={() => {}} />);
    expect(screen.getByText("No jobs yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add workspace" })).toBeTruthy();
  });

  it("names a host that did not answer in the section it feeds, with Retry, and never says nothing waits beside it", async () => {
    world.listDown.add("mac");
    world.items.set("box", [mail("o1", "Marcus Bell", "Sponsor deck")]);
    await loadOutbox();
    render(<View onClose={() => {}} />);
    const line = section("held").querySelector<HTMLElement>('[data-view-state="failed"]')!;
    expect(line.textContent).toContain("Mac did not answer");
    expect(line.textContent).toContain("socket closed");
    expect(rowTitles()).toEqual(["Send to Marcus Bell"]);
    world.listDown.clear();
    world.items.set("mac", [mail("o3", "Northfield Parks", "Invoice 1042", { sector: "ref", workspaceId: "ws2" })]);
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(rowTitles()).toEqual(["Send to Marcus Bell", "Send to Northfield Parks"]));
    expect(section("held").querySelector('[data-view-state="failed"]')).toBeNull();
  });

  it("says did not answer once for a host whose wait ran out, on the rows' grid; a read LifeOS refused is said in its own words", async () => {
    await loadOutbox();
    const retry = vi.fn();
    const failing: TodaySource = {
      id: "money",
      section: { id: "money", title: "Money", order: 60, empty: "Nothing owed" },
      use: () => FAILED,
    };
    const FAILED = {
      rows: [],
      failed: [{ environmentId: "mac", error: TIMED_OUT }, { environmentId: "box", error: "Uncaught Error: gone", said: "LifeOS could not read tasks", retry }, { environmentId: "box", error: "work.outbox.list timed out" }],
    };
    resetToday([held, failing]);
    render(<View onClose={() => {}} />);
    const [late, refused, link] = [...section("money").querySelectorAll<HTMLElement>('[data-view-state="failed"]')];
    // The wait running out is what the words already say: nothing is said twice, in this page's words or the link's.
    expect(late!.textContent).toBe("Mac did not answer");
    expect(link!.textContent).toBe("The box did not answer");
    // LifeOS's own error is not his to read: the line says what could not be read, with its Retry.
    expect(refused!.textContent).toBe("LifeOS could not read tasksRetry");
    for (const cls of ROW_GRID.split(" ")) expect(late!.className).toContain(cls);
    fireEvent.click(within(refused!).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("draws a section's bones in the shape of its rows: two lines, or a tick before one", async () => {
    await loadOutbox();
    const waiting = { loading: true };
    const of = (id: string, bones?: "lines" | "tick"): TodaySource => ({ id, section: { id, title: id, order: 60, empty: "None", ...(bones ? { bones } : {}) }, use: () => waiting });
    resetToday([held, of("a", "lines"), of("b", "tick"), of("c")]);
    render(<View onClose={() => {}} />);
    const bone = (id: string) => section(id).querySelector<HTMLElement>("[data-today-bone]")!;
    expect(bone("a").getAttribute("data-today-bone")).toBe("lines");
    expect(bone("a").querySelectorAll('[data-slot="skeleton"]')).toHaveLength(4);
    expect(bone("b").querySelector(".rounded-full")).not.toBeNull();
    expect(bone("c").querySelectorAll('[data-slot="skeleton"]')).toHaveLength(3);
  });

  it("is all clear once only ended meetings are left, and says what tomorrow starts with", async () => {
    await loadOutbox();
    const over = { rows: [{ key: "event:1", section: "meetings", sector: "purdue" as const, title: "Staff sync", past: true, open: () => {} }], note: "Tomorrow starts at 9:00 AM with Crew meeting." };
    resetToday([held, { id: "meetings", section: { id: "meetings", title: "Meetings", order: 20, empty: "No meetings today" }, use: () => over }]);
    render(<View onClose={() => {}} />);
    expect(screen.getByText("All clear")).toBeTruthy();
    expect(screen.getByText("Tomorrow starts at 9:00 AM with Crew meeting.")).toBeTruthy();
    expect(screen.queryByText("Nothing needs you today.")).toBeNull();
  });

  it("seats the toasts at its foot over the titles, clear of the ticks and the verbs, while it is open", async () => {
    world.items.set("box", [mail("o1", "Marcus Bell", "Sponsor deck")]);
    await loadOutbox();
    const { unmount } = render(<View onClose={() => {}} />);
    const anchor = document.querySelector<HTMLElement>("[data-today-toasts]")!;
    expect(toastAnchor()).toBe(anchor);
    // The second cell of the rows' own grid: the titles' column.
    expect(anchor.previousElementSibling).not.toBeNull();
    expect(anchor.parentElement!.className).toContain(ROW_GRID.split(" ")[1]!);
    // The held sheet lies over the toasts: while it is open they go back to the window's corner, behind it.
    act(() => openHeld("held:box:lifeos:o1"));
    expect(toastAnchor()).toBeNull();
    act(() => openHeld(null));
    expect(toastAnchor()).toBe(anchor);
    // The list ends with a runway a toast and its gaps tall, so the last row can be scrolled clear of the stack.
    expect(anchor.closest("[data-today]")!.querySelector('[class*="pb-24"]')).not.toBeNull();
    unmount();
    expect(toastAnchor()).toBeNull();
  });

  it("in a narrow column gives the page's own toasts a strip under the list, as wide as a row, only while one is up", async () => {
    // The test's document lays nothing out: every width is 0, so the column is narrow once something measures it.
    vi.stubGlobal("ResizeObserver", class { constructor(private readonly run: () => void) {} observe() { this.run(); } disconnect() {} unobserve() {} });
    try {
      world.items.set("box", [mail("o1", "Marcus Bell", "Sponsor deck")]);
      await loadOutbox();
      render(<View onClose={() => {}} />);
      const strip = document.querySelector<HTMLElement>("[aria-hidden].flex.shrink-0.px-6")!;
      const anchor = toastAnchor()!;
      // The titles' column is not the anchor here; the strip's own is, outside the scrolling rows.
      expect(anchor.closest("[data-today]")).toBeNull();
      expect(strip.contains(anchor)).toBe(true);
      expect(strip.style.height).toBe("0rem");
      let down!: () => void;
      act(() => void (down = toastUp()));
      expect(strip.getAttribute("data-today-strip")).toBe("up");
      expect(strip.style.height).toBe("5rem");
      // Two Undo toasts: the stack opens under the pointer to both, and the strip keeps a place for each.
      let second!: () => void;
      act(() => void (second = toastUp()));
      expect(strip.style.height).toBe("10rem");
      act(() => second());
      act(() => down());
      expect(strip.getAttribute("data-today-strip")).toBeNull();
      expect(strip.style.height).toBe("0rem");
      expect(todayNow().toastsUp).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("names a held row by the workspace the item is in, as its sheet does, where two hosts hold one for the sector", async () => {
    world.workspaces = [...JOBS, { id: "ws9", environmentId: "mac", name: "Purdue", path: "/m/purdue", kind: "work", sector: "purdue" }];
    world.items.set("mac", [mail("o3", "Northfield Parks", "Invoice 1042", { workspaceId: "ws9" })]);
    await loadOutbox();
    render(<View onClose={() => {}} />);
    const job = document.querySelector<HTMLElement>('[data-today-row] [data-sector="purdue"]')!.parentElement!;
    expect(job.textContent).toBe("Purdue");
  });

  it("with every host failed, the section says who did not answer and not that nothing waits", async () => {
    world.listDown.add("mac");
    world.listDown.add("box");
    await loadOutbox();
    render(<View onClose={() => {}} />);
    expect(section("held").querySelectorAll('[data-view-state="failed"]')).toHaveLength(2);
    expect(section("held").textContent).not.toContain("Nothing waits on your press");
    expect(screen.queryByText("All clear")).toBeNull();
  });

  it("with an offline host and nothing on the open one, Waiting on you never says nothing waits", async () => {
    world.open = new Set(["box"]);
    moved();
    world.items.set("mac", [mail("o3", "Northfield Parks", "Invoice 1042", { sector: "ref", workspaceId: "ws2" })]);
    await loadOutbox();
    render(<View onClose={() => {}} />);
    expect(section("held").textContent).not.toContain("Nothing waits on your press");
    expect(section("held").querySelectorAll('[data-view-state="failed"]')).toHaveLength(0);
    expect(document.querySelectorAll("[data-today-offline]")).toHaveLength(1);
    expect(screen.queryByText("All clear")).toBeNull();
  });

  it("names an offline host once, at the page's foot, and no section blames it for a read its link refused", async () => {
    world.open = new Set(["box"]);
    moved();
    world.items.set("box", [mail("o1", "Marcus Bell", "Sponsor deck")]);
    await loadOutbox();
    // The Outbox asked the Mac too, and its link said "not connected".
    expect(world.calls.some((c) => c.env === "mac" && c.method === "work.outbox.list")).toBe(true);
    render(<View onClose={() => {}} />);
    const lines = document.querySelectorAll("[data-today-offline]");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toBe("Mac is offline.");
    expect(document.querySelectorAll('[data-view-state="failed"]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain("not connected");
  });

  it("folds Waiting on you at five rows; its line unfolds the rest in place and stays unfolded", async () => {
    world.items.set("box", Array.from({ length: 8 }, (_, i) => mail(`o${i + 1}`, `Person ${i + 1}`, "A subject")));
    await loadOutbox();
    const { unmount } = render(<View onClose={() => {}} />);
    expect(rowTitles()).toHaveLength(5);
    const more = screen.getByRole("button", { name: "3 more" });
    // The fold's words start where the titles do, and the fold is an item of the section's list as a row is.
    expect(more.className).toContain(TITLE_EDGE);
    expect(more.parentElement!.getAttribute("role")).toBe("listitem");
    expect(more.parentElement!.parentElement!.getAttribute("role")).toBe("list");
    fireEvent.click(more);
    expect(rowTitles()).toHaveLength(8);
    expect(screen.queryByRole("button", { name: "3 more" })).toBeNull();
    unmount();
    render(<View onClose={() => {}} />);
    expect(rowTitles()).toHaveLength(8);
  });

  it("a fold line is a stop of the list: the arrows reach it, Enter opens it, and the first row it showed takes the focus", async () => {
    world.items.set("box", Array.from({ length: 8 }, (_, i) => mail(`o${i + 1}`, `Person ${i + 1}`, "A subject")));
    await loadOutbox();
    render(<View onClose={() => {}} />);
    const row = (n: number) => screen.getByRole("button", { name: new RegExp(`^Send to Person ${n},`) });
    await waitFor(() => expect(document.activeElement).toBe(row(1)));
    const more = screen.getByRole("button", { name: "3 more" });
    expect(more.tabIndex).toBe(-1);
    fireEvent.keyDown(row(1), { key: "End" });
    await waitFor(() => expect(document.activeElement).toBe(more));
    // Still one tab stop, and it is the fold line now.
    expect([...document.querySelectorAll<HTMLElement>("[data-today] [tabindex]")].filter((el) => el.tabIndex === 0)).toEqual([more]);
    fireEvent.keyDown(more, { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement).toBe(row(5)));
    fireEvent.keyDown(row(5), { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(more));
    // Enter on a button is its click; the line goes, and focus is not dropped on the page.
    more.focus();
    fireEvent.click(more);
    await waitFor(() => expect(document.activeElement).toBe(row(6)));
    expect(row(6).tabIndex).toBe(0);
  });

  it("comes back with its focus where he left it", async () => {
    world.items.set("box", Array.from({ length: 3 }, (_, i) => mail(`o${i + 1}`, `Person ${i + 1}`, "A subject")));
    await loadOutbox();
    const row = (n: number) => screen.getByRole("button", { name: new RegExp(`^Send to Person ${n},`) });
    const { unmount } = render(<View onClose={() => {}} />);
    await waitFor(() => expect(document.activeElement).toBe(row(1)));
    fireEvent.keyDown(row(1), { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(row(2)));
    unmount();
    render(<View onClose={() => {}} />);
    await waitFor(() => expect(document.activeElement).toBe(row(2)));
  });
});

describe("the held sheet", () => {
  it("opens on a row's press with the item whole, and Send waits until the whole mail is read", async () => {
    world.items.set("box", [mail("o1", "Marcus Bell", "Sponsor deck"), mail("o2", "Dana Reyes", "Spring budget")]);
    await loadOutbox();
    let release!: () => void;
    world.getHeld = new Promise<void>((resolve) => (release = resolve));
    render(<View onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send to Marcus Bell, Sponsor deck" }));
    const sheet = await screen.findByRole("dialog");
    expect(todayNow().held).toBe("held:box:lifeos:o1");
    // The Outbox's own detail: who it goes to, the job named in its facts, its place in the run.
    expect(sheet.textContent).toContain("Marcus Bell");
    expect(sheet.textContent).toContain("Purdue Esports");
    expect(sheet.querySelector("[data-today-run]")!.textContent).toBe("1 of 2");
    const send = () => within(sheet).getByRole("button", { name: "Send" }) as HTMLButtonElement;
    // The whole mail is still being read: nothing can be sent on what is not on screen.
    expect(send().disabled).toBe(true);
    await act(async () => {
      release();
      await world.getHeld;
    });
    await waitFor(() => expect(send().disabled).toBe(false), { timeout: 10_000 });
    expect(world.calls.some((c) => c.method === "work.outbox.send")).toBe(false);
  });

  it("after a press shows the next held item, and closes after the last", async () => {
    world.items.set("box", [mail("o1", "Marcus Bell", "Sponsor deck"), mail("o2", "Dana Reyes", "Spring budget")]);
    await loadOutbox();
    render(<View onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Send to Marcus Bell, Sponsor deck" }));
    const sheet = await screen.findByRole("dialog");
    const send = () => within(sheet).getByRole("button", { name: "Send" }) as HTMLButtonElement;
    await waitFor(() => expect(send().disabled).toBe(false));
    fireEvent.click(send());
    await waitFor(() => expect(todayNow().held).toBe("held:box:lifeos:o2"));
    expect(world.calls.filter((c) => c.method === "work.outbox.send").map((c) => (c.params.ref as { id: string }).id)).toEqual(["o1"]);
    await waitFor(() => expect(sheet.textContent).toContain("Dana Reyes"));
    // The run counts forward: the second of the two there were, not the first of one.
    expect(sheet.querySelector("[data-today-run]")!.textContent).toBe("2 of 2");
    // The item that took the sheet has the focus, so the keyboard reads it from its top.
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Send to Dana Reyes: Spring budget");
    await waitFor(() => expect(rowTitles()).toEqual(["Send to Dana Reyes"]));
    await waitFor(() => expect(send().disabled).toBe(false));
    fireEvent.click(send());
    await waitFor(() => expect(todayNow().held).toBeNull());
    expect(world.calls.filter((c) => c.method === "work.outbox.send")).toHaveLength(2);
    // A sheet opened again starts a new run.
    expect(todayNow().heldDone).toBe(1);
    openHeld("held:box:lifeos:o9");
    expect(todayNow().heldDone).toBe(0);
  });

  it("counts the run by its own steps while the host's list still holds the item he sent, and the item that arrives takes no pointer until it is whole", async () => {
    world.items.set("box", [mail("o1", "Marcus Bell", "Sponsor deck"), mail("o2", "Dana Reyes", "Spring budget"), mail("o3", "Priya Nair", "Render queue")]);
    await loadOutbox();
    render(<View onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Send to Marcus Bell, Sponsor deck" }));
    const sheet = await screen.findByRole("dialog");
    const send = () => within(sheet).getByRole("button", { name: "Send" }) as HTMLButtonElement;
    const run = () => sheet.querySelector("[data-today-run]")!.textContent;
    expect(run()).toBe("1 of 3");
    await waitFor(() => expect(send().disabled).toBe(false));
    // The reload that follows a Send does not come back yet: the list still holds all three.
    let release!: () => void;
    world.listHeld = new Promise<void>((resolve) => (release = resolve));
    // The test's document runs no fade of its own: here one runs, as in the window.
    const styleOf = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
      const style = styleOf(el, pseudo);
      if (!(el as HTMLElement).hasAttribute?.("data-today-arriving")) return style;
      return new Proxy(style, { get: (target, key) => (key === "transitionDuration" ? "0.18s" : Reflect.get(target, key)) });
    });
    fireEvent.click(send());
    await waitFor(() => expect(todayNow().held).toBe("held:box:lifeos:o2"));
    // Never "3 of 4": the sent item is counted as done, not as waiting.
    expect(run()).toBe("2 of 3");
    // What it holds is inert, to the pointer and the keys alike, until its fade is over.
    const body = sheet.querySelector<HTMLElement>("[data-today-arriving]");
    expect(body).not.toBeNull();
    expect(body!.firstElementChild!.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(body);
    fireEvent.transitionEnd(body!, { propertyName: "opacity" });
    expect(sheet.querySelector("[data-today-arriving]")).toBeNull();
    expect(body!.firstElementChild!.hasAttribute("inert")).toBe(false);
    // The second press, with the list still on its way: the sheet goes on to the third, never back to the first.
    await waitFor(() => expect(send().disabled).toBe(false));
    fireEvent.click(send());
    await waitFor(() => expect(todayNow().held).toBe("held:box:lifeos:o3"));
    expect(run()).toBe("3 of 3");
    await waitFor(() => expect(send().disabled).toBe(false));
    fireEvent.click(send());
    // The last decision closes the sheet, though the host's list still names all three.
    await waitFor(() => expect(todayNow().held).toBeNull());
    expect(world.calls.filter((c) => c.method === "work.outbox.send").map((c) => (c.params.ref as { id: string }).id)).toEqual(["o1", "o2", "o3"]);
    await act(async () => {
      release();
      await world.listHeld;
    });
    await waitFor(() => expect(screen.getByText("All clear")).toBeTruthy());
  });

  it("a Send the host refuses says so in the sheet itself: a sheet lies over the toasts", async () => {
    world.items.set("box", [mail("o1", "Marcus Bell", "Sponsor deck")]);
    await loadOutbox();
    render(<View onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Send to Marcus Bell, Sponsor deck" }));
    const sheet = await screen.findByRole("dialog");
    const send = () => within(sheet).getByRole("button", { name: "Send" }) as HTMLButtonElement;
    await waitFor(() => expect(send().disabled).toBe(false));
    world.sendRefused = "The mail account is signed out";
    fireEvent.click(send());
    const alert = await within(sheet).findByRole("alert");
    expect(alert.textContent).toBe("The mail account is signed out");
    // Nothing moved on, and a press that goes through takes the words away.
    expect(todayNow().held).toBe("held:box:lifeos:o1");
    world.sendRefused = null;
    await waitFor(() => expect(send().disabled).toBe(false));
    fireEvent.click(send());
    await waitFor(() => expect(todayNow().held).toBeNull());
  });

  it("hands the sheet on in the order he saw, though the host's list dropped the item before its answer was back", () => {
    const order = ["a", "b", "c"];
    // The pressed item is already gone from the live list: the next one down still takes the sheet.
    expect(nextHeld("a", order, ["b", "c"])).toBe("b");
    expect(nextHeld("b", order, ["a", "b", "c"])).toBe("c");
    // After the last, the nearest before it; with none left, the sheet closes.
    expect(nextHeld("c", order, ["a", "b"])).toBe("b");
    expect(nextHeld("b", order, ["b"])).toBeNull();
    // An item decided elsewhere meanwhile is passed over.
    expect(nextHeld("a", order, ["c"])).toBe("c");
    expect(nextHeld("z", order, ["a"])).toBeNull();
  });

  it("gives focus back to the page's list when it closes, to the row that took the sent one's place", async () => {
    world.items.set("box", [mail("o1", "Marcus Bell", "Sponsor deck"), mail("o2", "Dana Reyes", "Spring budget")]);
    await loadOutbox();
    render(<View onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Send to Marcus Bell, Sponsor deck" }));
    const sheet = await screen.findByRole("dialog");
    const send = () => within(sheet).getByRole("button", { name: "Send" }) as HTMLButtonElement;
    await waitFor(() => expect(send().disabled).toBe(false));
    fireEvent.click(send());
    await waitFor(() => expect(rowTitles()).toEqual(["Send to Dana Reyes"]));
    act(() => openHeld(null));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Send to Dana Reyes, Spring budget", hidden: true })));
  });

  it("an item another device decided leaves the sheet saying so, never the next item under his Send", async () => {
    world.items.set("box", [mail("o1", "Marcus Bell", "Sponsor deck"), mail("o2", "Dana Reyes", "Spring budget")]);
    await loadOutbox();
    render(<View onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Send to Marcus Bell, Sponsor deck" }));
    const sheet = await screen.findByRole("dialog");
    world.items.get("box")![0]!.state = "sent";
    await act(async () => {
      await loadOutbox();
    });
    expect(sheet.textContent).toContain("No longer waiting");
    expect(within(sheet).queryByRole("button", { name: "Send" })).toBeNull();
  });
});

describe("a source", () => {
  const SECTION = { id: "money", title: "Money", order: 60, empty: "Nothing owed" };

  it("that throws while it runs is left out and logged, and the page shows the rest", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: TodaySource = {
      id: "broken",
      section: { id: "broken", title: "Broken", order: 50, empty: "" },
      use: () => {
        throw new Error("a pillar's bug");
      },
    };
    world.items.set("box", [mail("o1", "Marcus Bell", "Sponsor deck")]);
    await loadOutbox();
    resetToday([held, broken]);
    render(<View onClose={() => {}} />);
    await waitFor(() => expect(todayNow().sources.map((s) => s.id)).toEqual(["held"]));
    expect(todayNow().broken.map((s) => s.id)).toEqual(["broken"]);
    expect(rowTitles()).toEqual(["Send to Marcus Bell"]);
    // It is run no more, and its section says so in one line: the page never passes over it in silence.
    expect(section("broken").querySelector('[data-view-state="failed"]')!.textContent).toBe("Today could not show this");
    expect(warned.mock.calls.some((call) => String(call[0]).includes("broken"))).toBe(true);
  });

  it("that throws is never passed over by All clear, and one with no section says so under Also", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: TodaySource = {
      id: "review",
      use: () => {
        throw new Error("a pillar's bug");
      },
    };
    await loadOutbox();
    resetToday([held, broken]);
    render(<View onClose={() => {}} />);
    await waitFor(() => expect(todayNow().broken.map((s) => s.id)).toEqual(["review"]));
    expect(screen.queryByText("All clear")).toBeNull();
    // Under Also the line names what is missing: two broken sources there are two lines.
    expect(section("also").querySelector('[data-view-state="failed"]')!.textContent).toBe("Today could not show the weekly review");
  });

  it("that reads hosts paints the rows it had in the first frame of a reopen, before any host is asked again", async () => {
    world.owed = 2;
    const owed: TodaySource = {
      id: "money",
      section: { id: "money", title: "Owed", order: 60, empty: "", fold: 5 },
      use(env) {
        const read = useEachWorkspace<{ n: number }>(env, "work.test.owed", (w) => ({ workspaceId: w.workspaceId }));
        return useMemo(
          () => ({
            rows: read.answers.flatMap(({ workspace, value }) => Array.from({ length: value.n }, (_, i) => ({ key: `money:${workspace.workspaceId}:${i}`, section: "money", sector: workspace.sector, title: `Owed ${workspace.workspaceId} ${i}`, open: () => {} }))),
            loading: read.loading,
            failed: read.failed,
            ...(read.stale ? { stale: true } : {}),
          }),
          [read],
        );
      },
    };
    await loadOutbox();
    resetToday([held, owed]);
    const { unmount } = render(<View onClose={() => {}} />);
    await waitFor(() => expect(rowTitles()).toHaveLength(4));
    unmount();
    render(<View onClose={() => {}} />);
    // The fresh read has asked no host yet: the rows it had stand, with no bones over them.
    expect(rowTitles()).toHaveLength(4);
    expect(section("money").querySelector('[role="status"][aria-busy]')).toBeNull();
    // Each job starts with its last value, read again: still none, once the hosts are asked.
    await act(async () => {});
    expect(rowTitles()).toHaveLength(4);
    expect(section("money").querySelector('[role="status"][aria-busy]')).toBeNull();
  });

  it("whose read failed with no section of its own says so under Also, with its Retry, and the page is not clear", async () => {
    const retry = vi.fn();
    const failed = { rows: [], failed: [{ environmentId: "mac", error: TIMED_OUT, retry }] };
    await loadOutbox();
    resetToday([held, { id: "digest", use: () => failed }]);
    render(<View onClose={() => {}} />);
    expect(screen.queryByText("All clear")).toBeNull();
    const line = section("also").querySelector<HTMLElement>('[data-view-state="failed"]')!;
    expect(line.textContent).toBe("Mac did not answerRetry");
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("with rows and a read some job needs still out keeps its rows usable and draws one bone under them", async () => {
    await loadOutbox();
    const opened = vi.fn();
    const answer = { rows: [{ key: "owed:1", section: "money", sector: "unify" as const, title: "Northfield Parks owes 420", open: opened }], loading: true };
    const money: TodaySource = { id: "money", section: { id: "money", title: "Money", order: 60, empty: "Nothing owed", bones: "lines" }, use: () => answer };
    resetToday([held, money]);
    render(<View onClose={() => {}} />);
    const bones = () => section("money").querySelectorAll("[data-today-bone]");
    expect(rowTitles()).toEqual(["Northfield Parks owes 420"]);
    expect(bones()).toHaveLength(1);
    expect(section("money").querySelector('[role="status"][aria-busy]')!.getAttribute("aria-label")).toBe("Loading more of Money");
    // The bone is an item of the list it stands in.
    expect(section("money").querySelector('[role="status"][aria-busy]')!.parentElement!.getAttribute("role")).toBe("listitem");
    fireEvent.click(screen.getByRole("button", { name: "Northfield Parks owes 420" }));
    expect(opened).toHaveBeenCalledTimes(1);
    // The read is back: the bone goes, the row stays.
    act(() => putAnswer("money", { rows: answer.rows }));
    expect(bones()).toHaveLength(0);
    expect(rowTitles()).toEqual(["Northfield Parks owes 420"]);
  });

  it("adds a section of its own with a tick and two verbs, and a mark on another source's row", async () => {
    const snooze = vi.fn();
    const done = vi.fn(async () => {});
    const opened = vi.fn();
    const answer = {
      rows: [{ key: "owed:1", section: "money", sector: "unify" as const, title: "Northfield Parks owes 420", when: "9 days", late: true, lead: { kind: "tick" as const, label: "Mark paid", run: done }, open: opened, acts: [{ label: "Remind", run: snooze }] }],
      marks: [{ key: "held:box:lifeos:o1", note: "Overlaps Staff sync", late: true }],
    };
    const money: TodaySource = { id: "money", section: SECTION, use: () => answer };
    world.items.set("box", [mail("o1", "Marcus Bell", "Sponsor deck")]);
    await loadOutbox();
    resetToday([held, money]);
    render(<View onClose={() => {}} />);
    expect([...document.querySelectorAll("[data-today-section]")].map((s) => s.getAttribute("data-today-section"))).toEqual(["held", "money"]);
    // The mark's note takes the held row's second line, in the fault's tone.
    const heldRow = document.querySelector<HTMLElement>('[data-today-row="held:box:lifeos:o1"]')!;
    expect(heldRow.textContent).toContain("Overlaps Staff sync");
    expect(heldRow.textContent).not.toContain("Sponsor deck");
    const row = document.querySelector<HTMLElement>('[data-today-row="owed:1"]')!;
    expect(row.textContent).toContain("Unify");
    fireEvent.click(within(row).getByRole("button", { name: "Remind" }));
    expect(snooze).toHaveBeenCalledTimes(1);
    fireEvent.click(within(row).getByRole("button", { name: "Northfield Parks owes 420" }));
    expect(opened).toHaveBeenCalledTimes(1);
    // The tick holds a moment so it reads, then runs.
    vi.useFakeTimers();
    try {
      fireEvent.click(within(row).getByRole("checkbox", { name: "Mark paid" }));
      expect(done).not.toHaveBeenCalled();
      expect(row.querySelector("[data-row-title]")!.className).toContain("line-through");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(350);
      });
      expect(done).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the keyboard", () => {
  const SECTION = { id: "money", title: "Money", order: 60, empty: "Nothing owed" };
  const done = vi.fn(async () => {});
  const answer = {
    rows: [
      { key: "owed:1", section: "money", sector: "unify" as const, title: "First owed", lead: { kind: "tick" as const, label: "Mark first paid", run: done }, open: () => {}, acts: [{ label: "Remind", run: () => {} }] },
      { key: "owed:2", section: "money", sector: "unify" as const, title: "Second owed", open: () => {} },
    ],
  };
  const money: TodaySource = { id: "money", section: SECTION, use: () => answer };
  const open = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}`) });

  async function mount() {
    world.items.set("box", [mail("o1", "Marcus Bell", "Sponsor deck")]);
    await loadOutbox();
    resetToday([held, money]);
    render(<View onClose={() => {}} />);
  }

  it("focus lands on the first row when the page opens, and the list is one tab stop", async () => {
    await mount();
    await waitFor(() => expect(document.activeElement).toBe(open("Send to Marcus Bell")));
    const stops = [...document.querySelectorAll<HTMLElement>("[data-today] [tabindex]")].filter((el) => el.tabIndex === 0);
    expect(stops).toEqual([open("Send to Marcus Bell")]);
    // The other rows, their ticks and their verbs wait for the arrows.
    expect(open("First owed").tabIndex).toBe(-1);
    expect(screen.getByRole("checkbox", { name: "Mark first paid" }).tabIndex).toBe(-1);
    expect(screen.getByRole("button", { name: "Remind" }).tabIndex).toBe(-1);
  });

  it("↓ ↑ Home and End move through every row in page order, across sections, and the ends hold", async () => {
    await mount();
    await waitFor(() => expect(document.activeElement).toBe(open("Send to Marcus Bell")));
    const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
    press("ArrowDown");
    await waitFor(() => expect(document.activeElement).toBe(open("First owed")));
    // The row the arrows are on takes Tab, and its own controls with it.
    expect(screen.getByRole("checkbox", { name: "Mark first paid" }).tabIndex).toBe(0);
    expect(screen.getByRole("button", { name: "Remind" }).tabIndex).toBe(0);
    expect(open("Send to Marcus Bell").tabIndex).toBe(-1);
    press("ArrowDown");
    await waitFor(() => expect(document.activeElement).toBe(open("Second owed")));
    press("ArrowDown");
    expect(document.activeElement).toBe(open("Second owed"));
    press("Home");
    await waitFor(() => expect(document.activeElement).toBe(open("Send to Marcus Bell")));
    press("ArrowUp");
    expect(document.activeElement).toBe(open("Send to Marcus Bell"));
    press("End");
    await waitFor(() => expect(document.activeElement).toBe(open("Second owed")));
  });

  it("Space ticks a task from its row and does not open it; Enter is the row's press", async () => {
    await mount();
    await waitFor(() => expect(document.activeElement).toBe(open("Send to Marcus Bell")));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(open("First owed")));
    const row = open("First owed");
    const down = fireEvent.keyDown(row, { key: " " });
    // The key is taken: the button's own click on Space never runs.
    expect(down).toBe(false);
    expect(fireEvent.keyUp(row, { key: " " })).toBe(false);
    expect(document.querySelector('[data-today-row="owed:1"] [data-row-title]')!.className).toContain("line-through");
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    // A row with no tick leaves Space to the button, which presses it.
    expect(fireEvent.keyDown(open("Second owed"), { key: " " })).toBe(true);
  });

  it("a tick he made still completes when he leaves the page inside its hold, and one he took back does not", async () => {
    done.mockClear();
    world.items.set("box", [mail("o1", "Marcus Bell", "Sponsor deck")]);
    await loadOutbox();
    resetToday([held, money]);
    const first = render(<View onClose={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Mark first paid" }));
    expect(done).not.toHaveBeenCalled();
    // The page closes at once (a key, another row's press): the task he saw struck through is not left due.
    first.unmount();
    expect(done).toHaveBeenCalledTimes(1);
    // Ticked and unticked inside the hold, then the page closes: nothing runs.
    const second = render(<View onClose={() => {}} />);
    const box = screen.getByRole("checkbox", { name: "Mark first paid" });
    fireEvent.click(box);
    fireEvent.click(box);
    second.unmount();
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe("a row that leaves", () => {
  const SECTION = { id: "money", title: "Money", order: 60, empty: "Nothing owed" };
  const rows = ["First", "Second", "Third"].map((title, i) => ({ key: `owed:${i + 1}`, section: "money", sector: "unify" as const, title: `${title} owed`, open: () => {} }));
  const answer = { rows };
  const money: TodaySource = { id: "money", section: SECTION, use: () => answer };
  const slot = (key: string) => document.querySelector<HTMLElement>(`[data-today-row="${key}"]`)?.parentElement ?? null;
  const slots = () => [...section("money").querySelectorAll("[data-today-slot]")].map((el) => el.getAttribute("data-today-slot"));

  beforeEach(async () => {
    await loadOutbox();
    resetToday([money]);
  });

  it("by his own act fades where it stands, inert; then its place closes; then it is gone and focus is on the row that took its place", async () => {
    render(<View onClose={() => {}} />);
    await waitFor(() => expect(document.activeElement?.getAttribute("data-roving-key")).toBe("owed:1"));
    vi.useFakeTimers();
    try {
      act(() => leave("owed:1"));
      const first = slot("owed:1")!;
      expect(first.getAttribute("data-today-slot")).toBe("leaving");
      expect(first.hasAttribute("inert")).toBe(true);
      expect(first.querySelector("[data-today-row]")!.className).toContain("opacity-0");
      // The fade is a token's, and stays under reduced motion.
      expect(first.querySelector("[data-today-row]")!.className).toContain("duration-(--dur-fast)");
      expect(first.querySelector("[data-today-row]")!.className).toContain("motion-reduce:transition-opacity");
      // The arrows no longer stop on it: the next row is the tab stop.
      expect((document.querySelector('[data-roving-key="owed:2"]') as HTMLElement).tabIndex).toBe(0);
      act(() => void vi.advanceTimersByTime(120));
      // Its place closes: the slot stays, with nothing in it, while the rows under it glide up.
      expect(slots()).toEqual(["closing", "in", "in"]);
      expect(document.querySelector('[data-today-row="owed:1"]')).toBeNull();
      act(() => void vi.advanceTimersByTime(180));
      expect(slots()).toEqual(["in", "in"]);
      expect(rowTitles()).toEqual(["Second owed", "Third owed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("comes back as it was when the act fails", () => {
    render(<View onClose={() => {}} />);
    act(() => leave("owed:2"));
    expect(slot("owed:2")!.getAttribute("data-today-slot")).toBe("leaving");
    act(() => comeBack("owed:2"));
    expect(slot("owed:2")!.getAttribute("data-today-slot")).toBe("in");
    expect(slot("owed:2")!.hasAttribute("inert")).toBe(false);
    expect(rowTitles()).toEqual(["First owed", "Second owed", "Third owed"]);
  });

  it("because the world changed just goes: no fade, no closing place", () => {
    render(<View onClose={() => {}} />);
    act(() => putAnswer("money", { rows: rows.slice(1) }));
    expect(slots()).toEqual(["in", "in"]);
  });

  it("a row that arrives while he is looking lands; the rows it opened with, and those his unfold shows, do not", async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ key: `owed:${i + 1}`, section: "money", sector: "unify" as const, title: `Owed ${i + 1}`, open: () => {} }));
    const folded: TodaySource = { id: "money", section: { ...SECTION, fold: 5 }, use: () => answerOf };
    const answerOf = { rows: many };
    resetToday([folded]);
    render(<View onClose={() => {}} />);
    const landed = () => [...section("money").querySelectorAll(".step-land [data-today-row]")].map((el) => el.getAttribute("data-today-row"));
    expect(landed()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "2 more" }));
    expect(rowTitles()).toHaveLength(7);
    expect(landed()).toEqual([]);
    act(() => putAnswer("money", { rows: [...many, { key: "owed:new", section: "money", sector: "unify" as const, title: "Just arrived", open: () => {} }] }));
    expect(landed()).toEqual(["owed:new"]);
  });
});
