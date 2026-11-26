// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectModalShape } from "../../chrome/modalShape.testkit";

const linear = vi.hoisted(() => ({
  connected: false,
  pending: null as null | Promise<{ connected: boolean }>,
  save: vi.fn(),
  disconnect: vi.fn(async () => ({ connected: false })),
  teams: [] as { id: string; name: string; key: string }[],
}));
vi.mock("../../lib/linear", async (original) => ({
  ...(await original<typeof import("../../lib/linear")>()),
  linearConnected: () => linear.pending ?? Promise.resolve({ connected: linear.connected }),
  saveLinearToken: (...args: unknown[]) => linear.save(...args),
  disconnectLinear: () => linear.disconnect(),
  listLinearTeams: async () => linear.teams,
  notifyLinearChange: vi.fn(),
}));

/** The computer's answers: Keep awake's read and write. */
const host = vi.hoisted(() => ({
  power: { mode: "while-working", supported: true, holding: false, onBattery: false } as Record<string, unknown>,
  refuse: null as string | null,
  calls: [] as { method: string; params: unknown }[],
}));
const link = vi.hoisted(() => ({
  environmentId: "local",
  connected: true,
  onOpen: () => () => {},
  request: async (method: string, params: unknown) => {
    host.calls.push({ method, params });
    if (method === "power.status") return host.power;
    if (method === "power.settings.set") {
      if (host.refuse) throw new Error(host.refuse);
      host.power = { ...host.power, mode: (params as { keepAwake: string }).keepAwake };
      return host.power;
    }
    throw new Error(`no ${method}`);
  },
}));
vi.mock("../../lib/connection", async (original) => ({ ...(await original<typeof import("../../lib/connection")>()), registry: { primary: () => link, primaryEnvironmentId: "local" } }));
vi.mock("../../lib/settings/computerName", async (original) => ({
  ...(await original<typeof import("../../lib/settings/computerName")>()),
  useComputerName: () => ({ name: "MacBook Pro", own: true }),
}));
vi.mock("../../lib/githubTasks", () => ({ clearInboxCache: vi.fn() }));
vi.mock("../../lib/sounds", async (original) => ({ ...(await original<typeof import("../../lib/sounds")>()), playCue: vi.fn() }));
const probe = vi.hoisted(() => ({ answer: "installed" as "installed" | "none" | "pending" | "refused", reads: 0 }));
vi.mock("../../lib/harness/availability", () => ({
  readHarnessAvailability: () => {
    probe.reads += 1;
    if (probe.answer === "pending") return new Promise(() => {});
    if (probe.answer === "refused") return Promise.reject(new Error("doctor.get failed: no handler"));
    const on = probe.answer === "installed";
    return Promise.resolve({ claude: on, codex: on, cursor: false, grok: false, opencode: false, pi: false, omp: false, fx: false, muse: false });
  },
}));
vi.mock("../../chrome/HarnessIcon", () => ({ HarnessIcon: () => <svg /> }));
const web = vi.hoisted(() => ({ on: false }));
vi.mock("../../lib/native", async (original) => ({ ...(await original<typeof import("../../lib/native")>()), isWebMode: () => web.on }));
vi.mock("../../components/choice-select", async () => await import("../../components/choice-select-body"));

const { GeneralPage } = await import("./General");
const { ConfirmHost } = await import("../../chrome/ConfirmDialog");

function mockLocalStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
  });
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

/** Picks `name` in the select labelled `label`. */
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
  mockLocalStorage();
  linear.connected = false;
  linear.pending = null;
  linear.teams = [];
  linear.save.mockReset();
  linear.disconnect.mockClear();
  host.power = { mode: "while-working", supported: true, holding: false, onBattery: false };
  host.refuse = null;
  host.calls = [];
  probe.answer = "installed";
  probe.reads = 0;
  web.on = false;
});
afterEach(cleanup);

const page = () =>
  render(
    <>
      <GeneralPage />
      <ConfirmHost />
    </>,
  );

