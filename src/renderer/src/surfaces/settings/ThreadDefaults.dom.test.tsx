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
}));

vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));
vi.mock("../../chrome/PlanSettingsFields", () => ({ PlanSettingsEditor: () => <section aria-label="Builds from plans" /> }));
vi.mock("../../chrome/ConfirmDialog", async (original) => ({
  ...(await original<typeof import("../../chrome/ConfirmDialog")>()),
  confirmAction: (request: unknown) => state.confirm(request),
}));
const link = vi.hoisted(() => ({ environmentId: "local", connected: true, onOpen: () => () => {} }));
vi.mock("../../lib/connection", () => ({ registry: { primary: () => link, primaryEnvironmentId: "local" } }));
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
    state.failed ? undefined : { defaults: defaultsOf(), overridden: id === null ? state.overridden : state.overriding.has(id), home: state.home },
  useThreadDefaultsError: () => (state.failed ? { error: "The computer did not answer", retry: state.retry } : null),
  useWorkspaceCatalog: () => ({
    workspaces: state.workspaces,
    defaults: new Map([...state.overriding].map((id) => [`local:${id}`, { overridden: true }])),
  }),
  workspaceStore: { saveDefaults: (...args: unknown[]) => state.save(...args) },
}));

const { ThreadDefaultsPage } = await import("./ThreadDefaults");
const { ThreadDefaultsDialog, ThreadDefaultsEditor } = await import("../../chrome/ThreadDefaultsDialog");
const { usePageHome, resetPageHomesForTests } = await import("../../lib/settings/pageHome");

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

  it("offers Use Docket's defaults… only while a set is stored, and asks first", async () => {
    const { unmount } = render(<ThreadDefaultsPage />);
    expect(screen.queryByRole("button", { name: "Use Docket's defaults…" })).toBeNull();
    unmount();
    state.overridden = true;
    render(<ThreadDefaultsPage />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use Docket's defaults…" }));
    });
    expect(state.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Use Docket's defaults" }));
    expect(state.save).toHaveBeenCalledWith("local", null, null);
  });

  it("ends the skeleton when the computer does not answer: the error and Retry, no made-up set", () => {
    state.failed = true;
    render(<ThreadDefaultsPage />);
    expect(screen.queryByRole("combobox", { name: "Agent app" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("The computer did not answer");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.retry).toHaveBeenCalledOnce();
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

  it("is absent while every place follows New threads", () => {
    state.workspaces = [{ id: "w1", name: "Alpha", environmentId: "local" }];
    render(<ThreadDefaultsPage />);
    expect(document.querySelector("[data-setting='defaults.different']")).toBeNull();
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
    const start = dialog.querySelector('[data-slot="dialog-footer"] [data-footer-start]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(start).getByRole("button", { name: "Use New threads" }));
    });
    expect(state.save).toHaveBeenCalledWith("local", "w1", null);
  });

  it("says so in the rows' place when the computer never answers, Retry at the footer's start", async () => {
    state.failed = true;
    render(<ThreadDefaultsDialog workspace={ALPHA} onClose={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert").textContent).toBe("The computer did not answer");
    const start = dialog.querySelector('[data-slot="dialog-footer"] [data-footer-start]') as HTMLElement;
    fireEvent.click(within(start).getByRole("button", { name: "Retry" }));
    expect(state.retry).toHaveBeenCalledOnce();
  });

  it("keeps the page editor for a workspace working until its page opens the dialog", () => {
    state.workspaces = [{ id: "w1", name: "Alpha", environmentId: "local" }];
    render(<ThreadDefaultsEditor workspaceId="w1" />);
    expect(screen.getByRole("heading", { name: "New threads" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Agent app" })).toBeTruthy();
  });
});
