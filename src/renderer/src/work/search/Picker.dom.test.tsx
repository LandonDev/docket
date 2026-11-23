// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SearchAnswer, SearchGroup, SearchHit } from "@shared/work/search";
import type { WorkspaceMeta } from "../../lib/tcserver/types";

/**
 * The picker on screen (docs/DESIGN.md "Work search"): groups fill under
 * their headings, the keys, the scope, one kind alone, and the list holding
 * still. The hosts' answers are the test's; rows are 28px in a list the
 * test measures for jsdom, which lays nothing out.
 */

const ws = (id: string, sector: string, name: string): WorkspaceMeta => ({ id, name, path: `/w/${id}`, kind: "work", sector, environmentId: "box" }) as unknown as WorkspaceMeta;
const WORKSPACES = [ws("w-purdue", "purdue", "Purdue"), ws("w-cosmic", "cosmic", "Cosmic")];
const asks = vi.hoisted(() => [] as { host: string; params: Record<string, unknown>; answer(a: unknown): void; fail(): void }[]);
const asked = vi.hoisted(() => [] as (string | null)[]);
const world = vi.hoisted(() => ({ hosts: [{ id: "box", name: "The box", home: true }] as { id: string; name: string; home: boolean }[], windowIds: ["w-purdue"] as string[] | null }));

vi.mock("../../lib/tcserver/workspaces", async (original) => ({ ...(await original<typeof import("../../lib/tcserver/workspaces")>()), useWorkspaces: () => WORKSPACES }));
vi.mock("../../stores/project", async (original) => ({ ...(await original<typeof import("../../stores/project")>()), useSelectedWorkspaceIds: () => world.windowIds }));
vi.mock("../../lib/workSwitch", async (original) => {
  const hosts = new Set(["box"]);
  return { ...(await original<typeof import("../../lib/workSwitch")>()), useWorkHosts: () => hosts };
});
vi.mock("./hosts", async (original) => {
  const real = await original<typeof import("./hosts")>();
  return {
    ...real,
    searchHosts: (job: import("./hosts").Job | null) => {
      asked.push(job?.key ?? null);
      return { hosts: world.hosts.map((h) => ({ ...h, ...(job ? { workspaceId: job.ids[0] } : {}) })), offline: [] };
    },
    askHost: (host: string, params: Record<string, unknown>) => new Promise((answer, fail) => void asks.push({ host, params, answer, fail: () => fail(new Error("gone")) })),
  };
});
const opened = vi.hoisted(() => ({ hits: [] as { key: string; host: string }[], threads: [] as string[] }));
vi.mock("./open", () => ({
  openHit: async (hit: SearchHit, host: string) => {
    opened.hits.push({ key: hit.key, host });
    return "opened";
  },
  startAbout: (hit: SearchHit) => {
    opened.threads.push(hit.key);
    return true;
  },
  canStartAbout: (hit: SearchHit) => !!hit.chip,
}));
const { WorkSearch, SPIN_AFTER_MS, SPIN_FOR_MS } = await import("./Picker");
const { openWorkSearch } = await import("../../lib/workSearchPort");

const hit = (key: string, kind: string, over: Partial<SearchHit> = {}): SearchHit => ({ key, kind, title: `Budget ${key}`, workspaceId: "w-purdue", open: { to: "view", view: kind }, ...over });
const group = (kind: string, label: string, hits: SearchHit[], over: Partial<SearchGroup> = {}): SearchGroup => ({ source: `search.${kind}`, kind, label, hits, more: false, ...over });
const answer = (groups: SearchGroup[], over: Partial<SearchAnswer> = {}): SearchAnswer => ({ groups, pending: [], quiet: [], ...over });

