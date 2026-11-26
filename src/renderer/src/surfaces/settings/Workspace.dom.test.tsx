// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  workspace: { id: "w1", name: "Alpha", path: "/w/alpha", environmentId: "local", accountPins: {} as Record<string, string> },
  projects: [] as { id: string; workspaceId: string; name: string; archived: boolean; accountPins?: Record<string, string> }[],
  overridden: false,
  focus: false,
  rulesFocus: false,
  setAccounts: vi.fn(async () => {}),
  metaKeys: [] as { name: string; kind: "key"; static: true }[],
  noClaude: false,
  pass: { value: { verify: true, build: false, commit: "off" }, error: null, retry: () => {} } as { value: unknown; error: string | null; retry: () => void },
}));

const profile = (name: string) => ({ name, email: `${name}@example.com` });

vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));
vi.mock("../../lib/sounds", () => ({ playCue: () => {} }));
vi.mock("../../lib/connection", () => ({ registry: { primary: () => ({ environmentId: "local" }) }, useEnvironments: () => [{ id: "local", name: "The box" }] }));
vi.mock("../../lib/linkMay", async (original) => (await import("../../lib/linkMay.testkit")).linkMayMock(await original()));
vi.mock("./parts/StartSetRow", () => ({ StartSetRow: () => <div data-start-set /> }));
vi.mock("../../chrome/PreambleDialog", () => ({ PreambleDialog: () => <div role="dialog">Rules read before the first message</div> }));
vi.mock("../../lib/settings/computerName", () => ({ useComputerName: () => ({ name: "The box", own: false }) }));
vi.mock("../../chrome/TurnPassFields", () => ({
  TurnPassEditor: () => <h2>After each turn</h2>,
  // The page's one read: answered, refused or out, as each test sets it.
  useTurnPassRead: () => ({ read: state.pass, confirmed: { current: null } }),
}));
vi.mock("../../chrome/ProjectDialogs", () => ({
  ProjectSettingsDialog: ({ project }: { project: { name: string } }) => <div role="dialog">{project.name} settings</div>,
}));
vi.mock("../../chrome/rail/buildSettings", () => ({
  BuildEditor: () => (
    <section aria-labelledby="build-heading" data-testid="build-editor">
      <h2 id="build-heading">Build</h2>
    </section>
  ),
  takeRequestedBuildFocus: () => {
    const focus = state.focus;
    state.focus = false;
    return focus;
  },
}));
vi.mock("../../lib/tcserver/workspaces", () => ({
  useWorkspaces: () => [state.workspace],
  useProjects: () => state.projects,
}));
vi.mock("../../lib/tcserver/rules", () => ({
  useRulesScope: () => ({ scope: { overridden: state.overridden }, catalog: null, error: null, retry: () => {} }),
  rulesStore: { clear: async () => {} },
  takeRequestedRulesFocus: () => {
    const focus = state.rulesFocus;
    state.rulesFocus = false;
    return focus;
  },
}));
vi.mock("../../chrome/OrchestrationRules", () => ({
  OrchestrationRulesEditor: ({ workspaceId }: { workspaceId: string }) => <h2>Orchestration {workspaceId}</h2>,
}));
vi.mock("../../lib/tcserver/projects", () => ({
  setWorkspaceAccounts: (...a: unknown[]) => state.setAccounts(...(a as [])),
}));
vi.mock("../../stores/accounts", () => ({
  useAccounts: () => ({
    snapshot: {
      providers: {
        claude: { profiles: state.noClaude ? [] : [profile("alice"), profile("bob")] },
        codex: { profiles: [profile("carol")] },
        cursor: { profiles: [] },
        meta: { profiles: state.metaKeys },
      },
    },
  }),
}));

const { WorkspacePage } = await import("./Workspace");
const { GIVEN_KEY, resetTestKey, testKey } = await import("../../lib/linkMay.testkit");

const projectRows = () =>
  [...document.querySelectorAll<HTMLElement>("[data-slot=page-row]")].filter((row) => row.querySelector("[aria-label$=' settings']"));

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

beforeEach(() => {
  state.workspace = { ...state.workspace, accountPins: {} };
  state.projects = [];
  state.overridden = false;
  state.focus = false;
  state.rulesFocus = false;
  state.setAccounts.mockClear();
  state.metaKeys = [];
  state.noClaude = false;
  state.pass = { value: { verify: true, build: false, commit: "off" }, error: null, retry: () => {} };
});
afterEach(() => {
  cleanup();
  resetTestKey();
});

