// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildRun, BuildTarget, EffectiveBuild, RemoteStatus } from "@server/shared/build";

const state = vi.hoisted(() => ({
  build: undefined as { run: BuildRun | null; lines: string[] } | undefined,
  effective: { command: "./gradlew shadowJar", outputs: "", source: "project" } as EffectiveBuild | null,
  remote: { branch: "master", upstream: true, ahead: 0, behind: 0, stale: false } as RemoteStatus | null,
  cancel: vi.fn(async () => {}),
  run: vi.fn(async () => {}),
  pull: vi.fn(async () => null),
  settings: vi.fn(),
  invoke: vi.fn(async () => undefined),
  /** D5: whether the window's key may build on the host. */
  mayBuild: true,
  held: null as string | null,
  /** reads of build.effective left to refuse before one answers */
  effectiveFails: 0,
}));
vi.mock("../../lib/linkMayCore", () => ({ useLinkMay: () => state.mayBuild }));
vi.mock("../../lib/connection/degraded", () => ({ useHostHeld: () => state.held }));

vi.mock("../../lib/tcserver/workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/tcserver/workspaces")>()),
  useProjects: () => [{ id: "p1", workspaceId: "w1", environmentId: "local", branch: "master", name: "plugin", cwd: "/w/plugin" }],
}));
vi.mock("../../lib/connection", () => ({
  registry: {
    linkOf: () => ({
      request: (method: string) => {
        if (method === "build.targets") return Promise.resolve([{ branch: "master", cwd: "/w/plugin", kind: "project" }] satisfies BuildTarget[]);
        if (method === "build.effective") {
          if (state.effectiveFails > 0) {
            state.effectiveFails--;
            return Promise.reject(new Error("build.effective: ENOENT: no such file or directory, open '/w/plugin/.temp-code/build.json'"));
          }
          return Promise.resolve(state.effective);
        }
        if (method === "build.remote") return Promise.resolve(state.remote);
        return Promise.reject(new Error(method));
      },
    }),
  },
}));
vi.mock("../../lib/projectRailStore", () => ({
  useBuild: () => state.build,
  useSync: () => undefined,
  fetchBuildStatus: async () => {},
  runBuild: state.run,
  cancelBuild: state.cancel,
  pullBranch: state.pull,
}));
vi.mock("../../lib/editorConfig", () => ({ useEditorConfig: () => null }));
vi.mock("./buildSettings", () => ({ openBuildSettings: state.settings }));
vi.mock("../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/native")>()),
  invoke: state.invoke,
}));

const { BuildPanel, BuildView } = await import("./BuildPanel");
const { resetTooltips, tooltipChunk, warmTooltips } = await import("../../components/ui/tooltip");

const now = Date.now();
const run = (over: Partial<BuildRun> = {}): BuildRun => ({
  id: "r1",
  status: "ok",
  command: "./gradlew shadowJar",
  cwd: "/w/plugin",
  branch: "master",
  startedAt: now - 64_000,
  endedAt: now,
  outputs: [],
  ...over,
});

function view(over: Partial<Parameters<typeof BuildView>[0]> = {}) {
  const props: Parameters<typeof BuildView>[0] = {
    targets: [{ branch: "master", cwd: "/w/plugin", kind: "project" }],
    chosen: "master",
    own: "master",
    effective: { command: "./gradlew shadowJar", outputs: "", source: "project" },
    run: null,
    lines: [],
    remote: { branch: "master", upstream: true, ahead: 0, behind: 0, stale: false },
    pulling: false,
    progress: undefined,
    pullError: null,
    error: null,
    onPick: vi.fn(),
    onBuild: vi.fn(),
    onCancel: vi.fn(),
    onFetch: vi.fn(),
    onSetCommand: vi.fn(),
    onReveal: vi.fn(),
    ...over,
  };
  render(<BuildView {...props} />);
  return props;
}

