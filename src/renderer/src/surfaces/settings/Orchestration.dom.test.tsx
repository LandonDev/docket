// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectModalShape } from "../../chrome/modalShape.testkit";
import type { OrchestrationRules, RulesCatalog, RulesScope } from "../../lib/tcserver/rules";

const state = vi.hoisted(() => ({
  scope: undefined as RulesScope | undefined,
  catalog: null as RulesCatalog | null,
  workspaces: [] as { id: string; name: string; environmentId: string }[],
  save: vi.fn(async (..._a: unknown[]): Promise<void> => {}),
  clear: vi.fn(async () => {}),
  load: vi.fn(async () => {}),
  error: null as string | null,
  retry: vi.fn(),
}));

const keyRights = vi.hoisted(() => ({ write: true }));
vi.mock("../../lib/linkMay", async (original) => ({ ...(await original<typeof import("../../lib/linkMay")>()), useLinkMay: () => keyRights.write }));
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
vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));
vi.mock("../../components/choice-combobox", async () => await import("../../components/choice-combobox-body"));
vi.mock("../../lib/connection", () => ({ registry: { primary: () => ({ environmentId: "local" }), primaryEnvironmentId: "local" } }));
vi.mock("../../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("../../lib/connection/status", () => ({ useEnvironmentStatuses: () => new Map() }));
vi.mock("../../lib/tcserver/workspaces", () => ({ useWorkspaces: () => state.workspaces }));
vi.mock("../../lib/tcserver/rules", async (original) => ({
  ...(await original<typeof import("../../lib/tcserver/rules")>()),
  useRulesScope: () => ({ scope: state.scope, catalog: state.catalog, error: state.error, retry: state.retry }),
  rulesStore: {
    save: (...a: unknown[]) => state.save(...a),
    clear: (...a: unknown[]) => state.clear(...(a as [])),
    load: (...a: unknown[]) => state.load(...(a as [])),
  },
}));

const { OrchestrationPage } = await import("./Orchestration");
const shared = await import("@server/shared/rules");
const catalogModule = await import("@server/shared/catalog");
const { OrchestrationRulesEditor } = await import("../../chrome/OrchestrationRules");
const { ConfirmHost } = await import("../../chrome/ConfirmDialog");
const { openOrchestrationSettings, takeRequestedRulesFocus } = await import("../../lib/tcserver/rules");
const { OPEN_SETTINGS_EVENT } = await import("../../lib/monaco/debugTab");
const { NO_ANSWER } = await import("../../lib/connection/openRead");

const CATALOG: RulesCatalog = {
  claude: {
    id: "claude",
    label: "Claude",
    defaultModel: "opus",
    models: [
      { id: "opus", label: "Opus", reasoning: ["low", "medium", "high"] },
      { id: "haiku", label: "Haiku", reasoning: [] },
    ],
  },
  codex: { id: "codex", label: "Codex", defaultModel: "sol", models: [{ id: "sol", label: "Sol", reasoning: ["low", "high"] }] },
};

function rules(patch: Partial<OrchestrationRules> = {}): OrchestrationRules {
  return {
    conduct: {
      delegation: "strict",
      selfEdit: false,
      selfShell: true,
      verifyResults: true,
      escalate: true,
      useWorktrees: true,
      maxParallel: 4,
      maxAgents: 0,
    },
    models: { "claude:opus": { approved: true }, "claude:haiku": { approved: "orchestrators" } },
    routing: [
      { id: "r1", task: "Bulk work", provider: "codex", model: "sol", reasoning: "high", enabled: true },
      { id: "r2", task: "Reviews", provider: "claude", model: "opus", reasoning: "medium", enabled: true },
    ],
    ...patch,
  } as OrchestrationRules;
}

const saved = () => (state.save.mock.calls.at(-1) as unknown[] | undefined)?.[2] as OrchestrationRules;

async function choose(trigger: HTMLElement, name: string) {
  await act(async () => {
    fireEvent.click(trigger);
  });
  const option = await screen.findByRole("option", { name });
  await act(async () => {
    fireEvent.pointerDown(option, { pointerType: "mouse" });
    fireEvent.click(option);
  });
}

async function openRule(task: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: `Edit rule: ${task}` }));
  });
  return screen.findByRole("dialog");
}

