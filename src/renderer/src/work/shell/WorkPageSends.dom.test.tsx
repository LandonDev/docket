// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const box = vi.hoisted(() => ({
  grants: [] as Record<string, unknown>[],
  errors: [] as { environmentId: string; error: string }[],
  loaded: true,
  removed: [] as string[],
  calls: [] as { env: string; method: string; params: unknown }[],
  refuse: false,
  cannot: new Set<string>(),
  on: new Set<string>(["env_box", "local"]),
  /** computers whose tool rules read fails, or never answers */
  rulesFail: new Set<string>(),
  rulesOut: new Set<string>(),
  /** A rule's save held open until the test lets it go. */
  gate: null as null | Promise<void>,
  /** The box's linear add-on lists ten tools (past the find field's eight). */
  many: false,
}));

vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));
vi.mock("../outbox/store", () => ({
  useOutboxPage: () => {},
  useOutbox: () => ({ grants: box.grants, loaded: box.loaded, complete: box.loaded && !box.errors.length, errors: box.errors }),
  loadHost: async () => {},
  removeGrant: async (grant: { id: string; environmentId: string }) => {
    box.removed.push(`${grant.environmentId}:${grant.id}`);
    await box.gate;
  },
}));
vi.mock("../../lib/tcserver/workspaces", () => ({
  useWorkspaces: () => [
    { id: "w1", name: "Purdue Esports", kind: "work", sector: "purdue", environmentId: "env_box" },
    { id: "w2", name: "Cosmic", kind: "work", sector: "cosmic", environmentId: "env_box" },
  ],
}));
vi.mock("../../lib/linkMay", async (original) => ({ ...(await original<object>()), useLinksMay: () => (env: string) => !box.cannot.has(env) }));
vi.mock("../../lib/settings/computerName", async (original) => {
  const real = await original<typeof import("../../lib/settings/computerName")>();
  const nameOf = (id: string) => ({ name: id === "env_box" ? "The box" : "MacBook Pro", own: id === "local" });
  return {
    ...real,
    useComputerNames: () => nameOf,
    useComputerName: nameOf,
    computerInLine: (c: { name: string; own: boolean }) => (c.own ? "this Mac" : c.name === "The box" ? "the box" : c.name),
    useReadFailWords: (id: string) => (error: string) => real.readFailWords(error, nameOf(id)),
  };
});
vi.mock("../../lib/connection", async (original) => ({ ...(await original<object>()), useEnvironments: () => [{ id: "env_box", name: "The box" }, { id: "local", name: "MacBook Pro" }] }));
vi.mock("../../lib/workSwitch", () => ({ useWorkHosts: () => box.on }));
const opened = vi.hoisted(() => ({ outbox: 0 }));
vi.mock("../../stores/shell", () => ({ shell: { openOutbox: () => void opened.outbox++ } }));
const card = (addonId: string, name: string, tools: { tool: string; words: string; rule: string | null }[], lifeos = false) => ({
  addonId,
  name,
  workspaceId: null,
  forWork: true,
  lifeos,
  unreviewed: 0,
  tools: tools.map((t) => ({ ...t, description: "", hints: {}, suggested: "held", changed: false })),
});
const linearTools = (): { tool: string; words: string; rule: string | null }[] => [
  { tool: "create_issue", words: "Create issue", rule: "held" },
  ...(box.many ? Array.from({ length: 9 }, (_, i) => ({ tool: `t${i}`, words: `Other tool ${i}`, rule: "runs" })) : []),
];
vi.mock("../../surfaces/settings/parts/hostRpc", () => ({
  hostRequest: async (env: string, method: string, params: { addonId: string; rules: Record<string, string> }) => {
    box.calls.push({ env, method, params });
    if (method === "work.outbox.rules" && box.rulesOut.has(env)) return new Promise(() => {});
    if (method === "work.outbox.rules" && box.rulesFail.has(env)) throw new Error(NO_ANSWER);
    if (method === "work.outbox.rules")
      return { addons: env === "env_box" ? [card("a1", "linear", linearTools()), card("lo", "LifeOS", [{ tool: "x", words: "X", rule: null }], true)] : [] };
    await box.gate;
    if (box.refuse) throw new Error("forbidden: work.outbox.setRules needs admin");
    const [tool, rule] = Object.entries(params.rules)[0]!;
    return card("a1", "linear", linearTools().map((t) => (t.tool === tool ? { ...t, rule } : t)));
  },
}));

const { NO_ANSWER } = await import("../../lib/connection/openRead");
const { GrantsRow, GRANTS_MADE, ToolsRow, grantsWords } = await import("./WorkPageSends");

