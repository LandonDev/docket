// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectModalShape } from "../../chrome/modalShape.testkit";

const state = vi.hoisted(() => ({
  failed: false,
  retry: vi.fn(),
  ladder: ["low", "medium", "high"] as string[],
  overridden: false,
  home: undefined as { name: string; online: boolean } | undefined,
  workspaces: [] as { id: string; name: string; environmentId: string }[],
  overriding: new Set<string>(),
  save: vi.fn(async (..._args: unknown[]) => {}),
  hosts: 1,
  startOn: undefined as "box" | "mac" | undefined,
  permission: "edits" as "safe" | "edits" | "auto",
  confirm: vi.fn(async (_request: unknown) => true),
  may: true,
  load: vi.fn(async (..._args: unknown[]) => {}),
  globalPermission: "edits" as "safe" | "edits" | "auto",
  unheard: [] as string[],
  waiting: [] as string[],
  inheritedOut: false,
  inheritedFails: false,
  keeper: false,
  absent: false,
  links: null as { id: string; name: string }[] | null,
  inheritedReads: 0,
  plansFailed: false,
  plansRetry: vi.fn(),
}));
vi.mock("../../lib/settings/computerName", async (original) => {
  const real = await original<typeof import("../../lib/settings/computerName")>();
  const own = { name: "MacBook Pro", own: true };
  return {
    ...real,
    useComputerName: () => own,
    useComputerNames: () => (id: string) => (id === "local" ? own : { name: "The box", own: false }),
    useReadFailWords: () => (error: string) => real.readFailWords(error, own),
  };
});
vi.mock("../../lib/linkMay", async (original) => ({ ...(await original<typeof import("../../lib/linkMay")>()), useLinkMay: () => state.may }));
vi.mock("../../lib/tcserver/plans", () => ({
  usePlanSettingsError: () => (state.plansFailed ? { error: "The computer did not answer", retry: state.plansRetry } : null),
}));

vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));
vi.mock("../../chrome/PlanSettingsFields", () => ({ PlanSettingsEditor: () => <section aria-label="Builds from plans" /> }));
vi.mock("../../chrome/ConfirmDialog", async (original) => ({
  ...(await original<typeof import("../../chrome/ConfirmDialog")>()),
  confirmAction: (request: unknown) => state.confirm(request),
}));
const link = vi.hoisted(() => ({ environmentId: "local", connected: true, onOpen: () => () => {} }));
vi.mock("../../lib/connection", () => ({ registry: {
    primary: () => link,
    primaryEnvironmentId: "local",
    linkOf: (id: string) => ({ ...link, environmentId: id }),
    environments: () => state.links ?? (state.keeper ? [{ id: "env_box", name: "The box" }] : []),
  },
}));
// Use New threads' own fresh read of the set a place would follow.
vi.mock("../../lib/connection/openRead", async (original) => ({
  ...(await original<typeof import("../../lib/connection/openRead")>()),
  withDeadline: <T,>(p: Promise<T>) => p,
  readWhenOpen: (asked: { environmentId: string }) => {
    state.inheritedReads += 1;
    if (state.inheritedOut) return new Promise(() => {});
    if (state.inheritedFails) return Promise.reject(new Error("The computer did not answer"));
    // With a keeper, this Mac answers its own copy and names the box; the box answers the set it keeps.
    if (state.keeper && asked.environmentId === "env_box") return Promise.resolve({ defaults: { provider: "claude", model: "", reasoning: "medium", permission: "auto" }, overridden: true });
    const home = state.keeper ? { home: { name: "The box", online: true } } : {};
    return Promise.resolve({ defaults: { provider: "claude", model: "", reasoning: "medium", permission: state.globalPermission }, overridden: true, ...home });
  },
}));
vi.mock("../../lib/connection/status", () => ({
  useEnvironments: () => Array.from({ length: state.hosts }, (_, i) => ({ id: i ? `env_${i}` : "local", name: i ? "box" : "This Mac" })),
}));
vi.mock("../../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("../../lib/tcserver/defaults", async (original) => ({
  ...(await original<typeof import("../../lib/tcserver/defaults")>()),
  modelForDefaults: () => ({ id: "m", name: "Opus 5.5" }),
  effortLadder: () => state.ladder,
  normalizeDefaults: (d: unknown) => d,
  providerOptions: () => [
    { value: "claude", label: "Claude Code" },
    { value: "codex", label: "Codex" },
  ],
  modelOptions: () => [{ value: "opus", label: "Opus" }],
  storedModelId: (d: { model: string }) => d.model,
}));
const defaultsOf = () => ({ provider: "claude", model: "", reasoning: "medium", permission: state.permission, ...(state.startOn ? { startOn: state.startOn } : {}) });
vi.mock("../../lib/tcserver/workspaces", () => ({
  scopeKey: (env: string, id: string) => `${env}:${id}`,
  useThreadDefaults: (_env: string, id: string | null) =>
    state.failed || (state.absent && id !== null) ? undefined : { defaults: defaultsOf(), overridden: id === null ? state.overridden : state.overriding.has(id), home: state.home },
  useThreadDefaultsError: () => (state.failed ? { error: "The computer did not answer", retry: state.retry } : null),
  useWorkspaceCatalog: () => ({
    workspaces: state.workspaces,
    defaults: new Map(state.workspaces.filter((w) => !state.unheard.includes(w.id) && !state.waiting.includes(w.id)).map((w) => [`local:${w.id}`, { overridden: state.overriding.has(w.id) }] as const)),
    defaultsErrors: new Map(state.unheard.map((id) => [`local:${id}`, "The computer did not answer"] as const)),
  }),
  workspaceStore: {
    saveDefaults: (...args: unknown[]) => state.save(...args),
    loadDefaults: (...args: unknown[]) => state.load(...args),
    defaultsAt: (_env: string, id: string | null) => ({
      defaults: id === null ? { ...defaultsOf(), permission: state.globalPermission } : { ...defaultsOf(), permission: "edits" },
      overridden: id === null ? state.overridden : state.overriding.has(id),
    }),
  },
}));