async function saveDialog(dialog: HTMLElement) {
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  });
}

const ruleRow = (task: string) => screen.getByRole("button", { name: `Edit rule: ${task}` }).closest<HTMLElement>("[data-slot=page-row]")!;

/** The Models sheet, opened from its row. */
async function openModels() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Models agents may run on" }));
  });
  return screen.findByRole("dialog");
}

const withConfirm = () => (
  <>
    <OrchestrationPage />
    <ConfirmHost />
  </>
);

beforeEach(() => {
  state.scope = { rules: rules(), overridden: false };
  state.catalog = CATALOG;
  state.workspaces = [];
  state.save.mockReset();
  state.save.mockImplementation(async () => {});
  state.clear.mockClear();
  state.load.mockClear();
  state.error = null;
  state.retry.mockClear();
});
afterEach(() => {
  cleanup();
  keyRights.write = true;
});

describe("Subagents", () => {
  it("shows the lead thread's rows in their shape under the real heading before the set loads", () => {
    state.scope = undefined;
    render(<OrchestrationPage />);
    expect(screen.getByTestId("rules-skeleton")).toBeTruthy();
    expect(screen.getByRole("region", { name: "The lead thread" })).toBeTruthy();
    // Every section stands under its heading in its rows' shape, so nothing appears from nowhere on the answer.
    for (const name of ["The lead thread", "Limits", "Models", "Which model gets which work"]) expect(screen.getByRole("region", { name })).toBeTruthy();
    const lead = within(screen.getByRole("region", { name: "The lead thread" })).getAllByLabelText("Loading")[0]!;
    expect([...lead.querySelectorAll<HTMLElement>("[data-slot=page-row-skeleton]")].map((r) => r.dataset.control)).toEqual(["select", "switch", "switch", "switch", "switch", "switch"]);
  });

  it("ends the skeleton when rules.get does not answer: one line naming the computer, one Retry, no headings or bones", async () => {
    state.scope = undefined;
    state.error = NO_ANSWER;
    render(<OrchestrationPage />);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toBe("This Mac did not answer.");
    expect(screen.queryByRole("region", { name: "Limits" })).toBeNull();
    expect(document.querySelector("[data-slot=page-row-skeleton]")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(state.retry).toHaveBeenCalledOnce();
  });

  it("names the lead thread's rows in his words, with no line under them", () => {
    render(<OrchestrationPage />);
    const lead = screen.getByRole("region", { name: "The lead thread" });
    for (const name of ["May edit files itself", "May run commands itself", "Checks its agents' work", "Retries with a stronger model", "Gives each agent its own checkout"])
      expect(within(lead).getByRole("switch", { name })).toBeTruthy();
    expect(within(lead).getByRole("combobox", { name: "Gives its agents" }).textContent).toContain("Everything");
    expect(lead.querySelectorAll("[data-slot=item-description]")).toHaveLength(0);
  });

  it("offers Everything and Everything but small tasks, and keeps a saved third value by its own name", async () => {
    render(<OrchestrationPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("combobox", { name: "Gives its agents" }));
    });
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Everything", "Everything but small tasks"]);
    cleanup();
    state.scope = { rules: rules({ conduct: { ...rules().conduct, delegation: "free" } }), overridden: false };
    render(<OrchestrationPage />);
    expect(screen.getByRole("combobox", { name: "Gives its agents" }).textContent).toContain("Only what is faster to hand off");
  });

  it("saves a switch at once with its row's mark", async () => {
    render(<OrchestrationPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "May edit files itself" }));
    });
    expect(state.save).toHaveBeenCalledWith("local", null, expect.anything());
    expect(saved().conduct.selfEdit).toBe(true);
    expect((document.querySelector("[data-setting='sub.edits']") as HTMLElement).textContent).toContain("Saved");
  });

  it("says once that both limits are for each thread, tells them apart by name, and names no limit", () => {
    render(<OrchestrationPage />);
    const limits = screen.getByRole("region", { name: "Limits" });
    expect(limits.textContent?.split("For each thread").length).toBe(2);
    expect(within(limits).getByRole("combobox", { name: "Agents at once" })).toBeTruthy();
    expect(within(limits).getByRole("combobox", { name: "Agents in all" }).textContent).toContain("No limit");
  });

  it("offers Docket's defaults only while a set is stored", () => {
    render(<OrchestrationPage />);
    expect(document.querySelector("[data-setting='sub.reset']")).toBeNull();
  });

  it("puts Docket's defaults last on the page, asking before it deletes every rule, and clears only on the verb", async () => {
    state.scope = { rules: rules(), overridden: true };
    render(withConfirm());
    const row = document.querySelector<HTMLElement>("[data-setting='sub.reset']")!;
    const sections = [...document.querySelectorAll("[data-slot=page-section]")];
    expect(sections.at(-1)!.contains(row)).toBe(true);
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Use…" })));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("every rule for which model gets which work is deleted");
    expect(state.clear).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Use Docket's defaults" })));
    expect(state.clear).toHaveBeenCalledWith("local", null);
  });

  it("offers a workspace's own set Use Subagents…, asking first", async () => {
    state.workspaces = [{ id: "w1", name: "Alpha", environmentId: "local" }];
    state.scope = { rules: rules(), overridden: true };
    render(
      <>
        <OrchestrationRulesEditor workspaceId="w1" />
        <ConfirmHost />
      </>,
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use Subagents…" })));
    const confirm = await screen.findByRole("alertdialog");
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Use Subagents" })));
    expect(state.clear).toHaveBeenCalledWith("local", "w1");
  });

  it("opens a workspace's rules on its page, and the one set on this one", () => {
    const seen: string[] = [];
    const listen = (event: Event) => seen.push((event as CustomEvent<string>).detail);
    window.addEventListener(OPEN_SETTINGS_EVENT, listen);
    openOrchestrationSettings("w1");
    expect(takeRequestedRulesFocus()).toBe(true);
    expect(takeRequestedRulesFocus()).toBe(false);
    openOrchestrationSettings(null);
    expect(takeRequestedRulesFocus()).toBe(false);
    window.removeEventListener(OPEN_SETTINGS_EVENT, listen);
    expect(seen).toEqual(["ws:w1", "orchestration"]);
  });
});