const status = (): HTMLElement => document.querySelector("[data-slot=status-mark]") as HTMLElement;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => {});
};

beforeEach(() => {
  // jsdom has no scrolling and no Web Animations; the scroll area asks for both.
  Element.prototype.scrollTo = () => {};
  Element.prototype.getAnimations = () => [];
  localStorage.clear();
  state.build = undefined;
  state.effective = { command: "./gradlew shadowJar", outputs: "", source: "project" };
  state.remote = { branch: "master", upstream: true, ahead: 0, behind: 0, stale: false };
  state.effectiveFails = 0;
  for (const fn of [state.cancel, state.run, state.pull, state.settings, state.invoke]) fn.mockClear();
});
afterEach(cleanup);

describe("BuildView", () => {
  it("shows the command and no status or log before any run", () => {
    view({ effective: { command: "bun run build", outputs: "", source: "detected" } });
    expect(status()).toBeNull();
    expect(document.querySelector("[data-slot=build-log]")).toBeNull();
    expect(screen.getByText("bun run build")).toBeTruthy();
    // The source never trails the command as a word (rightpanel-17): its hover says where it came from.
    expect(screen.queryByText("detected")).toBeNull();
    expect(document.querySelector("[data-build-command]")!.textContent).toBe("bun run build");
    // The section's top row: 36px on the panel's 12px inset, as Changes, Build, Notes and Files all draw it.
    const top = screen.getByRole("button", { name: "Build" }).closest('[data-slot="section-top"]')!;
    expect(top.className).toContain("h-9");
    expect(top.className).toContain("px-3");

  });

  it("says Working with the elapsed time while running, and Cancel cancels", () => {
    const props = view({ run: run({ status: "running", startedAt: now - 23_000, endedAt: undefined }), lines: ["> Task :classes"] });
    expect(status().dataset.state).toBe("working");
    expect(status().textContent).toMatch(/^Working2[2-4]s$/);
    expect(screen.queryByRole("button", { name: "Build" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(screen.getByText("> Task :classes")).toBeTruthy();
  });

  it("says Done with the duration", () => {
    view({ run: run() });
    expect(status().dataset.state).toBe("done");
    expect(status().textContent).toBe("Done1m 4s");
  });

  it("says Failed with the exit code and the duration as one comma run, and no branch the select already shows", () => {
    view({ chosen: "raids", run: run({ status: "failed", exitCode: 1, branch: "raids", startedAt: now - 62_000 }) });
    expect(status().dataset.state).toBe("failed");
    expect(status().querySelector("[data-slot=status-detail]")!.textContent).toBe("exit 1, 1m 2s");
    expect(document.body.textContent).not.toContain("·");
  });

  it("names the run's branch when the select has moved to another", () => {
    view({
      targets: [
        { branch: "master", cwd: "/w/plugin", kind: "project" },
        { branch: "raids", cwd: "/w/raids", kind: "checkout" },
      ],
      chosen: "master",
      run: run({ status: "failed", exitCode: 1, branch: "raids", startedAt: now - 62_000 }),
    });
    expect(status().querySelector("[data-slot=status-detail]")!.textContent).toBe("exit 1, 1m 2s, raids");
  });

  it("says Stopped for a cancelled run", () => {
    view({ run: run({ status: "cancelled" }) });
    expect(status().dataset.state).toBe("stopped");
    expect(status().textContent).toBe("Stopped");
  });

  it("offers Set one when there is no command", () => {
    const props = view({ effective: null });
    expect(screen.getByText("No build command")).toBeTruthy();
    // No dead Build beside the Empty's own action.
    expect(screen.queryByRole("button", { name: "Build" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set one" }));
    expect(props.onSetCommand).toHaveBeenCalledOnce();
  });

  it("shows Fetch only when origin is ahead", () => {
    view();
    expect(screen.queryByRole("button", { name: "Fetch" })).toBeNull();
    cleanup();
    const props = view({ remote: { branch: "master", upstream: true, ahead: 0, behind: 2, stale: false } });
    expect(screen.getByText("2 behind origin")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    expect(props.onFetch).toHaveBeenCalledOnce();
  });

  it("shows git's line and a bar while fetching", () => {
    view({
      remote: { branch: "master", upstream: true, ahead: 0, behind: 2, stale: false },
      pulling: true,
      progress: { branch: "master", line: "Receiving objects: 64%", percent: 64 },
    });
    expect(screen.getByText("Receiving objects: 64%")).toBeTruthy();
    expect(document.querySelector("[data-slot=progress]")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Fetch" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists outputs and reveals one on click and on Enter", () => {
    const props = view({
      run: run({
        outputs: [
          { path: "build/libs/plugin.jar", abs: "/w/plugin/build/libs/plugin.jar", size: 412_000, mtimeMs: now, fresh: true },
          { path: "build/libs/old.jar", abs: "/w/plugin/build/libs/old.jar", size: 1, mtimeMs: now, fresh: false },
        ],
      }),
    });
    expect(screen.getByText("Outputs")).toBeTruthy();
    expect(screen.getByText("402 KB")).toBeTruthy();
    expect(screen.getByText("Not rebuilt")).toBeTruthy();
    const row = document.querySelector('[data-output="build/libs/plugin.jar"]') as HTMLElement;
    fireEvent.click(row);
    expect(props.onReveal).toHaveBeenCalledWith("/w/plugin/build/libs/plugin.jar");
    fireEvent.keyDown(document.querySelector('[data-output="build/libs/old.jar"]') as HTMLElement, { key: "Enter" });
    expect(props.onReveal).toHaveBeenLastCalledWith("/w/plugin/build/libs/old.jar");
  });
});

describe("BuildView's tooltips", () => {
  it("puts no tip on a project's command that fits, nor an absolute path on an output or the branch (rightpanel-18)", async () => {
    resetTooltips();
    await tooltipChunk.load();
    act(() => warmTooltips());
    view({
      run: run({ outputs: [{ path: "build/libs/plugin.jar", abs: "/w/plugin/build/libs/plugin.jar", size: 10, mtimeMs: now, fresh: true }] }),
    });
    expect(document.querySelector("[data-build-command]")!.getAttribute("data-slot")).toBeNull();
    expect(document.querySelector('[data-output="build/libs/plugin.jar"] [data-slot="tooltip-trigger"]')).toBeNull();
    expect(document.querySelector('[data-slot="section-top"] [data-slot="tooltip-trigger"]')).toBeNull();
    expect(document.body.textContent).not.toContain("/w/plugin");
    cleanup();
    // A detected command says where it came from on its hover alone.
    view({ effective: { command: "bun run build", outputs: "", source: "detected" } });
    expect(document.querySelector("[data-build-command]")!.getAttribute("data-slot")).toBe("tooltip-trigger");
    resetTooltips();
  });

  it("warming keeps the log's scroller: the provider holds the top row alone", async () => {
    resetTooltips();
    view({ run: run({ status: "running", endedAt: undefined }), lines: Array.from({ length: 50 }, (_, i) => `line ${i}`) });
    const log = document.querySelector<HTMLElement>('[data-slot="build-log"]')!;
    log.scrollTop = 30;
    await tooltipChunk.load();
    act(() => warmTooltips());
    await flush();
    expect(document.querySelector('[data-slot="build-log"]')).toBe(log);
    expect(log.scrollTop).toBe(30);
    resetTooltips();
  });
});

describe("BuildPanel", () => {
  it("Set one opens the workspace's Build settings", async () => {
    state.effective = null;
    render(<BuildPanel projectId="p1" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Set one" }));
    expect(state.settings).toHaveBeenCalledWith("w1");
  });

  // council 5 S F5.1: a failed read is its own line with Retry, never "No build command" and Set one.
  it("says a failed read of the command apart from no command, and Retry reads again", async () => {
    state.effectiveFails = 1;
    render(<BuildPanel projectId="p1" />);
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Couldn't read the build commandRetry");
    expect(screen.queryByText("No build command")).toBeNull();
    expect(screen.queryByRole("button", { name: "Set one" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Build" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector("[data-build-command]")?.textContent).toBe("./gradlew shadowJar");
    expect(screen.getByRole("button", { name: "Build" })).toBeTruthy();
  });

  // council 5 S F5.2: a refused Build or Fetch is worded once (lib/dialogErrorWords), never the raw rejection.
  it("words a refused Build and a refused Fetch, never the raw rejection", async () => {
    state.run.mockRejectedValueOnce(new Error("build.run: forbidden: build.run needs admin"));
    render(<BuildPanel projectId="p1" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    await flush();
    expect(screen.getByText("This computer's key may not do that on its host.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("build.run");
    cleanup();
    state.remote = { branch: "master", upstream: true, ahead: 0, behind: 3, stale: false };
    state.pull.mockRejectedValueOnce(new Error("build.pull: fatal: Not possible to fast-forward, aborting.\n"));
    render(<BuildPanel projectId="p1" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await flush();
    expect(screen.getByText("Not possible to fast-forward, aborting.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("fatal");
    expect(document.body.textContent).not.toContain("build.pull");
  });

  it("builds, and cancels a running build", async () => {
    render(<BuildPanel projectId="p1" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(state.run).toHaveBeenCalledWith("p1", undefined);
    cleanup();
    state.build = { run: run({ status: "running", endedAt: undefined }), lines: [] };
    render(<BuildPanel projectId="p1" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(state.cancel).toHaveBeenCalledWith("p1");
  });

  // rightpanel-03: a key that may not build sees the log and the outputs, never Build or Cancel.
  it("offers a key that may not build no Build and no Cancel", async () => {
    state.mayBuild = false;
    try {
      render(<BuildPanel projectId="p1" />);
      await flush();
      expect(screen.queryByRole("button", { name: "Build" })).toBeNull();
      cleanup();
      state.build = { run: run({ status: "running", endedAt: undefined }), lines: [] };
      render(<BuildPanel projectId="p1" />);
      await flush();
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    } finally {
      state.mayBuild = true;
    }
  });

  // Round 2: Build and Cancel go to the host; held in place while it is away.
  it("holds Build and Cancel while the host is away", async () => {
    state.held = "The box is offline";
    try {
      render(<BuildPanel projectId="p1" />);
      await flush();
      const build = screen.getByRole("button", { name: "Build" }) as HTMLButtonElement;
      expect(build.disabled).toBe(true);
      expect(build.closest("[data-held]")).not.toBeNull();
      cleanup();
      state.build = { run: run({ status: "running", endedAt: undefined }), lines: [] };
      render(<BuildPanel projectId="p1" />);
      await flush();
      expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    } finally {
      state.held = null;
    }
  });

  it("reveals an output through the native reveal", async () => {
    state.build = {
      run: run({ outputs: [{ path: "plugin.jar", abs: "/w/plugin/plugin.jar", size: 10, mtimeMs: now, fresh: true }] }),
      lines: [],
    };
    render(<BuildPanel projectId="p1" />);
    await flush();
    fireEvent.click(document.querySelector('[data-output="plugin.jar"]') as HTMLElement);
    expect(state.invoke).toHaveBeenCalledWith("reveal_path", { path: "/w/plugin/plugin.jar" });
  });

  it("asks for Fetch only when the branch is behind origin, and fetches", async () => {
    render(<BuildPanel projectId="p1" />);
    await flush();
    expect(screen.queryByRole("button", { name: "Fetch" })).toBeNull();
    cleanup();
    state.remote = { branch: "master", upstream: true, ahead: 0, behind: 3, stale: false };
    render(<BuildPanel projectId="p1" />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await flush();
    expect(state.pull).toHaveBeenCalledWith("p1", undefined);
  });
});