describe("General", () => {
  it("lays its sections out in order, with no About: the version is Updates'", async () => {
    page();
    await flush();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Transcript", "Composer", "Sounds and power", "Inbox"]);
    expect(screen.queryByText("Release notes")).toBeNull();
  });

  it("writes each row kept in this window to its own key at once, with no save mark", async () => {
    page();
    await flush();
    fireEvent.click(screen.getByRole("switch", { name: "Keep my prompt at the top" }));
    expect(localStorage.getItem("docket.transcriptAnchor")).not.toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Sounds" }));
    expect(localStorage.getItem("docket.sounds")).toBe("0");
    await choose("Enter while a thread is working", "Queue");
    expect(localStorage.getItem("docket.midTurnDefault")).toBe("queue");
    expect(document.querySelector('[data-setting="general.sounds"] [data-slot=save-mark]')).toBeNull();
  });

  it("offers Steer first and says what each does", async () => {
    page();
    await flush();
    expect(screen.getByText(/Steer sends into the running turn, Queue waits for it\./)).toBeTruthy();
  });

  describe("Model picker shows", () => {
    it("names the agent apps shown, and opens a dialog of a switch each that writes the hidden list", async () => {
      page();
      await flush();
      const row = document.querySelector('[data-setting="general.picker"]') as HTMLElement;
      expect(row.textContent).toContain("Claude Code and Codex");
      fireEvent.click(within(row).getByRole("button", { name: "Model picker shows" }));
      const dialog = await screen.findByRole("dialog", { name: "Model picker shows" });
      expectModalShape(dialog, { cancel: false });
      const switches = within(dialog).getAllByRole("switch");
      expect(switches).toHaveLength(2);
      fireEvent.click(switches[0]!);
      expect(JSON.parse(localStorage.getItem("docket.hiddenPickerProviders") ?? "[]")).toEqual(["claude"]);
      expect(row.textContent).toContain("Codex");
      expect(row.textContent).not.toContain("Claude Code");
    });

    it("holds the dialog's rows in their shape until the computer answers", async () => {
      probe.answer = "pending";
      page();
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "Model picker shows" }));
      const dialog = await screen.findByRole("dialog", { name: "Model picker shows" });
      expect(within(dialog).queryAllByRole("switch")).toHaveLength(0);
      expect([...dialog.querySelectorAll<HTMLElement>("[data-slot=page-row-skeleton]")].map((r) => r.dataset.control)).toEqual(["switch", "switch"]);
    });

    it("says a refused read with Retry in the dialog, never as if no agent app were installed", async () => {
      probe.answer = "refused";
      page();
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "Model picker shows" }));
      const dialog = await screen.findByRole("dialog", { name: "Model picker shows" });
      expect((await within(dialog).findByRole("alert")).textContent).toBe("doctor.get failed: no handler");
      probe.answer = "installed";
      fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
      expect(await within(dialog).findAllByRole("switch")).toHaveLength(2);
      expect(probe.reads).toBe(2);
    });

    it("leaves the row out only when the computer answered with none", async () => {
      probe.answer = "none";
      page();
      await flush();
      expect(document.querySelector('[data-setting="general.picker"]')).toBeNull();
    });
  });

  describe("Keep this Mac awake", () => {
    it("asks this computer, says On now while held, and writes power.settings.set with the save mark", async () => {
      host.power = { ...host.power, holding: true };
      page();
      await flush();
      const row = document.querySelector('[data-setting="general.awake"]') as HTMLElement;
      expect(row.querySelector("[data-slot=item-title]")?.textContent).toBe("Keep this Mac awake");
      expect(row.textContent).toContain("On now");
      await choose("Keep this Mac awake", "Never");
      expect(host.calls).toContainEqual({ method: "power.settings.set", params: { keepAwake: "never" } });
      expect(row.querySelector("[data-slot=save-mark]")?.getAttribute("data-state")).toBe("saved");
    });

    it("snaps back and says why when the computer refuses", async () => {
      host.refuse = "forbidden: power.settings.set needs admin";
      page();
      await flush();
      await choose("Keep this Mac awake", "Never");
      const row = document.querySelector('[data-setting="general.awake"]') as HTMLElement;
      expect(row.querySelector("[class*=text-destructive]")?.textContent).toBeTruthy();
      expect(screen.getByLabelText("Keep this Mac awake").textContent).toContain("While threads work");
    });

    it("is absent where the computer cannot, and at /ui", async () => {
      host.power = { ...host.power, supported: false };
      page();
      await flush();
      expect(document.querySelector('[data-setting="general.awake"]')).toBeNull();
      cleanup();
      host.power = { ...host.power, supported: true };
      web.on = true;
      host.calls = [];
      page();
      await flush();
      expect(document.querySelector('[data-setting="general.awake"]')).toBeNull();
      expect(host.calls.some((call) => call.method === "power.status")).toBe(false);
    });
  });

  describe("Linear", () => {
    it("connects in a dialog: Enter checks the key, a refusal stays in the dialog", async () => {
      let refuse: (error: Error) => void = () => {};
      linear.save.mockReturnValue(new Promise((_, reject) => (refuse = reject)));
      page();
      await flush();
      expect(screen.queryByLabelText("API key")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Connect…" }));
      const field = await screen.findByLabelText("API key");
      expectModalShape(screen.getByRole("dialog", { name: "Connect Linear" }));
      fireEvent.change(field, { target: { value: "lin_api_x" } });
      fireEvent.keyDown(field, { key: "Enter" });
      expect(linear.save).toHaveBeenCalledWith("local", "lin_api_x");
      await act(async () => refuse(new Error("That key was refused.")));
      expect(screen.getByText("That key was refused.").className).toContain("text-destructive");
      expect(screen.getByRole("dialog", { name: "Connect Linear" })).toBeTruthy();
    });

    it("names its computer once connected, and Disconnect… asks first with what stops working", async () => {
      linear.save.mockResolvedValue(undefined);
      page();
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "Connect…" }));
      fireEvent.change(await screen.findByLabelText("API key"), { target: { value: "lin_api_x" } });
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Connect" })));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(screen.getByText("Connected on this Mac")).toBeTruthy();
      const disconnect = screen.getByRole("button", { name: "Disconnect…" });
      expect(disconnect.dataset.variant).toBe("ghost");
      fireEvent.click(disconnect);
      const confirm = await screen.findByRole("alertdialog");
      expect(confirm.textContent).toContain("The inbox stops showing Linear issues");
      expect(linear.disconnect).not.toHaveBeenCalled();
      await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Disconnect" })));
      await flush();
      expect(linear.disconnect).toHaveBeenCalledOnce();
      await waitFor(() => expect(screen.getByRole("button", { name: "Connect…" })).toBeTruthy());
    });

    it("counts the teams shown and opens a dialog of a switch each, writing the hidden list", async () => {
      linear.connected = true;
      linear.teams = [
        { id: "t1", name: "Core", key: "COR" },
        { id: "t2", name: "Web", key: "WEB" },
      ];
      localStorage.setItem("docket.linearHiddenTeams", JSON.stringify(["t2"]));
      page();
      await flush();
      const row = document.querySelector('[data-setting="general.linearTeams"]') as HTMLElement;
      expect(row.textContent).toContain("1 of 2");
      fireEvent.click(within(row).getByRole("button", { name: "Linear teams in the inbox" }));
      const dialog = await screen.findByRole("dialog", { name: "Linear teams in the inbox" });
      expect(within(dialog).getByRole("switch", { name: "Core" }).getAttribute("aria-checked")).toBe("true");
      const web = within(dialog).getByRole("switch", { name: "Web" });
      expect(web.getAttribute("aria-checked")).toBe("false");
      fireEvent.click(web);
      expect(JSON.parse(localStorage.getItem("docket.linearHiddenTeams") ?? "[]")).toEqual([]);
      expect(row.textContent).toContain("2 of 2");
    });

    it("holds the row in its shape until the computer says whether it is connected", async () => {
      let answer: (status: { connected: boolean }) => void = () => {};
      linear.pending = new Promise((resolve) => (answer = resolve));
      page();
      const section = screen.getByRole("region", { name: "Inbox" });
      expect(section.querySelector("[data-slot=page-row-skeleton]")).toBeTruthy();
      await act(async () => answer({ connected: true }));
      expect(screen.getByRole("button", { name: "Disconnect…" })).toBeTruthy();
    });

    it("never offers Connect… when the read fails: the error and Retry, which asks again", async () => {
      linear.pending = Promise.reject(new Error("The host did not answer"));
      linear.pending.catch(() => {});
      linear.connected = true;
      page();
      await flush();
      const section = screen.getByRole("region", { name: "Inbox" });
      expect(screen.queryByRole("button", { name: "Connect…" })).toBeNull();
      expect(section.querySelector("[role=alert]")?.textContent).toBe("The host did not answer");
      linear.pending = null;
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
      expect(screen.getByRole("button", { name: "Disconnect…" })).toBeTruthy();
    });
  });
});