const grant = (id: string, environmentId: string, workspaceId: string, label: string) => ({ id, environmentId, workspaceId, label, kind: "mail.send", createdAt: Date.now(), matcher: null, madeFrom: { at: "x", id: "y" }, routineId: null, removedAt: null });
const settle = () => act(async () => void (await new Promise((done) => setTimeout(done, 0))));

afterEach(() => {
  cleanup();
  box.grants = [];
  box.errors = [];
  box.loaded = true;
  box.removed = [];
  box.calls = [];
  box.refuse = false;
  box.cannot = new Set();
  box.rulesFail = new Set();
  box.rulesOut = new Set();
  box.gate = null;
  box.many = false;
});

describe("Things threads may send on their own", () => {
  it("counts the grants by job, and says None with nothing granted", () => {
    const name = (id: string) => (id === "w1" ? "Purdue Esports" : "Cosmic");
    expect(grantsWords([], name)).toBe("None");
    expect(grantsWords([grant("g1", "env_box", "w1", "a")], name)).toBe("1 for Purdue Esports");
    expect(grantsWords([grant("g1", "env_box", "w1", "a"), grant("g2", "env_box", "w2", "b"), grant("g3", "env_box", "w2", "c")], name)).toBe("3 across 2 jobs");
  });

  it("opens one sheet of the grants that says how one is made, and Remove takes that grant from its own computer alone", async () => {
    box.grants = [grant("g1", "env_box", "w1", "Mail to Sam Ortiz"), grant("g2", "local", "w2", "Posts to #events")];
    render(<GrantsRow id="mail.grants" />);
    expect(document.querySelector('[data-setting="mail.grants"]')!.textContent).toContain("2 across 2 jobs");
    fireEvent.click(screen.getByRole("button", { name: "Things threads may send on their own" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(GRANTS_MADE)).toBeTruthy();
    const row = sheet.querySelector<HTMLElement>('[data-grant="g2"]')!;
    expect(row.textContent).toContain("Cosmic");
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Remove" })));
    expect(box.removed).toEqual(["local:g2"]);
  });

  it("holds every Remove while one removal is out: a second press sends nothing until the first answers", async () => {
    box.grants = [grant("g1", "env_box", "w1", "Mail to Sam Ortiz"), grant("g2", "local", "w2", "Posts to #events")];
    render(<GrantsRow id="mail.grants" />);
    fireEvent.click(screen.getByRole("button", { name: "Things threads may send on their own" }));
    const sheet = await screen.findByRole("dialog");
    let let_go!: () => void;
    box.gate = new Promise<void>((done) => (let_go = done));
    const remove = (id: string) => within(sheet.querySelector<HTMLElement>(`[data-grant="${id}"]`)!).getByRole("button");
    await act(async () => fireEvent.click(remove("g2")));
    expect((remove("g1") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(remove("g1")));
    expect(box.removed).toEqual(["local:g2"]);
    await act(async () => {
      let_go();
      await box.gate;
    });
    expect((remove("g1") as HTMLButtonElement).disabled).toBe(false);
  });

  it("says how a grant is made in the empty state, and offers no Remove to a key that may not", async () => {
    render(<GrantsRow id="work.grants" />);
    fireEvent.click(screen.getByRole("button", { name: "Things threads may send on their own" }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet.textContent).toContain("None yet");
    // Where a grant is made is said once, beside Open the Outbox.
    expect(sheet.textContent!.split(GRANTS_MADE)).toHaveLength(2);
    cleanup();
    box.grants = [grant("g1", "env_box", "w1", "Mail to Sam Ortiz")];
    box.cannot = new Set(["env_box"]);
    render(<GrantsRow id="work.grants" />);
    fireEvent.click(screen.getByRole("button", { name: "Things threads may send on their own" }));
    expect(within(await screen.findByRole("dialog")).queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("puts a find field over a list past eight", async () => {
    box.grants = Array.from({ length: 9 }, (_, i) => grant(`g${i}`, "env_box", "w1", i === 4 ? "Mail to Sam Ortiz" : `Post ${i}`));
    render(<GrantsRow id="work.grants" />);
    fireEvent.click(screen.getByRole("button", { name: "Things threads may send on their own" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByRole("searchbox", { name: "Find a grant" }), { target: { value: "sam" } });
    expect([...sheet.querySelectorAll("[data-grant]")].map((r) => r.getAttribute("data-grant"))).toEqual(["g4"]);
  });
});

describe("the grants' read", () => {
  it("never says None for a computer that did not answer: it names that computer with Retry, and holds the row", async () => {
    box.loaded = true;
    box.errors = [{ environmentId: "env_box", error: "The computer did not answer" }, { environmentId: "local", error: "The computer did not answer" }];
    render(<GrantsRow id="work.grants" />);
    // Nothing read: no bare title stands; the failures say why.
    expect(document.querySelector('[data-setting="work.grants"]')).toBeNull();
    expect(document.body.textContent).not.toContain("None");
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual(["The box did not answer.", "this Mac did not answer.".replace(/^t/, "T")]);
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(2);
    // Nothing read: no way into a sheet that could show nothing.
    expect(screen.queryByRole("button", { name: "Things threads may send on their own" })).toBeNull();
  });

  it("holds bones while a computer is out, and says the count once all answered", () => {
    box.loaded = false;
    render(<GrantsRow id="work.grants" />);
    expect(document.querySelector('[data-setting="work.grants"] [data-slot=skeleton]')).toBeTruthy();
  });

  it("opens the Outbox from the sheet, where a grant is made", async () => {
    render(<GrantsRow id="work.grants" />);
    fireEvent.click(screen.getByRole("button", { name: "Things threads may send on their own" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Open the Outbox" }));
    expect(opened.outbox).toBe(1);
  });
});

describe("What each add-on's tools may do", () => {
  it("asks each computer with Work on, leaves LifeOS's row out, and writes a tool's rule to its own computer alone", async () => {
    render(<ToolsRow />);
    fireEvent.click(screen.getByRole("button", { name: "What each add-on's tools may do" }));
    const sheet = await screen.findByRole("dialog");
    await settle();
    expect(box.calls.map((c) => `${c.env} ${c.method}`).sort()).toEqual(["env_box work.outbox.rules", "local work.outbox.rules"]);
    expect(sheet.textContent).not.toContain("LifeOS");
    const row = sheet.querySelector<HTMLElement>('[data-tool="create_issue"]')!;
    await act(async () => fireEvent.click(within(row).getByRole("combobox")));
    const option = await screen.findByRole("option", { name: "Runs" });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option);
    });
    await settle();
    expect(box.calls.slice(2)).toEqual([{ env: "env_box", method: "work.outbox.setRules", params: { addonId: "a1", rules: { create_issue: "runs" } } }]);
    expect(within(row).getByRole("combobox").textContent).toContain("Runs");
  });

  it("puts a refused rule back and says why under the tool", async () => {
    box.refuse = true;
    render(<ToolsRow />);
    fireEvent.click(screen.getByRole("button", { name: "What each add-on's tools may do" }));
    const sheet = await screen.findByRole("dialog");
    await settle();
    const row = sheet.querySelector<HTMLElement>('[data-tool="create_issue"]')!;
    await act(async () => fireEvent.click(within(row).getByRole("combobox")));
    const option = await screen.findByRole("option", { name: "Off" });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse" });
      fireEvent.click(option);
    });
    await settle();
    expect(within(row).getByRole("combobox").textContent).toContain("Waits for you");
    expect(row.querySelector(".text-destructive")).toBeTruthy();
  });

  it("shows a key that may not set them each rule in words and who can", async () => {
    box.cannot = new Set(["env_box"]);
    render(<ToolsRow />);
    fireEvent.click(screen.getByRole("button", { name: "What each add-on's tools may do" }));
    const sheet = await screen.findByRole("dialog");
    await settle();
    expect(within(sheet).queryByRole("combobox")).toBeNull();
    expect(sheet.textContent).toContain("Changed from a computer that manages the box");
    expect(sheet.querySelector('[data-tool="create_issue"]')!.textContent).toContain("Waits for you");
  });

  it("names the computer over each add-on whenever more than one has Work on, though only one has answered", async () => {
    box.rulesOut = new Set(["local"]);
    render(<ToolsRow />);
    fireEvent.click(screen.getByRole("button", { name: "What each add-on's tools may do" }));
    const sheet = await screen.findByRole("dialog");
    await settle();
    expect(sheet.querySelector('[data-addon="a1"]')!.textContent).toContain("linear on the box");
  });

  it("says a failed re-read under the sheet's title with Retry, over the rules held from before", async () => {
    render(<ToolsRow />);
    const opener = screen.getByRole("button", { name: "What each add-on's tools may do" });
    fireEvent.click(opener);
    await screen.findByRole("dialog");
    await settle();
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle();
    box.rulesFail = new Set(["env_box"]);
    fireEvent.click(opener);
    const sheet = await screen.findByRole("dialog");
    await settle();
    expect(within(sheet).getByRole("alert").textContent).toBe("The box did not answer.");
    expect(sheet.querySelector('[data-tool="create_issue"]')).toBeTruthy();
    box.rulesFail = new Set();
    const before = box.calls.length;
    await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Retry" })));
    await settle();
    expect(box.calls.slice(before).map((c) => `${c.env} ${c.method}`)).toEqual(["env_box work.outbox.rules"]);
    expect(within(sheet).queryByRole("alert")).toBeNull();
  });

  it("refuses a second pick of a tool's rule at once while its save is out, and draws it held only once the hold lasts 150 ms", async () => {
    render(<ToolsRow />);
    fireEvent.click(screen.getByRole("button", { name: "What each add-on's tools may do" }));
    const sheet = await screen.findByRole("dialog");
    await settle();
    const row = () => sheet.querySelector<HTMLElement>('[data-tool="create_issue"]')!;
    const pick = async (name: string) => {
      await act(async () => fireEvent.click(within(row()).getByRole("combobox")));
      const option = await screen.findByRole("option", { name });
      await act(async () => {
        fireEvent.pointerDown(option, { pointerType: "mouse" });
        fireEvent.click(option);
      });
    };
    let let_go!: () => void;
    box.gate = new Promise<void>((done) => (let_go = done));
    const before = box.calls.length;
    await pick("Runs");
    // At once: the pick shows, nothing is drawn disabled, and a second pick sends nothing.
    expect(within(row()).getByRole("combobox").textContent).toContain("Runs");
    expect(within(row()).getByRole("combobox").hasAttribute("data-disabled")).toBe(false);
    await pick("Off");
    expect(box.calls.slice(before).filter((c) => c.method === "work.outbox.setRules")).toHaveLength(1);
    expect(within(row()).getByRole("combobox").textContent).toContain("Runs");
    // Once the hold has lasted 150 ms it is drawn held.
    await act(async () => void (await new Promise((done) => setTimeout(done, 170))));
    expect(within(row()).getByRole("combobox").hasAttribute("data-disabled")).toBe(true);
    await act(async () => {
      let_go();
      await box.gate;
    });
    await settle();
    expect(within(row()).getByRole("combobox").textContent).toContain("Runs");
    expect(within(row()).getByRole("combobox").hasAttribute("data-disabled")).toBe(false);
  });

  it("keeps a tool's pending pick and hold when Find a tool filters its row away and back before the save answers", async () => {
    box.many = true;
    render(<ToolsRow />);
    fireEvent.click(screen.getByRole("button", { name: "What each add-on's tools may do" }));
    const sheet = await screen.findByRole("dialog");
    await settle();
    const row = () => sheet.querySelector<HTMLElement>('[data-tool="create_issue"]');
    const pick = async (name: string) => {
      await act(async () => fireEvent.click(within(row()!).getByRole("combobox")));
      const option = await screen.findByRole("option", { name });
      await act(async () => {
        fireEvent.pointerDown(option, { pointerType: "mouse" });
        fireEvent.click(option);
      });
    };
    let let_go!: () => void;
    box.gate = new Promise<void>((done) => (let_go = done));
    const before = box.calls.length;
    await pick("Runs");
    const find = within(sheet).getByRole("searchbox", { name: "Find a tool" });
    fireEvent.change(find, { target: { value: "other" } });
    expect(row()).toBeNull();
    fireEvent.change(find, { target: { value: "" } });
    // Back: the pending pick, and its hold: a second pick sends nothing.
    expect(within(row()!).getByRole("combobox").textContent).toContain("Runs");
    await pick("Off");
    expect(box.calls.slice(before).filter((c) => c.method === "work.outbox.setRules")).toHaveLength(1);
    await act(async () => {
      let_go();
      await box.gate;
    });
    await settle();
    expect(within(row()!).getByRole("combobox").textContent).toContain("Runs");
  });

  it("keeps a tool's pending pick and hold when the sheet closes and opens again before the save answers", async () => {
    render(<ToolsRow />);
    const opener = screen.getByRole("button", { name: "What each add-on's tools may do" });
    fireEvent.click(opener);
    let sheet = await screen.findByRole("dialog");
    await settle();
    const row = () => sheet.querySelector<HTMLElement>('[data-tool="create_issue"]')!;
    const pick = async (name: string) => {
      await act(async () => fireEvent.click(within(row()).getByRole("combobox")));
      const option = await screen.findByRole("option", { name });
      await act(async () => {
        fireEvent.pointerDown(option, { pointerType: "mouse" });
        fireEvent.click(option);
      });
    };
    let let_go!: () => void;
    box.gate = new Promise<void>((done) => (let_go = done));
    const before = box.calls.length;
    await pick("Runs");
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle();
    fireEvent.click(opener);
    sheet = await screen.findByRole("dialog");
    await settle();
    // The re-read answered with the rule the computer held before the save: the pending pick still shows, still held.
    expect(within(row()).getByRole("combobox").textContent).toContain("Runs");
    await pick("Off");
    expect(box.calls.slice(before).filter((c) => c.method === "work.outbox.setRules")).toHaveLength(1);
    await act(async () => {
      let_go();
      await box.gate;
    });
    await settle();
    expect(within(row()).getByRole("combobox").textContent).toContain("Runs");
  });
});