describe("Workspace page", () => {
  it("orders its sections", () => {
    state.projects = [{ id: "p1", workspaceId: "w1", name: "App", archived: false }];
    render(<WorkspacePage workspaceId="w1" />);
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["New threads", "After each turn", "Accounts", "Build", "Subagents", "Projects"]);
  });

  it("pins an account and removes the pin on Auto", async () => {
    render(<WorkspacePage workspaceId="w1" />);
    await choose(screen.getByRole("combobox", { name: "Claude account" }), "bob");
    expect(state.setAccounts).toHaveBeenLastCalledWith("w1", { claude: "bob" });
    cleanup();
    state.workspace = { ...state.workspace, accountPins: { claude: "bob", codex: "carol" } };
    render(<WorkspacePage workspaceId="w1" />);
    await choose(screen.getByRole("combobox", { name: "Claude account" }), "Auto");
    expect(state.setAccounts).toHaveBeenLastCalledWith("w1", { codex: "carol" });
  });

  it("shows a given computer the pins as words and who changes them, with no select to refuse", () => {
    // workspace.setAccounts needs admin: a given computer's key would be refused on the press (W-37).
    testKey.current = GIVEN_KEY;
    state.workspace = { ...state.workspace, accountPins: { claude: "bob" } };
    render(<WorkspacePage workspaceId="w1" />);
    expect(screen.queryByRole("combobox", { name: "Claude account" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Codex account" })).toBeNull();
    const section = screen.getByRole("heading", { name: "Accounts" }).closest("section")!;
    // Who can is said once, at the page's top.
    expect(screen.getAllByText("Changed from a computer that manages the box")).toHaveLength(1);
    expect(section.textContent).toContain("bob");
    expect(section.textContent).toContain("Auto");
    expect(section.textContent).not.toContain("Auto picks by model");
  });

  it("names a pin AI accounts does not know", () => {
    state.workspace = { ...state.workspace, accountPins: { claude: "gone" } };
    render(<WorkspacePage workspaceId="w1" />);
    expect(screen.getByRole("combobox", { name: "Claude account" }).textContent).toContain("gone, not in AI accounts");
  });

  it("shows a failed pin under its row", async () => {
    state.setAccounts.mockImplementationOnce(async () => {
      throw new Error("refused: offline");
    });
    render(<WorkspacePage workspaceId="w1" />);
    await choose(screen.getByRole("combobox", { name: "Claude account" }), "bob");
    expect(screen.getByText("Offline").className).toContain("text-destructive");
    expect(screen.getByRole("combobox", { name: "Claude account" }).textContent).toContain("Auto");
  });

  it("lists this workspace's live projects with their pins", () => {
    state.projects = [
      { id: "p1", workspaceId: "w1", name: "App", archived: false, accountPins: { claude: "alice", codex: "carol" } },
      { id: "p2", workspaceId: "w1", name: "Docs", archived: false },
      { id: "p3", workspaceId: "w1", name: "Old", archived: true },
      { id: "p4", workspaceId: "w2", name: "Elsewhere", archived: false },
    ];
    render(<WorkspacePage workspaceId="w1" />);
    const rows = projectRows();
    expect(rows.map((r) => r.querySelector("[data-slot=item-title]")?.textContent)).toEqual(["App", "Docs"]);
    expect(rows[0].textContent).toContain("alice");
    expect(rows[0].textContent).toContain("carol");
    expect(rows[1].querySelector("[data-slot=item-description]")).toBeNull();
  });

  it("shows the workspace's pin on a project that pins nothing itself", () => {
    state.workspace = { ...state.workspace, accountPins: { claude: "alice" } };
    state.projects = [
      { id: "p1", workspaceId: "w1", name: "App", archived: false, accountPins: { claude: "bob" } },
      { id: "p2", workspaceId: "w1", name: "Docs", archived: false },
    ];
    render(<WorkspacePage workspaceId="w1" />);
    const [app, docs] = projectRows().map((r) => r.querySelector("[data-slot=item-description]")?.textContent);
    expect(app).toBe("bob");
    expect(docs).toBe("alice");
  });

  it("opens a project's settings from its row", async () => {
    state.projects = [{ id: "p1", workspaceId: "w1", name: "App", archived: false }];
    render(<WorkspacePage workspaceId="w1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "App settings" }));
    });
    expect(screen.getByRole("dialog").textContent).toBe("App settings");
  });

  it("scrolls the Build section into view when the rail asked for it", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    state.focus = true;
    render(<WorkspacePage workspaceId="w1" />);
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(scroll.mock.contexts[0]).toBe(document.getElementById("settings-build"));
    expect(document.activeElement).toBe(document.getElementById("settings-build"));
  });

  it("opens the rules for its agents in their sheet when the workspace menu asked for them", () => {
    Element.prototype.scrollIntoView = vi.fn();
    state.rulesFocus = true;
    render(<WorkspacePage workspaceId="w1" />);
    expect(document.activeElement).toBe(document.getElementById("settings-orchestration"));
    expect(screen.getByText("Orchestration w1")).toBeTruthy();
  });

  it("says whose rules its agents follow, and Change… opens the Subagents editor for this workspace in a sheet", async () => {
    state.overridden = true;
    render(<WorkspacePage workspaceId="w1" />);
    expect(document.querySelector('[data-setting="ws.agents"]')?.textContent).toContain("Set for this workspace");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Change…" })));
    // The editor (Orchestration.dom.test.tsx) holds the one Use Subagents…, which asks first: the sheet adds none.
    expect(screen.getByText("Orchestration w1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use Subagents…" })).toBeNull();
  });

  it("says the rules read before the first message by their length and state, and Edit… opens their dialog", async () => {
    state.workspace = { ...state.workspace, preamble: "Run the gate before you land.", preambleEnabled: true } as typeof state.workspace;
    render(<WorkspacePage workspaceId="w1" />);
    expect(document.querySelector('[data-setting="ws.rules"]')?.textContent).toContain("6 words, on");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Edit…" })));
    expect(screen.getByRole("dialog").textContent).toBe("Rules read before the first message");
  });

  it("offers no Meta row on a host with no key", () => {
    render(<WorkspacePage workspaceId="w1" />);
    expect(screen.queryByRole("combobox", { name: "Meta account" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Codex account" })).toBeTruthy();
  });

  it("pins a Meta key from Meta's row, its mark and the keys by name", async () => {
    state.metaKeys = [{ name: "Work", kind: "key", static: true }, { name: "Meta key …9QzT", kind: "key", static: true }];
    render(<WorkspacePage workspaceId="w1" />);
    const row = screen.getByRole("combobox", { name: "Meta account" }).closest<HTMLElement>("[data-slot=page-row]")!;
    expect(row.querySelector("[data-slot=item-title]")?.textContent).toBe("Meta");
    expect(row.querySelector("svg")).toBeTruthy();
    await choose(screen.getByRole("combobox", { name: "Meta account" }), "Meta key …9QzT");
    expect(state.setAccounts).toHaveBeenLastCalledWith("w1", { meta: "Meta key …9QzT" });
  });

  it("keeps the Meta row for a pin whose key left", () => {
    state.workspace = { ...state.workspace, accountPins: { meta: "Gone key" } };
    render(<WorkspacePage workspaceId="w1" />);
    expect(screen.getByRole("combobox", { name: "Meta account" }).textContent).toContain("Gone key, not in AI accounts");
  });

  it("holds every section in its shape while its computer answers, and says a refusal once with one Retry", () => {
    state.projects = [{ id: "p1", workspaceId: "w1", name: "App", archived: false }];
    state.pass = { value: undefined, error: null, retry: () => {} };
    render(<WorkspacePage workspaceId="w1" />);
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["New threads", "After each turn", "Accounts", "Build", "Subagents", "Projects"]);
    expect(screen.queryByRole("combobox")).toBeNull();
    cleanup();
    const retry = vi.fn();
    state.pass = { value: undefined, error: "The box did not answer", retry };
    render(<WorkspacePage workspaceId="w1" />);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("says Auto as the value where no account can be picked, and goes to AI accounts", () => {
    state.noClaude = true;
    render(<WorkspacePage workspaceId="w1" />);
    // Claude has no account to pick and no pin: Auto as words, the row opening AI accounts, no dead select.
    expect(screen.queryByRole("combobox", { name: "Claude account" })).toBeNull();
    const row = screen.getByText("Auto, no other account to pick").closest<HTMLElement>("[data-slot=page-row]")!;
    expect(row.querySelector("[data-slot=open-cue]")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Codex account" })).toBeTruthy();
  });

  it("ends each project row in a chevron", () => {
    state.projects = [{ id: "p1", workspaceId: "w1", name: "App", archived: false }];
    render(<WorkspacePage workspaceId="w1" />);
    expect(projectRows()[0].querySelector("[data-slot=open-cue]")).toBeTruthy();
  });
});