/** jsdom lays nothing out: every row and heading of the list is 28px, top to bottom. */
const ROW = 28;
const top = (el: Element): number => {
  const list = el.closest("[data-work-search-list]");
  if (!list || list === el) return 0;
  let child: Element = el;
  while (child.parentElement && child.parentElement !== list) child = child.parentElement;
  return [...list.children].indexOf(child) * ROW;
};
const offsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
const scrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
/** Every write of the list's scroll offset that moved it: each is a scroll event in a browser. */
const moves: number[] = [];
/** The list scrolls as a browser's does: never past what its box leaves below, and a box let go to its rows' height pulls it back for good. */
const CAP = 380;
const scrolled = new WeakMap<Element, number>();
const clamped = (el: Element): number => {
  const all = el.children.length * ROW;
  const box = (el as HTMLElement).style.height ? Number.parseFloat((el as HTMLElement).style.height) : Math.min(all, CAP);
  const at = Math.min(scrolled.get(el) ?? 0, Math.max(0, all - box));
  scrolled.set(el, at);
  return at;
};
beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) { return this.hasAttribute("data-work-search-list") ? clamped(this) : (scrolled.get(this) ?? 0); },
    set(this: Element, to: number) {
      if (this.hasAttribute("data-work-search-list") && clamped(this) !== Math.max(0, to)) moves.push(to);
      scrolled.set(this, Math.max(0, to));
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get(this: HTMLElement) { return this.parentElement?.hasAttribute("data-work-search-list") ? ROW : 0; } });
  Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true, get(this: HTMLElement) { return top(this); } });
  Object.defineProperty(Element.prototype, "scrollHeight", { configurable: true, get(this: Element) { return this.hasAttribute("data-work-search-list") ? this.children.length * ROW : 0; } });
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  if (offsetTop) Object.defineProperty(HTMLElement.prototype, "offsetTop", offsetTop);
  if (scrollHeight) Object.defineProperty(Element.prototype, "scrollHeight", scrollHeight);
  if (scrollTop) Object.defineProperty(Element.prototype, "scrollTop", scrollTop);
  if (offsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
  moves.length = 0;
  vi.useRealTimers();
  asks.length = 0;
  asked.length = 0;
  opened.hits.length = 0;
  opened.threads.length = 0;
  world.hosts = [{ id: "box", name: "The box", home: true }];
  world.windowIds = ["w-purdue"];
});

const onClose = vi.fn();
async function mount(seed: Record<string, unknown> = {}) {
  onClose.mockClear();
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<WorkSearch seed={seed} onClose={onClose} />);
  });
  return view;
}
const field = (): HTMLInputElement => document.querySelector<HTMLInputElement>("[data-work-search] [data-slot=input]")!;
const type = async (text: string): Promise<void> => void (await act(async () => fireEvent.change(field(), { target: { value: text } })));
const land = async (index: number, a: SearchAnswer): Promise<void> => void (await act(async () => asks[index].answer(a)));
const press = async (key: string, mods: Record<string, boolean> = {}): Promise<void> => void (await act(async () => fireEvent.keyDown(field(), { key, ...mods })));
const list = (): HTMLElement => document.querySelector<HTMLElement>("[data-work-search-list]")!;
const selected = (): string | null => list()?.querySelector('[aria-selected="true"]')?.getAttribute("data-row") ?? null;

