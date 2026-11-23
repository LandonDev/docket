// @vitest-environment jsdom
/**
 * A Work workspace's Messages over made-up conversations (fixtures.ts), answered through the one
 * seam (data.ts) with no LifeOS: the rows and their unread mark, the filters, the search, each
 * empty state with its true cause, a conversation's runs, days and "New", the read mark on open,
 * and the sync line said once at every width.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MessagesDataProvider } from "./data";
import { CHATS, fixtureData, JOB, type FixtureOptions } from "./fixtures";
import { MessagesScreen } from "./MessagesView";
import { patchPage, resetPages, type MessagesPage } from "./page";

const opened = vi.hoisted(() => ({ connections: 0 }));
vi.mock("../shell/open", () => ({ openConnections: () => void opened.connections++ }));

beforeAll(() => {
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  resetPages();
});

const WS = "ws";
function mount(options: FixtureOptions = {}, page: Partial<MessagesPage> = {}, narrow = false) {
  const data = fixtureData(options);
  patchPage(WS, page);
  const view = render(
    <MessagesDataProvider value={data}>
      <MessagesScreen workspaceId={WS} job={JOB} narrow={narrow} />
    </MessagesDataProvider>,
  );
  return { data, ...view };
}

const row = (name: string): HTMLElement => screen.getAllByRole("option").find((el) => el.getAttribute("aria-label")?.includes(`, ${name}, `) || el.getAttribute("aria-label")?.startsWith(`${name}, `))!;
const nameOf = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>(".truncate")!;
const block = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-block="${id}"]`)!;

describe("the list", () => {
  it("lists the job's conversations newest first, with the unread dot and the name in weight", () => {
    mount();
    const options = within(screen.getByRole("listbox", { name: "Conversations" })).getAllByRole("option");
    expect(options[0]!.getAttribute("aria-label")).toMatch(/^Unread, #builds, Omar: @Alex/);
    const dana = row("Dana Lee");
    expect(dana.dataset.unread).toBe("true");
    expect(dana.querySelector("i")).not.toBeNull();
    expect(nameOf(dana).className).toContain("font-semibold");
    const priya = row("Priya Shah");
    expect(priya.dataset.unread).toBeUndefined();
    expect(priya.querySelector("i")).toBeNull();
    expect(nameOf(priya).className).toContain("text-muted-foreground");
  });

  it("leads a row's words with You, or a channel's with the writer's first name", () => {
    mount();
    expect(row("Omar Reyes").textContent).toContain("You: I'll take the controller bug");
    expect(row("#design-review").textContent).toContain("Ana: 250 feels right");
  });

  it("says the job's unread count in the head", () => {
    mount();
    const head = screen.getByRole("button", { name: /Messages/ });
    expect(head.textContent).toBe(`Messages${CHATS.filter((c) => c.unread).length}`);
  });

  it("narrows to a filter from the head's menu and names it there", async () => {
    const { data } = mount();
    fireEvent.click(screen.getByRole("button", { name: /Messages/ }));
    await act(async () => fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Unread" })));
    expect(data.log.chats.at(-1)).toBe("unread");
    expect(screen.getByRole("button", { name: /Unread/ })).toBeTruthy();
    const names = screen.getAllByRole("option").map((el) => nameOf(el).textContent);
    expect(names).toEqual(CHATS.filter((c) => c.unread).map((c) => c.name));
  });

  it("says Nothing unread under the filter, with the way back", () => {
    mount({ chats: CHATS.map((c) => ({ ...c, unread: false })) }, { filter: "unread" });
    expect(screen.getByText("Nothing unread")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(screen.getAllByRole("option")).toHaveLength(CHATS.length);
  });

  it("opens a conversation on a press and marks it read", () => {
    const { data } = mount();
    fireEvent.click(row("Dana Lee"));
    expect(data.log.read).toEqual(["c_dana"]);
    expect(row("Dana Lee").dataset.unread).toBeUndefined();
    expect(row("Dana Lee").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("log", { name: "Messages" })).toBeTruthy();
  });

  it("marks a row read or unread from its hover act, without opening it", () => {
    const { data } = mount();
    fireEvent.click(within(row("Dana Lee")).getByRole("button", { name: "Mark read" }));
    expect(data.log.read).toEqual(["c_dana"]);
    fireEvent.click(within(row("Dana Lee")).getByRole("button", { name: "Mark unread" }));
    expect(data.log.unread).toEqual(["c_dana"]);
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("draws the amber mark where a thread's draft waits", () => {
    mount({ drafted: ["c_priya"] });
    expect(row("Priya Shah").getAttribute("aria-label")).toContain("a draft waits");
    expect(row("Priya Shah").querySelector(".text-warning")).not.toBeNull();
    expect(row("Dana Lee").querySelector(".text-warning")).toBeNull();
  });
});

describe("the list's empty and loading states", () => {
  it("shows bones in the rows' place while the list loads", () => {
    mount({ loading: true });
    expect(document.querySelector("[data-row-bones]")).not.toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("says no chat is linked to the job, with Open Connections", () => {
    mount({ noSource: true });
    expect(screen.getByText(`No chat is linked to ${JOB}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Connections" }));
    expect(opened.connections).toBe(1);
  });

  it("says the job has no messages yet when its chat is linked", () => {
    mount({ empty: true });
    expect(screen.getByText(`No messages in ${JOB} yet`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Connections" })).toBeNull();
  });
});

describe("the search", () => {
  it("shows the messages that hold the words, lit, and the list again once cleared", () => {
    const { data } = mount();
    const field = screen.getByRole("searchbox", { name: "Search messages" });
    fireEvent.change(field, { target: { value: "controller" } });
    expect(data.log.searched).toContain("controller");
    const results = within(screen.getByRole("listbox", { name: "Search results" })).getAllByRole("option");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.querySelector("mark")?.textContent?.toLowerCase()).toBe("controller");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("listbox", { name: "Conversations" })).toBeTruthy();
  });

  it("says No matches with the way back, and Escape clears", () => {
    mount();
    const field = screen.getByRole("searchbox", { name: "Search messages" });
    fireEvent.change(field, { target: { value: "zebra" } });
    expect(screen.getByText("No matches")).toBeTruthy();
    fireEvent.keyDown(field, { key: "Escape" });
    expect((field as HTMLInputElement).value).toBe("");
  });
});

describe("a conversation", () => {
  it("draws one head for a writer's run, and a new one for another writer, a gap, or a day", () => {
    mount({}, { chatId: "c_dana" });
    // Yesterday 10:02 Dana, 10:09 and 10:10 him, 10:31 and 10:32 Dana.
    expect(block("c_dana_m0").dataset.head).toBe("true");
    expect(block("c_dana_m1").dataset.head).toBe("true");
    expect(block("c_dana_m2").dataset.head).toBeUndefined();
    expect(block("c_dana_m3").dataset.head).toBe("true");
    expect(block("c_dana_m4").dataset.head).toBeUndefined();
    expect(within(block("c_dana_m0")).getByRole("separator").getAttribute("aria-label")).toBe("Yesterday");
    expect(within(block("c_dana_m7")).getByRole("separator").getAttribute("aria-label")).toBe("Today");
    expect(within(block("c_dana_m3")).queryByRole("separator")).toBeNull();
  });

  it("puts New over the first message from someone else since he last read it, and keeps it once read", () => {
    const { data } = mount({}, { chatId: "c_dana" });
    expect(data.log.read).toEqual(["c_dana"]);
    const news = screen.getAllByRole("separator").filter((el) => el.getAttribute("aria-label")?.includes("New"));
    expect(news).toHaveLength(1);
    expect(block("c_dana_m8").contains(news[0]!)).toBe(true);
  });

  it("names the conversation and its source once in the toolbar, and keeps its words' lines and links", () => {
    mount({}, { chatId: "c_dana" });
    expect(screen.getByText("Slack, Starboard Games")).toBeTruthy();
    expect(block("c_dana_m4").textContent).toContain("review?\nJust the last");
    const link = within(block("c_dana_m5")).getByRole("link");
    expect(link.getAttribute("href")).toBe("https://dash.starboard.games/crashes?builds=3");
  });

  it("quotes what a thread reply answers", () => {
    mount({}, { chatId: "c_design" });
    // m2 answers the message right above it, so it quotes nothing; m6 answers one further up.
    expect(block("c_design_m2").textContent).not.toContain("Love the rarity sort");
    expect(block("c_design_m6").textContent).toMatch(/^Mia Chen: It's 400ms right now/);
  });
});

describe("the sync line", () => {
  const lines = () => document.querySelectorAll("[data-sync-line]");

  it("names each stale source once under the search when the list is beside the conversation", () => {
    mount({ stale: true }, { chatId: "c_playtest" });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]!.textContent).toMatch(/^Discord last synced .+, iMessage .+$/);
  });

  it("under 640px, says the open conversation's own source in its toolbar, the list hidden", () => {
    mount({ stale: true }, { chatId: "c_playtest" }, true);
    expect(screen.queryByRole("listbox", { name: "Conversations" })).toBeNull();
    expect(lines()).toHaveLength(1);
    // The source is named on the line above it: this one says only when.
    expect(lines()[0]!.textContent).toMatch(/^Last synced /);
    expect(screen.getByRole("button", { name: "Back to Messages" })).toBeTruthy();
  });

  it("under 640px with nothing open, says it under the list's search", () => {
    mount({ stale: true }, {}, true);
    expect(lines()).toHaveLength(1);
    fireEvent.click(row("#playtest"));
    expect(lines()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to Messages" }));
    expect(screen.getByRole("listbox", { name: "Conversations" })).toBeTruthy();
  });

  it("says nothing while every source is fresh", () => {
    mount({}, { chatId: "c_playtest" });
    expect(lines()).toHaveLength(0);
  });
});
