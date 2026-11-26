// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const update = vi.hoisted(() => ({ snapshot: { phase: "idle", currentVersion: "1.0.300" } as Record<string, unknown> }));
vi.mock("../../lib/updateStore", () => ({
  updateStore: { install: vi.fn(), check: vi.fn() },
  useUpdateSnapshot: () => update.snapshot,
}));
vi.mock("../chunks", () => ({ releaseNotesChunk: { intent: {} } }));
vi.mock("../../lib/native", async (original) => ({ ...(await original<typeof import("../../lib/native")>()), openUrl: vi.fn() }));
vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));

/** This window's computer: its quick-update settings. */
const host = vi.hoisted(() => ({
  code: { host: "env_box", hosts: [{ id: "env_box", name: "The box" }], cannot: null } as Record<string, unknown>,
  refuse: null as string | null,
  read: "answers" as "answers" | "pending" | "refused",
  calls: [] as { method: string; params: unknown }[],
  deploy: null as Record<string, unknown> | null,
  /** The deploy status read never answers. */
  deployPending: false,
  /** What admission.get answers; null refuses it. */
  admission: null as { running: number } | null,
}));
vi.mock("../../lib/hostJobs", async (original) => {
  const real = await original<typeof import("../../lib/hostJobs")>();
  return {
    ...real,
    // The deploy store's own registry is not this test's: its read and its start answer from `host`.
    refreshDeployStatus: async (id: string) => {
      if (host.deployPending) return new Promise(() => {});
      // As the real store does: a failed read is null.
      real.hostJobsStore.setState((s) => ({ deploy: { ...s.deploy, [id]: (host.deploy ?? null) as never } }));
      return host.deploy;
    },
    startDeploy: async (id: string) => void host.calls.push({ method: "host.deploy", params: { id } }),
  };
});
const confirms = vi.hoisted(() => ({ asked: [] as { title: string }[], answer: true }));
vi.mock("../../chrome/ConfirmDialog", async (original) => ({
  ...(await original<typeof import("../../chrome/ConfirmDialog")>()),
  confirmAction: async (request: { title: string }) => {
    confirms.asked.push(request);
    return confirms.answer;
  },
}));
const link = vi.hoisted(() => ({
  environmentId: "local",
  connected: true,
  onOpen: () => () => {},
  request: async (method: string, params: unknown) => {
    host.calls.push({ method, params });
    if (method === "code.settings.get" && host.read === "pending") return new Promise(() => {});
    if (method === "code.settings.get" && host.read === "refused") throw new Error("The computer did not answer");
    if (method === "code.settings.get") return host.code;
    if (method === "host.deployStatus" && host.deploy) return host.deploy;
    if (method === "host.deploy") return { ...host.deploy, phase: "running" };
    if (method === "admission.get" && host.admission) return { running: host.admission.running, cap: 8, queued: 0 };
    if (method === "code.settings.set") {
      if (host.refuse) throw new Error(host.refuse);
      host.code = { ...host.code, host: (params as { host: string | null }).host };
      return host.code;
    }
    throw new Error(`no ${method}`);
  },
}));
const computers = vi.hoisted(() => ({
  list: [] as { id: string; name: string }[],
  hello: {} as Record<string, { build?: { release: number; version: string } } | undefined>,
}));
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<typeof import("../../lib/connection")>()),
  registry: { primary: () => link, link: () => link, linkOf: () => link, primaryEnvironmentId: "local" },
  useEnvironments: () => [{ id: "local", name: "This Mac" }, ...computers.list],
  useEnvironmentStatus: (id: string) => ({ transport: computers.hello[id] ? "open" : "closed", lastHello: computers.hello[id] }),
}));
vi.mock("../../lib/connection/status", async (original) => ({
  ...(await original<typeof import("../../lib/connection/status")>()),
  useEnvironmentStatus: (id: string) => ({ transport: computers.hello[id] ? "open" : "closed", lastHello: computers.hello[id] }),
}));
vi.mock("../../lib/settings/computerName", async (original) => ({
  ...(await original<typeof import("../../lib/settings/computerName")>()),
  useComputerNames: () => (id: string) => ({ name: computers.list.find((c) => c.id === id)?.name ?? id, own: id === "local" }),
}));
const asked = vi.hoisted(() => ({ settings: [] as unknown[][] }));
vi.mock("../../lib/monaco/debugTab", () => ({ requestSettings: (...args: unknown[]) => asked.settings.push(args) }));