const { ThreadDefaultsPage } = await import("./ThreadDefaults");
const { ThreadDefaultsDialog, ThreadDefaultsEditor } = await import("../../chrome/ThreadDefaultsDialog");
const { usePageHome, resetPageHomesForTests } = await import("../../lib/settings/pageHome");
const { StartSetRow } = await import("./parts/StartSetRow");

const flush = () => act(async () => {});
async function pick(field: string, option: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("combobox", { name: field }));
  });
  const item = await screen.findByRole("option", { name: option });
  await act(async () => {
    fireEvent.pointerDown(item, { pointerType: "mouse" });
    fireEvent.click(item);
  });
}
const ALPHA = { id: "w1", name: "Alpha", environmentId: "local" } as never;

beforeEach(() => {
  state.failed = false;
  state.retry.mockClear();
  state.ladder = ["low", "medium", "high"];
  state.overridden = false;
  state.home = undefined;
  state.workspaces = [];
  state.overriding = new Set();
  state.save.mockReset();
  state.save.mockImplementation(async () => {});
  state.hosts = 1;
  state.startOn = undefined;
  state.permission = "edits";
  state.confirm.mockReset();
  state.confirm.mockImplementation(async () => true);
  resetPageHomesForTests();
  state.plansFailed = false;
  state.may = true;
  state.globalPermission = "edits";
  state.unheard = [];
  state.waiting = [];
  state.inheritedOut = false;
  state.inheritedFails = false;
  state.keeper = false;
  state.absent = false;
  state.links = null;
  state.load.mockReset();
  state.load.mockImplementation(async () => {});
  state.inheritedReads = 0;
  state.load.mockClear();
  state.plansRetry.mockClear();
});
afterEach(cleanup);