describe("Work search", () => {
  it("is the Go to File shell with its own mark, asks at once with nothing typed, and shows Recent and nothing else", async () => {
    await mount();
    expect(screen.getByRole("dialog").hasAttribute("data-work-search")).toBe(true);
    expect(asks.map((a) => a.params)).toEqual([{ text: "", tier: "instant" }]);
    expect(list()).toBeNull();
    // with no row there is no rule under the field, and the field drives no list
    expect(document.querySelector("[data-picker-rule]")).toBeNull();
    expect(field().getAttribute("role")).toBeNull();
    await land(0, answer([group("recent", "Recent", [hit("r1", "mail"), hit("r2", "thread")])]));
    expect([...list().children].map((el) => el.textContent)).toEqual(expect.arrayContaining(["Recent"]));
    expect(list().querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(document.querySelector("[data-picker-rule]")).not.toBeNull();
    // Recent has no times: no column is kept for them
    expect(list().querySelector("[data-time]")).toBeNull();
  });

  it("fills groups under their headings in the fixed order, with the job at each row's end while jobs mix, and Return opens the highlighted row", async () => {
    await mount();
    await type("budget");
    const last = asks.length - 1;
    expect(asks[last].params).toEqual({ text: "budget", tier: "instant" });
    await land(last, answer([group("thread", "Threads", [hit("thread:t1", "thread")]), group("mail", "Mail", [hit("m1", "mail", { detail: "Dana Kim" }), hit("m2", "mail", { workspaceId: "w-cosmic" })])]));
    // an answer in a few frames never shows the spinner
    expect(document.querySelector("[data-work-search-busy]")).toBeNull();
    expect([...list().children].map((el) => (el.getAttribute("role") === "option" ? el.getAttribute("data-row") : `# ${el.textContent}`))).toEqual(["# Mail", "hit:m1", "hit:m2", "# Threads", "hit:thread:t1"]);
    expect([...list().querySelectorAll("[data-job]")].map((el) => el.textContent)).toEqual(["Purdue", "Cosmic", "Purdue"]);
    expect(list().querySelector('[data-row="hit:m1"] [data-sector="purdue"]')).not.toBeNull();
    expect(list().querySelector('[data-row="hit:m1"]')!.textContent).toContain("Dana Kim");
    // the words he typed are marked in the title by weight
    expect(list().querySelector('[data-row="hit:m1"] mark')!.textContent).toBe("Budget");
    expect(selected()).toBe("hit:m1");
    // the field is a combobox over the list, and names the row the highlight is on
    expect([field().getAttribute("role"), field().getAttribute("aria-controls"), field().getAttribute("aria-expanded")]).toEqual(["combobox", list().id, "true"]);
    expect(document.getElementById(field().getAttribute("aria-activedescendant")!)).toBe(list().querySelector('[data-row="hit:m1"]'));
    await press("ArrowDown");
    expect(selected()).toBe("hit:m2");
    expect(document.getElementById(field().getAttribute("aria-activedescendant")!)).toBe(list().querySelector('[data-row="hit:m2"]'));
    await press("ArrowUp");
    await press("ArrowUp");
    expect(selected()).toBe("hit:thread:t1");
    await press("Enter");
    expect(opened.hits).toEqual([{ key: "thread:t1", host: "box" }]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("holds the highlighted row still once he has moved it: what lands above is taken up by the scroller in the same frame", async () => {
    world.hosts = [
      { id: "box", name: "The box", home: true },
      { id: "mac", name: "MacBook", home: false },
    ];
    await mount();
    await type("budget");
    const [box, mac] = asks.slice(-2);
    expect([box.host, mac.host]).toEqual(["box", "mac"]);
    await act(async () => mac.answer(answer([group("thread", "Threads", [hit("thread:t1", "thread"), hit("thread:t2", "thread")])])));
    await press("ArrowDown");
    expect(selected()).toBe("hit:thread:t2");
    const row = (): HTMLElement => list().querySelector<HTMLElement>('[data-row="hit:thread:t2"]')!;
    const before = row().offsetTop - list().scrollTop;
    expect(before).toBe(2 * ROW);
    // Mail lands above: a heading and three rows, 112px.
    await act(async () => box.answer(answer([group("mail", "Mail", [hit("m1", "mail"), hit("m2", "mail"), hit("m3", "mail")])])));
    expect(row().offsetTop).toBe(6 * ROW);
    expect(row().offsetTop - list().scrollTop).toBe(before);
    expect(list().scrollTop).toBe(4 * ROW);
    // the box is no taller than the rows from there down, so the scroller had that much to take
    expect(list().style.height).toBe(`${3 * ROW}px`);
    expect(selected()).toBe("hit:thread:t2");
    // the browser tells of the scroll the hold itself made: the row stays where it is (every row fits the cap here,
    // so a box let go before its place was read would be pulled back to the top)
    expect(moves).toEqual([4 * ROW]);
    await act(async () => void fireEvent.scroll(list()));
    expect(list().scrollTop).toBe(4 * ROW);
    expect(list().style.height).toBe(`${3 * ROW}px`);
    expect(row().offsetTop - list().scrollTop).toBe(before);
    // and that answer to the event moved nothing, so no further event comes of it
    expect(moves).toEqual([4 * ROW]);
    // he scrolls up to see what landed: the box grows back as it comes down, to all its rows at the top
    await act(async () => {
      list().scrollTop = 2 * ROW;
      fireEvent.scroll(list());
    });
    expect(list().style.height).toBe(`${5 * ROW}px`);
    await act(async () => {
      list().scrollTop = 0;
      fireEvent.scroll(list());
    });
    expect(list().style.height).toBe("");
    expect(selected()).toBe("hit:thread:t2");
    await press("Enter");
    expect(opened.hits).toEqual([{ key: "thread:t2", host: "mac" }]);
  });

  it("leaves the highlight on the first row, and the list at its top, while he has not moved it", async () => {
    world.hosts = [
      { id: "box", name: "The box", home: true },
      { id: "mac", name: "MacBook", home: false },
    ];
    await mount();
    await type("budget");
    const [box, mac] = asks.slice(-2);
    await act(async () => mac.answer(answer([group("thread", "Threads", [hit("thread:t1", "thread")])])));
    expect(selected()).toBe("hit:thread:t1");
    await act(async () => box.answer(answer([group("mail", "Mail", [hit("m1", "mail")])])));
    expect(selected()).toBe("hit:m1");
    expect(list().scrollTop).toBe(0);
    expect(list().style.height).toBe("");
  });

  it("opens on all jobs; the search key again narrows to the window's job and again widens, from the field or from the menu's command", async () => {
    await mount();
    const scope = (): string => document.querySelector("[data-work-search-scope]")!.textContent ?? "";
    expect(scope()).toBe("All jobs");
    await type("budget");
    expect(asked.at(-1)).toBeNull();
    await press("k", { metaKey: true, shiftKey: true });
    expect(scope()).toBe("Purdue");
    expect(asked.at(-1)).toBe("purdue");
    expect(asks.at(-1)!.params).toEqual({ text: "budget", workspaceId: "w-purdue", tier: "instant" });
    // scoped to one job the job column is gone
    await land(asks.length - 1, answer([group("mail", "Mail", [hit("m1", "mail")])]));
    expect(list().querySelector("[data-job]")).toBeNull();
    // the desktop's menu sends the same key through the door (App's command), once that press is over
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValue(100_000);
    await act(async () => openWorkSearch());
    expect(scope()).toBe("All jobs");
    expect(asked.at(-1)).toBeNull();
    // one press that arrives both ways, a few milliseconds apart, flips once
    clock.mockReturnValue(200_000);
    await act(async () => openWorkSearch());
    clock.mockReturnValue(200_010);
    await act(async () => openWorkSearch());
    expect(scope()).toBe("Purdue");
    clock.mockRestore();
  });

  it("opens held to the job and the kind a screen named", async () => {
    await mount({ text: "budget", workspaceId: "w-cosmic", kind: "mail" });
    expect(field().value).toBe("budget");
    expect(document.querySelector("[data-work-search-scope]")!.textContent).toBe("Cosmic");
    expect(document.querySelector("[data-picker-leading]")!.textContent).toBe("Mail");
    expect(asks.at(-1)!.params).toEqual({ text: "budget", workspaceId: "w-cosmic", tier: "instant", kind: "mail" });
  });

  it("offers all of a kind in one muted row: Return narrows to it, Escape steps back out, and a second Escape closes", async () => {
    await mount();
    await type("budget");
    await land(asks.length - 1, answer([group("mail", "Mail", [hit("m1", "mail")], { more: true })]));
    const all = list().querySelector('[data-row="all:mail"]')!;
    expect(all.textContent).toBe("All mail for “budget”");
    await press("ArrowDown");
    expect(selected()).toBe("all:mail");
    await press("Enter");
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector("[data-picker-leading]")!.textContent).toBe("Mail");
    expect(asks.at(-1)!.params).toEqual({ text: "budget", tier: "instant", kind: "mail" });
    // the field names the kind: the list says it no second time
    await land(asks.length - 1, answer([group("mail", "Mail", [hit("m1", "mail"), hit("m2", "mail")])]));
    expect([...list().children].map((el) => el.getAttribute("role"))).toEqual(["option", "option"]);
    await press("Escape");
    expect(document.querySelector("[data-picker-leading]")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(asks.at(-1)!.params).toEqual({ text: "budget", tier: "instant" });
    await press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says nothing found in one muted row, and in one job offers the search of all jobs, which Return takes", async () => {
    await mount({ workspaceId: "w-purdue" });
    await type("zebra");
    await land(asks.length - 1, answer([]));
    expect(document.querySelector("[data-picker-note]")!.textContent).toBe("Nothing for “zebra”");
    expect(selected()).toBe("widen");
    await press("Enter");
    expect(document.querySelector("[data-work-search-scope]")!.textContent).toBe("All jobs");
    expect(asks.at(-1)!.params).toEqual({ text: "zebra", tier: "instant" });
  });

  it("says what could not be searched in one quiet line at the foot, under what was found", async () => {
    await mount();
    await type("budget");
    await land(asks.length - 1, answer([group("thread", "Threads", [hit("thread:t1", "thread")])], { quiet: [{ cause: "lifeos", line: "This host is not signed in to LifeOS" }] }));
    const notes = [...document.querySelectorAll("[data-picker-note]")].map((el) => el.textContent);
    expect(notes).toEqual(["LifeOS is signed out on The box."]);
    expect(list().lastElementChild!.textContent).toBe("LifeOS is signed out on The box.");
  });

  it("⌘↩ starts a thread about the highlighted thing, and Tab stays in the field", async () => {
    await mount();
    await type("budget");
    const chip = { kind: "mail" as const, label: "Budget m1", ref: { at: "lifeos" as const, table: "mailThreads" as const, id: "m1" } };
    await land(asks.length - 1, answer([group("mail", "Mail", [hit("m1", "mail", { chip })])]));
    const tab = fireEvent.keyDown(field(), { key: "Tab" });
    expect(tab).toBe(false);
    await press("Enter", { metaKey: true });
    expect(opened.threads).toEqual(["m1"]);
    expect(opened.hits).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the spinner only for a wait he would notice, and then long enough to be seen", async () => {
    vi.useFakeTimers();
    const spinner = (): Element | null => document.querySelector("[data-work-search-busy]");
    await mount();
    await type("budget");
    expect(spinner()).toBeNull();
    await act(async () => void vi.advanceTimersByTime(SPIN_AFTER_MS - 1));
    expect(spinner()).toBeNull();
    await act(async () => void vi.advanceTimersByTime(1));
    expect(spinner()).not.toBeNull();
    // the answer lands at once after: the spinner stays its time, then goes
    await land(asks.length - 1, answer([group("mail", "Mail", [hit("m1", "mail")])]));
    await act(async () => void vi.advanceTimersByTime(SPIN_FOR_MS - 1));
    expect(spinner()).not.toBeNull();
    await act(async () => void vi.advanceTimersByTime(1));
    expect(spinner()).toBeNull();
  });

  it("opens the scope's menu from the field with ⌥↓, and the arrows alone still move the highlight", async () => {
    await mount();
    await type("budget");
    await land(asks.length - 1, answer([group("mail", "Mail", [hit("m1", "mail"), hit("m2", "mail")])]));
    await press("ArrowDown", { altKey: true });
    expect(selected()).toBe("hit:m1");
    // the menu's body is its own chunk
    expect(await screen.findByRole("menu")).not.toBeNull();
    expect(screen.getAllByRole("menuitemcheckbox").map((el) => el.textContent)).toEqual(["All jobs", "Purdue", "Cosmic"]);
  });

  it("tells a reader of one kind on the way in and out, names the list by it, and the field by what stands in it", async () => {
    await mount();
    const status = (): string => document.querySelector('[data-work-search] [role="status"]')!.textContent ?? "";
    expect(status()).toBe("");
    await type("budget");
    await land(asks.length - 1, answer([group("mail", "Mail", [hit("m1", "mail")], { more: true })]));
    expect(list().getAttribute("aria-label")).toBe("Work search results");
    expect(field().getAttribute("aria-describedby")).toBeNull();
    await press("ArrowDown");
    await press("Enter");
    expect(status()).toBe("Mail only");
    const leading = document.querySelector("[data-picker-leading]")!;
    expect(field().getAttribute("aria-describedby")).toBe(leading.id);
    await land(asks.length - 1, answer([group("mail", "Mail", [hit("m1", "mail")])]));
    expect(list().getAttribute("aria-label")).toBe("Mail results");
    await press("Escape");
    expect(status()).toBe("Every kind");
  });

  it("a quiet row reads as any highlighted row once the highlight is on it, and a long echo of his words stays on one line", async () => {
    await mount({ workspaceId: "w-purdue" });
    await type("zebra crossing at the corner of the long road");
    await land(asks.length - 1, answer([]));
    const widen = list().querySelector('[data-row="widen"]')!;
    expect(widen.getAttribute("aria-selected")).toBe("true");
    expect(widen.className).not.toContain("text-muted-foreground");
    expect(document.querySelector("[data-picker-note] span")!.className).toContain("truncate");
    await type("budget");
    await land(asks.length - 1, answer([group("mail", "Mail", [hit("m1", "mail")], { more: true })]));
    expect(list().querySelector('[data-row="all:mail"]')!.className).toContain("text-muted-foreground");
  });

  it("takes the kind away on Backspace at the field's start", async () => {
    await mount({ kind: "mail" });
    field().setSelectionRange(0, 0);
    await press("Backspace");
    expect(document.querySelector("[data-picker-leading]")).toBeNull();
  });
});