describe("Models agents may run on", () => {
  it("says how many are allowed on its row, and opens a sheet of one table, a group row per agent app", async () => {
    render(<OrchestrationPage />);
    // Opus for everyone; Haiku for lead threads only is not a model an agent may run.
    expect((document.querySelector("[data-setting='sub.models']") as HTMLElement).textContent).toContain("1 of 3 allowed");
    const sheet = await openModels();
    const table = within(sheet).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Model", "Who may start it", "Effort"]);
    expect([...table.querySelectorAll("[data-slot=table-group-row]")].map((g) => g.textContent)).toEqual(["Claude Code", "Codex"]);
    // The count is the row's: the sheet does not say it again.
    expect(sheet.textContent).not.toContain("allowed");
  });

  it("saves who may start a model", async () => {
    render(<OrchestrationPage />);
    await openModels();
    await choose(screen.getByRole("combobox", { name: "Who may start Opus" }), "Lead threads only");
    expect(saved().models["claude:opus"].approved).toBe("orchestrators");
    await choose(screen.getByRole("combobox", { name: "Who may start Sol" }), "Everyone");
    expect(saved().models["codex:sol"].approved).toBe(true);
    await choose(screen.getByRole("combobox", { name: "Who may start Opus" }), "Off");
    expect(saved().models["claude:opus"]).toEqual({ approved: false });
  });

  it("shows the effort pair only for an allowed model with a ladder, each select one width", async () => {
    render(<OrchestrationPage />);
    await openModels();
    const low = screen.getByRole("combobox", { name: "Opus lowest effort" });
    expect(low.className).toContain("w-28");
    expect(screen.queryByRole("combobox", { name: "Haiku lowest effort" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Sol lowest effort" })).toBeNull();
    expect((low.closest("tr")!.firstElementChild as HTMLElement).className).toContain("@max-[36rem]/page:basis-full");
  });

  it("puts a refused change under its model, in the computer's words", async () => {
    state.save.mockImplementation(async () => {
      throw new Error("refused: orchestration rules live on box; it is offline");
    });
    render(<OrchestrationPage />);
    await openModels();
    await choose(screen.getByRole("combobox", { name: "Who may start Opus" }), "Off");
    expect(screen.getByText("Orchestration rules live on box; it is offline").className).toContain("text-destructive");
  });
});

describe("Which model gets which work", () => {
  it("says Not allowed on a rule whose model is off", () => {
    render(<OrchestrationPage />);
    expect(within(ruleRow("Bulk work")).getByText("Not allowed").className).toContain("text-warning");
    expect(within(ruleRow("Reviews")).queryByText("Not allowed")).toBeNull();
  });

  it("moves a rule with its menu's Move up and Move down", async () => {
    render(<OrchestrationPage />);
    await act(async () => {
      fireEvent.click(within(ruleRow("Bulk work")).getByRole("button", { name: "Bulk work actions" }));
    });
    const down = await screen.findByRole("menuitem", { name: "Move down" });
    expect(screen.getByRole("menuitem", { name: "Move up" }).getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      fireEvent.click(down);
    });
    expect(saved().routing.map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("turns a rule off from its dialog", async () => {
    render(<OrchestrationPage />);
    const dialog = await openRule("Reviews");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("switch", { name: "Use this rule" }));
    });
    await saveDialog(dialog);
    expect(saved().routing.find((r) => r.id === "r2")?.enabled).toBe(false);
  });

  it("is the one dialog shape, Delete… a quiet action at the footer's start that asks first", async () => {
    render(withConfirm());
    const dialog = await openRule("Reviews");
    expectModalShape(dialog);
    const del = within(dialog).getByRole("button", { name: "Delete…" });
    expect(del.closest("[data-footer-start]")).not.toBeNull();
    expect(del.getAttribute("data-variant")).toBe("ghost");
    await act(async () => {
      fireEvent.click(del);
    });
    const confirm = await screen.findByRole("alertdialog");
    expect(state.save).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Delete" })));
    expect(saved().routing.map((r) => r.id)).toEqual(["r1"]);
  });

  it("keeps the dialog open with the reason when the save is refused", async () => {
    state.save.mockImplementation(async () => {
      throw new Error("refused: orchestration rules live on box; it is offline");
    });
    render(<OrchestrationPage />);
    const dialog = await openRule("Reviews");
    await saveDialog(dialog);
    expect(within(dialog).getByText("orchestration rules live on box; it is offline")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("asks a new rule for no On switch, and saves its trimmed task, never an empty one", async () => {
    render(<OrchestrationPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add rule…" }));
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("switch", { name: "Use this rule" })).toBeNull();
    const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("When the task is"), { target: { value: "  Docs  " } });
    await act(async () => {
      fireEvent.click(save);
    });
    expect(saved().routing.at(-1)?.task).toBe("Docs");
  });

  it("shows an empty line with no rules", () => {
    state.scope = { rules: rules({ routing: [] }), overridden: false };
    render(<OrchestrationPage />);
    expect(screen.getByText("No rules")).toBeTruthy();
  });
});

describe("where the set is kept", () => {
  it("tells the page's line, and leaves its sections bare", async () => {
    const { usePageHome } = await import("../../lib/settings/pageHome");
    let seen: unknown;
    function Probe() {
      seen = usePageHome("orchestration");
      return null;
    }
    state.scope = { rules: rules(), overridden: true, home: { name: "box", online: true } };
    render(
      <>
        <OrchestrationPage />
        <Probe />
      </>,
    );
    await act(async () => {});
    expect(seen).toEqual({ name: "box", online: true });
    expect(screen.queryByText(/Saved on/)).toBeNull();
  });

  it("holds every control while the box is offline", () => {
    state.scope = { rules: rules(), overridden: true, home: { name: "box", online: false } };
    render(<OrchestrationPage />);
    expect((screen.getByRole("switch", { name: "May edit files itself" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "Gives its agents" }) as HTMLButtonElement).disabled).toBe(true);
    // Nothing is offered that cannot work: no Docket's defaults, Add rule… or ⋯ while the box is out of reach.
    expect(document.querySelector("[data-setting='sub.reset']")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add rule…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Bulk work actions" })).toBeNull();
  });

  it("a write the box refuses slides the switch back and says why under its row", async () => {
    state.save.mockImplementation(async () => {
      throw new Error("refused: orchestration rules and thread defaults live on box; it is offline");
    });
    render(<OrchestrationPage />);
    const edits = screen.getByRole("switch", { name: "May edit files itself" });
    await act(async () => {
      fireEvent.click(edits);
    });
    expect(edits.getAttribute("aria-checked")).toBe("false");
    expect((document.querySelector("[data-setting='sub.edits']") as HTMLElement).textContent).toContain("Orchestration rules and thread defaults live on box; it is offline");
  });

  it("reads the scope again at mount, so a follow on this computer shows", () => {
    render(<OrchestrationPage />);
    expect(state.load).toHaveBeenCalledWith("local", null, true);
  });
});

describe("Meta's rows in the subagent models table", () => {
  const META_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const CLAUDE_LADDER = ["low", "medium", "high", "xhigh", "max"] as const;
  const wonder = (reasoning: readonly string[]) =>
    ({ id: "muse-wonder-1.0", label: "Muse Wonder 1.0", reasoning: [...reasoning], defaultReasoning: "high", context: 1_048_576, vendor: "meta" }) as RulesCatalog["claude"]["models"][number];

  beforeEach(() => {
    state.catalog = {
      claude: { ...CATALOG.claude, models: [...CATALOG.claude.models, wonder(CLAUDE_LADDER)] },
      codex: { ...CATALOG.codex, models: [...CATALOG.codex.models, wonder(META_LADDER)] },
    };
    state.scope = {
      rules: rules({ models: { "claude:muse-wonder-1.0": { approved: true }, "codex:muse-wonder-1.0": { approved: true } } }),
      overridden: false,
    };
  });

  it("lists Wonder under Claude and Codex, Minimal on the Codex row's ladder alone", async () => {
    render(<OrchestrationPage />);
    await openModels();
    const spawn = screen.getAllByRole("combobox", { name: "Who may start Muse Wonder 1.0" });
    expect(spawn).toHaveLength(2);
    const [claudeLow, codexLow] = screen.getAllByRole("combobox", { name: "Muse Wonder 1.0 lowest effort" });
    expect(claudeLow.textContent).toContain("Low");
    expect(codexLow.textContent).toContain("Minimal");
    await act(async () => {
      fireEvent.click(codexLow);
    });
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Minimal", "Low", "Medium", "High", "Extra high", "Max"]);
  });
});

describe("every provider of the host's catalog", () => {
  const LIVE: RulesCatalog = {
    claude: CATALOG.claude,
    codex: CATALOG.codex,
    cursor: { id: "cursor", label: "Cursor", defaultModel: "composer", models: [{ id: "composer", label: "Composer", reasoning: [] }] },
    grok: { id: "grok", label: "Grok Build", defaultModel: "", models: [] },
    muse: {
      id: "muse",
      label: "Muse Code",
      defaultModel: "muse-spark-1.3",
      models: [
        { id: "muse-wonder-1.0", label: "Muse Wonder 1.0", reasoning: ["minimal", "low", "high"] },
        { id: "muse-wonder-full-1.0", label: "Muse Wonder Full 1.0", reasoning: ["low", "high"] },
        { id: "muse-spark-1.3", label: "Muse Spark 1.3", reasoning: ["low", "high"] },
        { id: "muse-spark-1.2", label: "Muse Spark 1.2", reasoning: [] },
      ],
    },
  };

  beforeEach(() => {
    state.catalog = LIVE;
    // What rules.get answers once the host has probed: withProbedDefaults
    // gave each Muse row its default.
    const { withProbedDefaults } = shared;
    const { CATALOG: STATIC } = catalogModule;
    const before = STATIC.muse.models;
    STATIC.muse.models = LIVE.muse!.models;
    try {
      state.scope = { rules: withProbedDefaults(rules({ models: { "claude:opus": { approved: true }, "claude:retired": { approved: "orchestrators" } } })), overridden: false };
    } finally {
      STATIC.muse.models = before;
    }
  });

  it("heads every provider in the catalog's order, each with its mark", async () => {
    render(<OrchestrationPage />);
    await openModels();
    const groups = [...screen.getByRole("dialog").querySelector("table")!.querySelectorAll("[data-slot=table-group-row]")];
    expect(groups.map((g) => g.textContent)).toEqual(["Claude Code", "Codex", "Cursor", "Grok Build", "Muse Code"]);
    for (const g of groups) expect(g.querySelector("img, svg")).toBeTruthy();
  });

  it("lists the probed Muse rows, each with a policy control, Wonder Full for orchestrators only", async () => {
    render(<OrchestrationPage />);
    await openModels();
    for (const label of ["Muse Wonder 1.0", "Muse Wonder Full 1.0", "Muse Spark 1.3", "Muse Spark 1.2"])
      expect(screen.getByRole("combobox", { name: `Who may start ${label}` })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Who may start Muse Wonder Full 1.0" }).textContent).toContain("Lead threads only");
    expect(screen.getByRole("combobox", { name: "Who may start Muse Wonder 1.0" }).textContent).toContain("Everyone");
    // The ladder is the host's row's, not the renderer's static copy (empty for Muse).
    expect(screen.getByRole("combobox", { name: "Muse Wonder 1.0 lowest effort" }).textContent).toContain("Minimal");
  });

  it("says why a provider with no models has none", async () => {
    render(<OrchestrationPage />);
    await openModels();
    const line = screen.getByText("No models until Grok Build is installed and signed in");
    expect(line.className).toContain("text-muted-foreground");
    // It wraps on a narrow page instead of being cut mid-word at the table's edge.
    expect(line.className).toContain("whitespace-normal");
    expect(screen.queryByText(/No models until Muse Code/)).toBeNull();
  });

  it("keeps a saved policy for a model this host lacks, muted, and saves a change to it", async () => {
    render(<OrchestrationPage />);
    await openModels();
    const row = screen.getByText("not on this computer").closest("tr")!;
    expect(row.textContent).toContain("retired");
    expect(row.querySelector("td")!.className).toContain("text-muted-foreground");
    const spawn = within(row).getByRole("combobox", { name: "Who may start retired" });
    expect(spawn.textContent).toContain("Lead threads only");
    await choose(spawn, "Everyone");
    expect(saved().models["claude:retired"]).toEqual({ approved: true });
  });

  it("bounds a model's name to what the controls leave, cut with its tip, so the effort pair stays in the table", async () => {
    render(<OrchestrationPage />);
    await openModels();
    const cell = screen.getByText("not on this computer").closest("td")!;
    // The cell takes the rest of the row and no more; the name truncates inside it.
    expect(cell.className).toContain("w-full");
    expect(cell.className).toContain("max-w-0");
    expect(cell.className).toContain("@max-[36rem]/page:max-w-none");
    const name = cell.querySelector<HTMLElement>("[data-slot=model-name]")!;
    expect(name.className).toContain("truncate");
    expect(name.textContent).toBe("retirednot on this computer");
  });

  it("offers only agent apps with models in a rule's dialog", async () => {
    render(<OrchestrationPage />);
    const dialog = await openRule("Bulk work");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("combobox", { name: "Agent app" }));
    });
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Claude Code", "Codex", "Cursor", "Muse Code"]);
  });
});

describe("Subagents for a key that may read but not change them", () => {
  it("says every value as words, offers no Add rule…, reset or rule dialog, and says who can change them", async () => {
    keyRights.write = false;
    state.scope = { rules: rules(), overridden: true };
    render(<OrchestrationPage />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.querySelector("[data-setting='sub.gives'] [data-value-words]")!.textContent).toBe("Everything");
    expect(document.querySelector("[data-setting='sub.perThread'] [data-value-words]")!.textContent).toBe("No limit");
    expect(screen.queryByRole("button", { name: "Add rule…" })).toBeNull();
    expect(document.querySelector("[data-setting='sub.reset']")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit rule: Bulk work" })).toBeNull();
    expect(document.querySelectorAll("[data-managed]")).toHaveLength(1);
    // The model allowances stay readable, as words, in the sheet.
    const sheet = await openModels();
    expect(within(sheet).queryByRole("combobox")).toBeNull();
    expect(within(sheet).getAllByText("Everyone").length).toBeGreaterThan(0);
  });
});