describe("New threads: Start with", () => {
  it("draws Agent app, Model, Effort and Access under one heading, Access with its level's line", () => {
    render(<ThreadDefaultsPage />);
    expect(screen.getByRole("heading", { name: "Start with" })).toBeTruthy();
    for (const name of ["Agent app", "Model", "Effort", "Access"]) expect(screen.getByRole("combobox", { name })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Default");
    expect(screen.getByText("Asks before anything but edits")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Builds from plans" })).toBeTruthy();
  });

  it("drops Effort for a model without a ladder", () => {
    state.ladder = [];
    render(<ThreadDefaultsPage />);
    expect(screen.queryByRole("combobox", { name: "Effort" })).toBeNull();
  });

  it("saves a pick at once, with the row's Saved mark", async () => {
    render(<ThreadDefaultsPage />);
    await pick("Agent app", "Codex");
    expect(state.save).toHaveBeenCalledWith("local", null, expect.objectContaining({ provider: "codex", model: "" }));
    const row = document.querySelector("[data-setting='defaults.app']") as HTMLElement;
    expect(row.textContent).toContain("Saved");
  });

  it("puts a refused pick back and says why under its row", async () => {
    state.save.mockImplementation(async () => {
      throw new Error("refused: thread defaults live on box; it is offline");
    });
    render(<ThreadDefaultsPage />);
    await pick("Effort", "High");
    expect(screen.getByRole("combobox", { name: "Effort" }).textContent).toContain("Medium");
    const row = document.querySelector("[data-setting='defaults.effort']") as HTMLElement;
    expect(row.textContent).toContain("Thread defaults live on box; it is offline");
  });

  it("asks before Full access becomes the default, and keeps the old level on Cancel", async () => {
    state.confirm.mockImplementation(async () => false);
    render(<ThreadDefaultsPage />);
    await pick("Access", "Full access");
    expect(state.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Start new threads with full access", action: "Use full access" }));
    expect(state.save).not.toHaveBeenCalled();
    state.confirm.mockImplementation(async () => true);
    await pick("Access", "Full access");
    expect(state.save).toHaveBeenCalledWith("local", null, expect.objectContaining({ permission: "auto" }));
  });

  it("does not ask for a lower level", async () => {
    render(<ThreadDefaultsPage />);
    await pick("Access", "Supervised");
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.save).toHaveBeenCalledWith("local", null, expect.objectContaining({ permission: "safe" }));
  });

  it("holds every control while the box that keeps the set is offline", () => {
    state.home = { name: "The box", online: false };
    render(<ThreadDefaultsPage />);
    for (const name of ["Agent app", "Model", "Access"]) expect((screen.getByRole("combobox", { name }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("tells the page's line where the set is kept, once the computer has said", async () => {
    let seen: unknown = "unread";
    function Probe() {
      seen = usePageHome("defaults");
      return null;
    }
    state.home = { name: "The box", online: true };
    render(
      <>
        <ThreadDefaultsPage />
        <Probe />
      </>,
    );
    await flush();
    expect(seen).toEqual({ name: "The box", online: true });
  });

  it("asks Linked projects start on only with a second computer, the box first", async () => {
    const { unmount } = render(<ThreadDefaultsPage />);
    expect(screen.queryByRole("combobox", { name: "Linked projects start on" })).toBeNull();
    unmount();
    state.hosts = 2;
    render(<ThreadDefaultsPage />);
    expect(screen.getByRole("combobox", { name: "Linked projects start on" }).textContent).toContain("The box");
    await pick("Linked projects start on", "The Mac");
    expect(state.save).toHaveBeenCalledWith("local", null, expect.objectContaining({ startOn: "mac" }));
  });

  it("offers Docket's defaults only while a set is stored, last in Start with, and asks first", async () => {
    const { unmount } = render(<ThreadDefaultsPage />);
    expect(document.querySelector("[data-setting='defaults.reset']")).toBeNull();
    unmount();
    state.overridden = true;
    render(<ThreadDefaultsPage />);
    const section = screen.getByRole("region", { name: "Start with" });
    const rows = section.querySelectorAll("[data-slot=page-row]");
    expect(rows[rows.length - 1]!.getAttribute("data-setting")).toBe("defaults.reset");
    // No act on the heading line.
    expect(section.querySelector("h2")!.parentElement!.querySelector("button")).toBeNull();
    await act(async () => {
      fireEvent.click(within(rows[rows.length - 1] as HTMLElement).getByRole("button", { name: "Use…" }));
    });
    expect(state.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Use Docket's defaults" }));
    expect(state.save).toHaveBeenCalledWith("local", null, null);
  });

  it("ends the skeleton when the computer does not answer: the error and Retry, no made-up set", () => {
    state.failed = true;
    render(<ThreadDefaultsPage />);
    expect(screen.queryByRole("combobox", { name: "Agent app" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("This Mac did not answer.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.retry).toHaveBeenCalledOnce();
  });

  it("says a failure once, naming the computer, and draws no line under Start with", () => {
    state.failed = true;
    state.plansFailed = true;
    render(<ThreadDefaultsPage />);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toBe("This Mac did not answer.");
    expect(screen.queryByText(/without a set of its own/)).toBeNull();
  });

  it("has no settings.json hooks switch any more", () => {
    render(<ThreadDefaultsPage />);
    expect(screen.queryByRole("switch", { name: "settings.json hooks" })).toBeNull();
  });
});

describe("Different in N places", () => {
  it("names the places with their own set and lists them in a dialog, each with Use New threads", async () => {
    state.workspaces = [
      { id: "w1", name: "Purdue Esports", environmentId: "local" },
      { id: "w2", name: "CosmicPrisons", environmentId: "local" },
      { id: "w3", name: "temp-code", environmentId: "local" },
    ];
    state.overriding = new Set(["w1", "w2"]);
    render(<ThreadDefaultsPage />);
    const row = document.querySelector("[data-setting='defaults.different']") as HTMLElement;
    expect(row.textContent).toContain("Different in 2 places");
    expect(row.textContent).toContain("CosmicPrisons, Purdue Esports");
    await act(async () => {
      fireEvent.click(within(row).getByRole("button", { name: "Different in 2 places" }));
    });
    const dialog = await screen.findByRole("dialog");
    expectModalShape(dialog, { cancel: false });
    expect(within(dialog).getAllByRole("button", { name: "Use New threads" })).toHaveLength(2);
    await act(async () => {
      fireEvent.click(within(dialog).getAllByRole("button", { name: "Use New threads" })[0]);
    });
    expect(state.save).toHaveBeenCalledWith("local", "w2", null);
  });

  it("stays open while a place it cleared is read again, the row holding no summary", async () => {
    state.workspaces = [{ id: "w1", name: "Purdue Esports", environmentId: "local" }];
    state.overriding = new Set(["w1"]);
    state.save.mockImplementation(async () => {
      state.waiting = ["w1"];
      state.absent = true;
    });
    const view = render(<ThreadDefaultsPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Different in 1 place" }));
    });
    const dialog = await screen.findByRole("dialog");
    await act(async () => {});
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use New threads" }));
    });
    view.rerender(<ThreadDefaultsPage />);
    const open = screen.getByRole("dialog");
    expect(open.textContent).toContain("Purdue Esports");
    expect(open.textContent).not.toContain("Claude");
  });

  it("holds its shape while a place's set is still out, and gives no count", () => {
    state.workspaces = [
      { id: "w1", name: "Purdue Esports", environmentId: "local" },
      { id: "w2", name: "temp-code", environmentId: "local" },
    ];
    state.overriding = new Set(["w1"]);
    state.waiting = ["w2"];
    render(<ThreadDefaultsPage />);
    expect(document.querySelector("[data-setting='defaults.different']")).toBeNull();
    expect(screen.getByRole("region", { name: "Start with" }).querySelectorAll("[data-slot=page-row-skeleton]")).toHaveLength(1);
    // A place nobody has read (one a workspace push listed) has its set asked for, so the row never waits for ever.
    expect(state.load).toHaveBeenCalledWith("local", "w2");
  });

  it("says a floor and the places it has not heard from when a computer did not answer", () => {
    state.workspaces = [
      { id: "w1", name: "Purdue Esports", environmentId: "local" },
      { id: "w2", name: "temp-code", environmentId: "local" },
    ];
    state.overriding = new Set(["w1"]);
    state.unheard = ["w2"];
    render(<ThreadDefaultsPage />);
    const row = document.querySelector("[data-setting='defaults.different']") as HTMLElement;
    expect(row.textContent).toContain("Different in at least 1 place");
    expect(row.textContent).toContain("Not heard from temp-code");
    expect(screen.getByRole("alert").textContent).toBe("This Mac did not answer.");
  });

  it("is absent while every place follows New threads", () => {
    state.workspaces = [{ id: "w1", name: "Alpha", environmentId: "local" }];
    render(<ThreadDefaultsPage />);
    expect(document.querySelector("[data-setting='defaults.different']")).toBeNull();
  });
});

describe("A key that may read the set but not change it", () => {
  it("sees each value as words, no reset, and one line saying who can change them", () => {
    state.may = false;
    state.overridden = true;
    render(<ThreadDefaultsPage />);
    expect(screen.queryByRole("combobox")).toBeNull();
    const section = screen.getByRole("region", { name: "Start with" });
    expect(section.querySelector("[data-setting='defaults.app'] [data-value-words]")!.textContent).toBe("Claude Code");
    expect(section.querySelector("[data-setting='defaults.access'] [data-value-words]")!.textContent).toBe("Auto-accept edits");
    expect(document.querySelector("[data-setting='defaults.reset']")).toBeNull();
    expect(document.querySelectorAll("[data-managed]")).toHaveLength(1);
    // Who can change it is said first, above the first section, and a value in words is no larger than its title.
    const managed = document.querySelector("[data-managed]")!;
    expect(managed.compareDocumentPosition(document.querySelector("[data-setting]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector("[data-value-words]")!.className).toContain("text-xs");
  });

  it("is told who can change a place's set above its rows", async () => {
    state.may = false;
    render(<ThreadDefaultsDialog workspace={ALPHA} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    const managed = dialog.querySelector("[data-managed]")!;
    expect(managed.compareDocumentPosition(dialog.querySelector("[data-value-words]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("Use New threads", () => {
  it("checks Access with the computer that keeps the set, not this computer's copy", async () => {
    state.overriding = new Set(["w1"]);
    state.keeper = true;
    state.confirm.mockImplementation(async () => false);
    render(<ThreadDefaultsDialog workspace={ALPHA} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    await act(async () => {});
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use New threads" }));
    });
    // This Mac's copy says Auto-accept edits; the box keeps Full access, so it asks.
    expect(state.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Give Alpha Full access" }));
  });

  it("holds no guess once a place is cleared: its rows wait while the store reads it again, the dialog open", async () => {
    state.overriding = new Set(["w1"]);
    // The store drops the place's entry at the clear and reads it again (workspaces.ts `saveDefaults`).
    state.save.mockImplementation(async () => {
      state.absent = true;
    });
    const view = render(<ThreadDefaultsDialog workspace={ALPHA} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    await act(async () => {});
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use New threads" }));
    });
    expect(state.save).toHaveBeenCalledWith("local", "w1", null);
    view.rerender(<ThreadDefaultsDialog workspace={ALPHA} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("dialog").textContent).not.toContain("Same as New threads");
  });

  it("says a failed read after the clear, with Retry, in place of a set guessed from the old copy", async () => {
    state.overriding = new Set(["w1"]);
    state.save.mockImplementation(async () => {
      state.failed = true;
    });
    const view = render(<ThreadDefaultsDialog workspace={ALPHA} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    await act(async () => {});
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use New threads" }));
    });
    view.rerender(<ThreadDefaultsDialog workspace={ALPHA} onClose={vi.fn()} />);
    expect(within(dialog).getByRole("alert").textContent).toBe("This Mac did not answer.");
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    });
    expect(state.retry).toHaveBeenCalledOnce();
  });

  it("keeps a job's page row saying the failed read after the dialog closes, and the dialog open while it reads", async () => {
    state.overriding = new Set(["w1"]);
    state.save.mockImplementation(async () => {
      state.failed = true;
    });
    const row = () => <StartSetRow id="job.threads" workspace={ALPHA} whose="job" may />;
    const view = render(row());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    });
    const dialog = await screen.findByRole("dialog");
    await act(async () => {});
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use New threads" }));
    });
    view.rerender(row());
    // The open dialog stays, now saying the failure.
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Done" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    // The page's row says the failure with Retry, never "Same as New threads" with a guessed set.
    expect(document.body.textContent).toContain("This Mac did not answer.");
    expect(document.body.textContent).not.toContain("Same as New threads");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it.each([
    ["never linked", []],
    ["renamed here", [{ id: "env_box", name: "Linux box" }]],
    ["two of one name", [{ id: "env_box", name: "The box" }, { id: "env_box2", name: "The box" }]],
  ])("asks first, as if for Full access, when the keeper the store names is %s", async (_case, links) => {
    state.overriding = new Set(["w1"]);
    state.keeper = true;
    state.links = links;
    state.confirm.mockImplementation(async () => false);
    render(<ThreadDefaultsDialog workspace={ALPHA} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    await act(async () => {});
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use New threads" }));
    });
    // This Mac's copy says Auto-accept edits, but the box keeps the set and could not be asked.
    expect(state.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Use New threads for Alpha", body: expect.stringContaining("may start with Full access") }));
    expect(state.save).not.toHaveBeenCalled();
  });

  it("is offered only to a key that may write the place's set", async () => {
    state.overriding = new Set(["w1"]);
    state.may = false;
    render(<ThreadDefaultsDialog workspace={ALPHA} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Use New threads" })).toBeNull();
  });

  it("asks first when it would give the place Full access, naming what it has today", async () => {
    state.overriding = new Set(["w1"]);
    state.globalPermission = "auto";
    // The set the place would follow, as its computer answered it.
    state.permission = "auto";
    state.confirm.mockImplementation(async () => false);
    render(<ThreadDefaultsDialog workspace={ALPHA} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    await act(async () => {});
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use New threads" }));
    });
    expect(state.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Give Alpha Full access", body: expect.stringContaining("Today they start with Auto-accept edits") }));
    expect(state.save).not.toHaveBeenCalled();
  });

  it("acts at once when the place keeps its Access or narrows it", async () => {
    state.overriding = new Set(["w1"]);
    render(<ThreadDefaultsDialog workspace={ALPHA} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    await act(async () => {});
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use New threads" }));
    });
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.save).toHaveBeenCalledWith("local", "w1", null);
  });
});

describe("Use New threads, before it knows what it would bring", () => {
  it("shows its computer's failure inside the dialog, with Retry, even with a set cached", async () => {
    state.overriding = new Set(["w1"]);
    state.inheritedFails = true;
    render(<ThreadDefaultsDialog workspace={ALPHA} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    await act(async () => {});
    expect(within(dialog).queryByRole("button", { name: "Use New threads" })).toBeNull();
    expect(within(dialog).getByRole("alert").textContent).toBe("This Mac did not answer.");
    state.inheritedFails = false;
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    });
    await act(async () => {});
    expect(within(dialog).getByRole("button", { name: "Use New threads" })).toBeTruthy();
  });

  it("checks Full access again on the answer at the press", async () => {
    state.overriding = new Set(["w1"]);
    render(<ThreadDefaultsDialog workspace={ALPHA} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    await act(async () => {});
    // New threads turned Full access after the dialog read it.
    state.globalPermission = "auto";
    state.confirm.mockImplementation(async () => false);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use New threads" }));
    });
    expect(state.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Give Alpha Full access" }));
    expect(state.save).not.toHaveBeenCalled();
  });

  it("is a bone while the set the place would follow is out", async () => {
    state.overriding = new Set(["w1"]);
    state.inheritedOut = true;
    render(<ThreadDefaultsDialog workspace={ALPHA} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Use New threads" })).toBeNull();
    expect(dialog.querySelector("[data-skeleton-control]")).toBeTruthy();
  });
});

describe("A place's own set: the dialog", () => {
  it("is New threads for the place: its rows save as they change, Done closes", async () => {
    const onClose = vi.fn();
    render(<ThreadDefaultsDialog workspace={ALPHA} onClose={onClose} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "New threads" })).toBeTruthy();
    expect(dialog.textContent).toContain("Alpha");
    expect(dialog.textContent).toContain("Same as New threads");
    expect(within(dialog).queryByRole("combobox", { name: "Linked projects start on" })).toBeNull();
    expectModalShape(dialog, { cancel: false });
    await pick("Model", "Opus");
    expect(state.save).toHaveBeenCalledWith("local", "w1", expect.objectContaining({ model: "opus" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("puts Use New threads at the footer's start while the place keeps a set, and it clears the set", async () => {
    state.overriding = new Set(["w1"]);
    render(<ThreadDefaultsDialog workspace={ALPHA} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    await act(async () => {});
    const start = dialog.querySelector('[data-slot="dialog-footer"] [data-footer-start]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(start).getByRole("button", { name: "Use New threads" }));
    });
    expect(state.save).toHaveBeenCalledWith("local", "w1", null);
  });

  it("says so in the rows' place when the computer never answers, naming it, with its Retry", async () => {
    state.failed = true;
    render(<ThreadDefaultsDialog workspace={ALPHA} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert").textContent).toBe("This Mac did not answer.");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    });
    expect(state.retry).toHaveBeenCalledOnce();
  });

  it("keeps the page editor for a workspace working until its page opens the dialog", () => {
    state.workspaces = [{ id: "w1", name: "Alpha", environmentId: "local" }];
    render(<ThreadDefaultsEditor workspaceId="w1" />);
    expect(screen.getByRole("heading", { name: "New threads" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Agent app" })).toBeTruthy();
  });
});