const { UpdatesPage, updateActionLabel, versionWords } = await import("./Updates");
const real = await import("../../lib/hostJobs");
const { resetDeployDriftForTest } = await import("../../lib/deployDrift");

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

const choose = async (label: string, name: string): Promise<void> => {
  fireEvent.click(screen.getByLabelText(label));
  await flush();
  const option = await screen.findByRole("option", { name });
  fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
  fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 });
  fireEvent.mouseUp(option, { button: 0 });
  fireEvent.click(option);
  await flush();
};

beforeEach(() => {
  update.snapshot = { phase: "idle", currentVersion: "1.0.300", canApply: true };
  host.code = { host: "env_box", hosts: [{ id: "env_box", name: "The box" }], cannot: null };
  host.refuse = null;
  host.read = "answers";
  host.calls = [];
  computers.list = [];
  computers.hello = {};
  asked.settings = [];
  resetDeployDriftForTest(null);
});
afterEach(cleanup);

const page = (open = vi.fn()) => render(<UpdatesPage onOpenWhatsNew={open} />);
const versionRow = () => document.querySelector('[data-setting="updates.version"]') as HTMLElement;

describe("Updates", () => {
  it("names the release action for each updater phase", () => {
    const plain = { canApply: true, retry: false };
    expect(updateActionLabel("idle", plain)).toBe("Check for updates");
    expect(updateActionLabel("available", plain)).toBe("Update");
    expect(updateActionLabel("available", { canApply: false, retry: false })).toBe("Check for updates");
    expect(updateActionLabel("ready", plain)).toBe("Restart");
    expect(updateActionLabel("error", { canApply: true, retry: true })).toBe("Retry");
  });

  it("titles its first row Docket and the version, with one updater button in every phase", async () => {
    const phases: Record<string, unknown>[] = [
      { phase: "idle", currentVersion: "1.0.300", canApply: true },
      { phase: "checking", currentVersion: "1.0.300", canApply: true },
      { phase: "available", currentVersion: "1.0.300", availableVersion: "1.0.301", canApply: true },
      { phase: "downloading", currentVersion: "1.0.300", availableVersion: "1.0.301", percent: 10, canApply: true },
      { phase: "ready", currentVersion: "1.0.300", availableVersion: "1.0.301", canApply: true },
    ];
    for (const snapshot of phases) {
      update.snapshot = snapshot;
      page();
      await flush();
      expect(versionRow().querySelector("[data-slot=item-title]")?.textContent).toBe("Docket 1.0.300");
      expect(versionRow().querySelectorAll("button")).toHaveLength(1);
      cleanup();
    }
    update.snapshot = { phase: "ready", currentVersion: "1.0.300", availableVersion: "1.0.301", canApply: true };
    page();
    await flush();
    expect(screen.getByRole("button", { name: "Restart" }).dataset.variant).toBe("default");
  });

  it("claims nothing of the build until the updater has read its version: the row's shape", async () => {
    update.snapshot = { phase: "idle", currentVersion: "…" };
    page();
    await flush();
    expect(versionRow()).toBeNull();
    expect(document.body.textContent).not.toContain("Up to date");
    expect(document.querySelector('[data-slot=page-row-skeleton] [data-skeleton-control]')).toBeTruthy();
  });

  it("reserves the download label before Update starts", async () => {
    update.snapshot = { phase: "available", currentVersion: "1.0.300", availableVersion: "1.0.301", canApply: true };
    page();
    await flush();
    const button = screen.getByRole("button", { name: "Update" });
    expect(button.querySelector("[data-slot=busy-label]")?.getAttribute("data-busy-text")).toBe("Check for updates");
  });

  it("ends a failed update's line with a link to the installer", async () => {
    update.snapshot = { phase: "error", currentVersion: "1.0.300", error: "The signature did not match.", canApply: true };
    page();
    await flush();
    const native = await import("../../lib/native");
    const link = screen.getByRole("button", { name: "Download the installer" });
    expect(link.closest("[class*=text-destructive]")?.textContent).toContain("The signature did not match.");
    fireEvent.click(link);
    expect(native.openUrl).toHaveBeenCalled();
  });

  it("names a ready quick update and restarts into it", async () => {
    update.snapshot = { phase: "ready", currentVersion: "1.0.300 + 3f9c2ab", codeSubject: "Fix the rail's spacing", canApply: true };
    page();
    await flush();
    expect(screen.getByText("Quick update: Fix the rail's spacing. Restart to finish.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    const store = await import("../../lib/updateStore");
    expect(store.updateStore.install).toHaveBeenCalled();
  });

  it("shows the download's progress", async () => {
    update.snapshot = { phase: "downloading", currentVersion: "1.0.300", availableVersion: "1.0.301", percent: 40, canApply: true };
    page();
    await flush();
    expect(screen.getByRole("progressbar", { name: "Download" }).getAttribute("aria-valuenow")).toBe("40");
  });

  it("opens the bundled release notes, or a waiting update's from the feed", async () => {
    const open = vi.fn();
    page(open);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(open).toHaveBeenCalledWith(expect.any(String), expect.anything());
    cleanup();
    open.mockClear();
    update.snapshot = { phase: "available", currentVersion: "1.0.300", availableVersion: "1.0.301", notes: "Faster.", canApply: true };
    page(open);
    await flush();
    expect(screen.getByText("For 1.0.301")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(open).toHaveBeenCalledWith("1.0.301", "Faster.");
  });

  describe("Quick updates from", () => {
    it("shows the chosen computer, says each runs after a restart, and writes code.settings.set with the save mark", async () => {
      page();
      await flush();
      const row = document.querySelector('[data-setting="updates.quick"]') as HTMLElement;
      expect(row.textContent).toContain("Each runs after a restart.");
      expect(screen.getByLabelText("Quick updates from").textContent).toContain("The box");
      await choose("Quick updates from", "Off");
      expect(host.calls).toContainEqual({ method: "code.settings.set", params: { host: null } });
      expect(row.querySelector("[data-slot=save-mark]")?.getAttribute("data-state")).toBe("saved");
    });

    it("snaps back and says why on a refusal", async () => {
      host.refuse = "refused: loopback only";
      page();
      await flush();
      await choose("Quick updates from", "Off");
      expect(screen.getByLabelText("Quick updates from").textContent).toContain("The box");
      expect(document.querySelector('[data-setting="updates.quick"] [class*=text-destructive]')).toBeTruthy();
    });

    it("holds its shape while asked, and says a refused read once with Retry, never as a build that cannot", async () => {
      host.read = "pending";
      page();
      await flush();
      expect(document.querySelectorAll("[data-slot=page-row-skeleton]")).toHaveLength(1);
      cleanup();
      host.read = "refused";
      page();
      await flush();
      expect(screen.getAllByRole("alert").map((line) => line.textContent)).toEqual(["This Mac did not answer."]);
      host.read = "answers";
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
      await flush();
      expect(document.querySelector('[data-setting="updates.quick"]')).toBeTruthy();
    });

    it("draws no row where quick updates cannot come", async () => {
      for (const code of [{ host: "env_box", hosts: [{ id: "env_box", name: "The box" }], cannot: "a dev build" }, { host: null, hosts: [], cannot: null }]) {
        host.code = code;
        page();
        await flush();
        expect(document.querySelector('[data-setting="updates.quick"]')).toBeNull();
        cleanup();
      }
    });
  });

  describe("Other computers", () => {
    it("lists each linked computer with its version, and opens its page at its version", async () => {
      resetDeployDriftForTest({ release: 399, version: "1.0.399" } as never);
      computers.list = [
        { id: "env_box", name: "The box" },
        { id: "env_pc", name: "PURDUE-LT" },
      ];
      computers.hello = { env_box: { build: { release: 397, version: "1.0.397" } } };
      page();
      await flush();
      const section = screen.getByRole("region", { name: "Other computers" });
      expect(section.textContent).toContain("1.0.397, 2 releases behind");
      expect(section.textContent).toContain("PURDUE-LT");
      expect(section.textContent).toContain("Offline");
      expect(section.querySelectorAll("[data-slot=open-cue]")).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "The box" }));
      expect(asked.settings).toContainEqual(["computer:env_box", "pc.version"]);
    });

    it("ends a behind computer's row in Update…, with its page's one confirm", async () => {
      resetDeployDriftForTest({ release: 399, version: "1.0.399" } as never);
      computers.list = [{ id: "env_box", name: "The box" }];
      computers.hello = { env_box: { build: { release: 397, version: "1.0.397" } } };
      host.deploy = { job: "deploy", phase: "idle", installed: true, installHint: "", version: "1.0.397", target: null, startedAt: null, finishedAt: null, exit: null, stoppable: false };
      try {
        page();
        for (let i = 0; i < 6; i++) await flush();
        const section = screen.getByRole("region", { name: "Other computers" });
        // The row's press is Update…, not the chevron.
        expect(section.querySelectorAll("[data-slot=open-cue]")).toHaveLength(0);
        fireEvent.click(screen.getByRole("button", { name: "Update…" }));
        await flush();
        expect(confirms.asked.at(-1)).toEqual(expect.objectContaining({ title: "Update The box?" }));
        expect(host.calls.some((c) => c.method === "host.deploy")).toBe(true);
      } finally {
        host.deploy = null;
      }
    });

    it("asks only once it has read how many threads run there, and says they may pause when it could not", async () => {
      resetDeployDriftForTest({ release: 399, version: "1.0.399" } as never);
      computers.list = [{ id: "env_box", name: "The box" }];
      computers.hello = { env_box: { build: { release: 397, version: "1.0.397" } } };
      host.deploy = { job: "deploy", phase: "idle", installed: true, installHint: "", version: "1.0.397", target: null, startedAt: null, finishedAt: null, exit: null, stoppable: false };
      confirms.answer = false;
      try {
        page();
        for (let i = 0; i < 6; i++) await flush();
        host.admission = { running: 3 };
        fireEvent.click(screen.getByRole("button", { name: "Update…" }));
        for (let i = 0; i < 3; i++) await flush();
        expect(host.calls.filter((c) => c.method === "admission.get")).toHaveLength(1);
        expect((confirms.asked.at(-1) as unknown as { body: string }).body).toContain("3 running threads pause about a minute.");
        host.admission = null;
        fireEvent.click(screen.getByRole("button", { name: "Update…" }));
        for (let i = 0; i < 3; i++) await flush();
        expect((confirms.asked.at(-1) as unknown as { body: string }).body).toContain("Running threads may pause about a minute.");
      } finally {
        host.deploy = null;
        host.admission = null;
        confirms.answer = true;
      }
    });

    it("ends the row in a button's bone while its update status is read, never a chevron", async () => {
      real.hostJobsStore.setState({ deploy: {} });
      resetDeployDriftForTest({ release: 399, version: "1.0.399" } as never);
      computers.list = [{ id: "env_box", name: "The box" }];
      computers.hello = { env_box: { build: { release: 397, version: "1.0.397" } } };
      host.deployPending = true;
      try {
        page();
        for (let i = 0; i < 4; i++) await flush();
        const row = screen.getByRole("region", { name: "Other computers" }).querySelector("[data-computer=env_box]")!;
        expect(row.querySelector("[data-skeleton-control]")).not.toBeNull();
        expect(row.querySelector("[data-slot=open-cue]")).toBeNull();
      } finally {
        host.deployPending = false;
      }
    });

    it("is absent with no other computer", async () => {
      page();
      await flush();
      expect(screen.queryByRole("region", { name: "Other computers" })).toBeNull();
    });

    it("says how far behind in words", () => {
      expect(versionWords("1.0.399", 0, true)).toBe("1.0.399, up to date");
      expect(versionWords("1.0.398", 1, true)).toBe("1.0.398, 1 release behind");
      expect(versionWords(null, null, false)).toBe("Offline");
      expect(versionWords("1.0.398", null, false)).toBe("1.0.398, offline");
    });
  });
});
