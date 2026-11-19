// @vitest-environment jsdom
/** The Docs view: one list from the host, searched as he types, filtered, grouped, laid out, picked and saved. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FindAnswer } from "@shared/contract-work-docs";
import { DEFAULT_SPEC, type FindEntry } from "@shared/work/docFind";

vi.mock("../shell/lifeos", async (original) => ({ ...(await original<object>()), useLifeosQuery: () => ({ status: "loading" }) }));
const calls: { method: string; params: Record<string, unknown> }[] = [];
const answers: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {};
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    linkOf: () => ({
      request: (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return answers[method]?.(params) ?? new Promise(() => {});
      },
    }),
  },
}));
const errors: string[] = [];
vi.mock("../../components/ui/toaster", async (original) => ({ ...(await original<object>()), loadToast: async () => ({ error: (text: string) => void errors.push(text) }) }));

const { Head, View, applyFilterPick, filterRows, resetOpened, viewRows, waitWords } = await import("./DocsView");
const { resetFinders, setSpec } = await import("./finder");
const started: unknown[] = [];
const props = { env: "box", workspace: { id: "ws-docs", environmentId: "box" }, sector: "purdue", lifeos: {}, startThread: (c: unknown) => void started.push(c) } as never;
const settle = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

const NOW = Date.now();
const entry = (o: Partial<FindEntry> & Pick<FindEntry, "key" | "title">): FindEntry => ({
  kind: "document",
  where: "lifeos",
  source: { at: "lifeos", table: "docs", id: o.key },
  editedAt: NOW,
  createdAt: NOW,
  shared: false,
  guest: false,
  comments: 0,
  waiting: 0,
  held: 0,
  ...o,
});
const ANSWER: FindAnswer = {
  entries: [
    entry({ key: "d1", title: "Kickoff brief", projectId: "p1", comments: 2 }),
    entry({ key: "s1", title: "Event budget", kind: "sheet", source: { at: "lifeos", table: "sheets", id: "s1" }, projectId: "p1", editedAt: NOW - 1000 }),
    entry({ key: "f1", title: "scan.pdf", kind: "pdf", where: "folder", source: { at: "file", host: "box", path: "/w/scan.pdf" }, held: 1 }),
  ],
  projects: [{ id: "p1", name: "Fall Invitational" }],
  hits: [],
  complete: true,
};

beforeEach(() => {
  calls.length = 0;
  errors.length = 0;
  started.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  answers["work.docs.views"] = async () => ({ views: [] });
  resetFinders();
  resetOpened();
});
afterEach(cleanup);

const both = () =>
  render(
    <>
      <Head {...props} />
      <View {...props} />
    </>,
  );

describe("the Docs view", () => {
  it("says when New is refused", async () => {
    answers["work.docs.create"] = async () => {
      throw new Error("LifeOS refused it");
    };
    render(<Head {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await settle();
    expect(errors).toEqual(["The document was not made"]);
  });

  it("offers Retry when the host does not answer", async () => {
    answers["work.docs.find"] = async () => {
      throw new Error("Work is off on this host");
    };
    render(<View {...props} />);
    await settle();
    expect(screen.getByText("Docs did not load")).toBeTruthy();
    answers["work.docs.find"] = async () => ANSWER;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByRole("button", { name: /Kickoff brief/ })).toBeTruthy();
  });

  it("groups by project, loose ones last, and narrows titles at once as he types", async () => {
    answers["work.docs.find"] = async () => ANSWER;
    both();
    await settle();
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Fall Invitational", "No project"]);
    expect(screen.getByRole("button", { name: /Kickoff brief/ }).textContent).toContain("2 to review");
    fireEvent.change(screen.getByRole("textbox", { name: "Search documents" }), { target: { value: "budget" } });
    expect(screen.queryByRole("button", { name: /Kickoff brief/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Event budget/ })).toBeTruthy();
  });

  it("asks the host what is written inside once typing rests, and shows the words around the match", async () => {
    answers["work.docs.find"] = async (p) => (p.query === "venue" ? { ...ANSWER, hits: [{ key: "d1", snippet: "…book the venue by Friday…" }] } : ANSWER);
    both();
    await settle();
    fireEvent.change(screen.getByRole("textbox", { name: "Search documents" }), { target: { value: "venue" } });
    expect(screen.getByText("Searching…")).toBeTruthy();
    await settle(200);
    expect(calls.filter((c) => c.method === "work.docs.find").map((c) => c.params.query)).toEqual([undefined, "venue"]);
    expect(screen.getByText("…book the venue by Friday…")).toBeTruthy();
  });

  it("says a narrowed list is empty and clears it", async () => {
    answers["work.docs.find"] = async () => ANSWER;
    both();
    await settle();
    setSpec("ws-docs", { filter: { kinds: ["slides"] } });
    await settle();
    expect(screen.getByText("No matches")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: /Kickoff brief/ })).toBeTruthy();
  });

  it("picks rows by keyboard and asks about them in one thread", async () => {
    answers["work.docs.find"] = async () => ANSWER;
    both();
    await settle();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search documents" }), { key: "ArrowDown" });
    const first = screen.getByRole("button", { name: /Kickoff brief/ });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: " " });
    fireEvent.keyDown(first, { key: "ArrowDown", shiftKey: true });
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(started).toEqual([
      [
        { kind: "selection", label: "Kickoff brief", ref: { at: "lifeos", table: "docs", id: "d1" } },
        { kind: "selection", label: "Event budget", ref: { at: "lifeos", table: "sheets", id: "s1" } },
      ],
    ]);
    fireEvent.keyDown(first, { key: "Escape" });
    expect(screen.queryByText("2 selected")).toBeNull();
  });

  it("drops the searching line when the query is cleared before the host answers", async () => {
    answers["work.docs.find"] = async (p) => (p.query ? new Promise(() => {}) : ANSWER);
    both();
    await settle();
    setSpec("ws-docs", { filter: { kinds: ["slides"] } });
    const search = screen.getByRole("textbox", { name: "Search documents" });
    fireEvent.change(search, { target: { value: "venue" } });
    expect(screen.getByText("Searching…")).toBeTruthy();
    fireEvent.keyDown(search, { key: "Escape" });
    await settle();
    expect(screen.queryByText("Searching…")).toBeNull();
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("never lets an older, slower reply put back an older list", async () => {
    let first: (a: FindAnswer) => void = () => {};
    let n = 0;
    answers["work.docs.find"] = () => (n++ === 0 ? new Promise<FindAnswer>((r) => (first = r)) : Promise.resolve({ ...ANSWER, entries: [ANSWER.entries[0]!] }));
    both();
    await settle();
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    first(ANSWER);
    await settle();
    expect(screen.queryByRole("button", { name: /Event budget/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Kickoff brief/ })).toBeTruthy();
  });

  it("leaves a row the filters hide out of the pick", async () => {
    answers["work.docs.find"] = async () => ANSWER;
    both();
    await settle();
    fireEvent.keyDown(screen.getByRole("button", { name: /Kickoff brief/ }), { key: " " });
    fireEvent.keyDown(screen.getByRole("button", { name: /Event budget/ }), { key: " " });
    expect(screen.getByText("2 selected")).toBeTruthy();
    act(() => setSpec("ws-docs", { filter: { kinds: ["sheet"] } }));
    await settle();
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("opens a document here, and starts a thread about anything else", async () => {
    answers["work.docs.find"] = async () => ANSWER;
    both();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /scan\.pdf/ }));
    expect(started).toEqual([{ kind: "selection", label: "scan.pdf", ref: { at: "file", host: "box", path: "/w/scan.pdf" } }]);
    fireEvent.keyDown(screen.getByRole("button", { name: /Kickoff brief/ }), { key: "Enter" });
    expect(screen.getByRole("button", { name: "Docs" })).toBeTruthy();
    expect(calls.some((c) => c.method === "work.docs.open")).toBe(true);
  });

  it("lays out a table without the column the grouping names", async () => {
    answers["work.docs.find"] = async () => ANSWER;
    both();
    await settle();
    setSpec("ws-docs", { layout: "table" });
    await settle();
    const heads = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toContain("Kind");
    expect(heads).not.toContain("Project");
    setSpec("ws-docs", { group: "kind", sort: "created" });
    await settle();
    const now = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(now).toContain("Project");
    expect(now).not.toContain("Kind");
    expect(now).toContain("Created");
  });
});

describe("the menus' rows", () => {
  it("offer only the kinds and places the list holds, and set and clear filters", () => {
    const rows = filterRows({}, ANSWER.entries, ANSWER.projects);
    const sub = (id: string) => rows.find((r) => r.kind === "sub" && r.id === id) as { items: { id: string; label: string }[] } | undefined;
    expect(sub("kind")!.items.map((i) => i.label)).toEqual(["Document", "Sheet", "PDF"]);
    expect(sub("where")!.items.map((i) => i.label)).toEqual(["LifeOS", "Folder"]);
    expect(sub("project")!.items.map((i) => i.label)).toEqual(["Fall Invitational", "No project"]);
    let f = applyFilterPick({}, "kind:pdf");
    f = applyFilterPick(f, "within:week");
    f = applyFilterPick(f, "flag:held");
    expect(f).toEqual({ kinds: ["pdf"], within: "week", held: true });
    expect(applyFilterPick(applyFilterPick(f, "kind:pdf"), "within:")).toEqual({ kinds: [], held: true });
    expect(filterRows(f, ANSWER.entries, []).some((r) => r.kind === "item" && r.id === "clear")).toBe(true);
    expect(applyFilterPick(f, "clear")).toEqual({});
  });

  it("offer saving a changed spec, and the saved view's own verbs", () => {
    const ids = (rows: ReturnType<typeof viewRows>) => rows.flatMap((r) => (r.kind === "item" ? [r.id] : []));
    expect(ids(viewRows(DEFAULT_SPEC, [], null))).toContain("saveAs");
    const view = { id: "v1", name: "Budgets", spec: { ...DEFAULT_SPEC, query: "budget" } };
    expect(ids(viewRows(view.spec, [view], "v1"))).toEqual(["layout:list", "layout:table", "view:", "view:v1", "rename", "drop"]);
    expect(ids(viewRows({ ...view.spec, sort: "name" }, [view], "v1"))).toContain("save");
  });

  it("say what waits on an entry as one sentence", () => {
    expect(waitWords(entry({ key: "a", title: "A", comments: 1, waiting: 2, held: 1 }))).toBe("3 to review, held");
    expect(waitWords(entry({ key: "b", title: "B" }))).toBe("");
  });
});

describe("saved views", () => {
  it("are named in a dialog and saved with the workspace", async () => {
    answers["work.docs.find"] = async () => ANSWER;
    answers["work.docs.saveView"] = async (p) => ({ id: "v1", name: p.name, spec: p.spec });
    render(<Head {...props} />);
    await settle();
    setSpec("ws-docs", { query: "budget" });
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    await settle(50);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Save as view…" }));
    await settle(50);
    fireEvent.change(await screen.findByRole("textbox", { name: "Name" }), { target: { value: "Budgets" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle(50);
    expect(calls.find((c) => c.method === "work.docs.saveView")?.params).toMatchObject({ workspaceId: "ws-docs", name: "Budgets", spec: { query: "budget" } });
    expect(screen.getByRole("button", { name: "Budgets" })).toBeTruthy();
  });
});
