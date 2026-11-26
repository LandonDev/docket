// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AdmissionState } from "@server/shared/contract-admission";
import type { RemoteKey, RemoteStatus } from "@server/shared/contract-remote";
import type { Link } from "../../../lib/connection";

/**
 * The sections every computer's page shares (docs/agents/settings.md "The pages: computers"): each asks the computer
 * it is given and no other; a key that may only read sees words and who can; the acts that cut a link ask first.
 */

const confirms: { title: string; body?: string }[] = [];
let confirmAnswer = true;
vi.mock("../../../chrome/ConfirmDialog", async (original) => ({
  ...(await original<typeof import("../../../chrome/ConfirmDialog")>()),
  confirmAction: async (request: { title: string; body?: string }) => {
    confirms.push(request);
    return confirmAnswer;
  },
}));
const opened: unknown[] = [];
vi.mock("../../../lib/settings/addComputer", () => ({ openAddComputer: (ask: unknown) => opened.push(ask) }));

const { ThreadsRows } = await import("./ThreadsRows");
const { AgentApps, versionWords } = await import("./AgentApps");
const { SignIns } = await import("./SignIns");
const { Advanced } = await import("./Advanced");
const { ComputerGate } = await import("./read");
import type { Host } from "../parts/hostRpc";

const admission = (over: Partial<AdmissionState> = {}): AdmissionState => ({
  cap: 120,
  pinned: null,
  default: 120,
  running: 118,
  queued: 7,
  memory: { budgetMB: 81920, reserveMB: 20480, perProcessMB: 331, freeMB: 9216, floorMB: 8192 },
  ...over,
});
const status = (over: Partial<RemoteStatus> = {}): RemoteStatus => ({
  environmentId: "env_box",
  name: "box",
  enabled: true,
  port: 7677,
  configuredPort: 7677,
  running: true,
  error: null,
  origin: "https://docket.landonhale.com",
  publicOrigin: "https://docket.landonhale.com",
  learnedOrigin: null,
  contract: 1,
  stuckMinutes: 10,
  ...over,
});
const key = (over: Partial<RemoteKey> & { id: string; name: string }): RemoteKey => ({
  audience: "client",
  caps: ["read", "operate"],
  kind: "bearer",
  createdAt: 1,
  lastUsedAt: null,
  revokedAt: null,
  createdBy: "local",
  webhookUrl: null,
  events: null,
  ...over,
});

const requests: { env: string; method: string; params: unknown }[] = [];
let answers: Record<string, unknown> = {};

/** A computer as a page sees it: its own link, answering from `answers`; `may` false for anything but reading. */
function hostOf(env: string, name: string, admin = true): Host {
  const request = <T,>(method: string, params: unknown = {}): Promise<T> => {
    requests.push({ env, method, params });
    const answer = answers[`${env}:${method}`] ?? answers[method];
    return answer === undefined ? Promise.reject(new Error(`no ${method}`)) : Promise.resolve((typeof answer === "function" ? answer(params) : answer) as T);
  };
  const link = { environmentId: env, connected: true, onOpen: () => () => {}, onPush: () => () => {}, request } as unknown as Link;
  return {
    environmentId: env,
    link,
    connected: true,
    name: { name, own: env === "local" },
    may: (method) => admin || ["admission.get", "attachment.settings", "doctor.get"].includes(method),
    request,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};

afterEach(() => {
  cleanup();
  requests.length = 0;
  confirms.length = 0;
  opened.length = 0;
  confirmAnswer = true;
  answers = {};
});

describe("Threads on a computer", () => {
  it("asks that computer for the three rows and saves a change there", async () => {
    answers = {
      "admission.get": admission(),
      "remote.status": status(),
      "attachment.settings": { maxBytes: 200 * 1024 * 1024 },
      "admission.set": (params: { cap: number }) => admission({ pinned: params.cap, cap: params.cap }),
    };
    render(<ThreadsRows host={hostOf("env_box", "The box")} rows="pc" />);
    await flush();
    expect(screen.getByText("Threads on the box")).toBeTruthy();
    expect(screen.getByText("118 of 120 running, 7 waiting, the default")).toBeTruthy();
    expect((screen.getByLabelText("Minutes before a thread is stuck") as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("Largest attachment in MB") as HTMLInputElement).value).toBe("200");
    const field = screen.getByLabelText("Threads at once") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "90" } });
    fireEvent.blur(field);
    await flush();
    expect(requests.filter((r) => r.method === "admission.set")).toEqual([{ env: "env_box", method: "admission.set", params: { cap: 90 } }]);
    expect(requests.every((r) => r.env === "env_box")).toBe(true);
    expect(screen.getByText("Saved")).toBeTruthy();
    // Pinned: Use default goes back to it.
    expect(screen.getByText("Use default")).toBeTruthy();
  });

  it("puts a refused value back and says why under the row", async () => {
    answers = {
      "admission.get": admission(),
      "remote.status": status(),
      "attachment.settings": { maxBytes: 200 * 1024 * 1024 },
      "remote.settings.set": () => {
        throw new Error("refused: stuckMinutes must be under a day");
      },
    };
    render(<ThreadsRows host={hostOf("env_box", "The box")} rows="pc" />);
    await flush();
    const field = screen.getByLabelText("Minutes before a thread is stuck") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "30" } });
    fireEvent.blur(field);
    await flush();
    expect(field.value).toBe("10");
    expect(screen.getByText("StuckMinutes must be under a day")).toBeTruthy();
  });

  it("shows read-only values and who can change them, and leaves out the stuck time such a key cannot read", async () => {
    answers = { "admission.get": admission({ running: 2, cap: 6, queued: 0 }), "attachment.settings": { maxBytes: 200 * 1024 * 1024 } };
    const { container } = render(<ThreadsRows host={hostOf("env_pc", "PURDUE-LT", false)} rows="pc" />);
    await flush();
    expect(container.querySelector("input")).toBeNull();
    expect(screen.getByText("2 of 6 running, the default")).toBeTruthy();
    expect(screen.getByText("Changed from a computer that manages PURDUE-LT.")).toBeTruthy();
    expect(requests.some((r) => r.method === "remote.status")).toBe(false);
    expect(container.querySelector("[data-setting='pc.stuck']")).toBeNull();
    expect(container.textContent).not.toContain("Hidden");
  });

  it("is this Mac's page's first section under no heading", async () => {
    answers = { "admission.get": admission({ running: 2, cap: 8, queued: 0 }), "remote.status": status(), "attachment.settings": { maxBytes: 1 } };
    const { container } = render(<ThreadsRows host={hostOf("local", "MacBook Pro")} rows="here" />);
    await flush();
    expect(container.querySelector("[data-setting='here.atOnce']")).not.toBeNull();
    expect(screen.queryByText(/Threads on/)).toBeNull();
  });
});

describe("a page about one computer", () => {
  it("says once that the computer did not answer, with one Retry, and draws no section under it", async () => {
    answers = {};
    const { container } = render(
      <ComputerGate host={hostOf("env_box", "The box")}>
        <div data-section="" />
      </ComputerGate>,
    );
    await flush();
    expect(container.querySelectorAll("[data-read-failure]")).toHaveLength(1);
    expect(container.querySelector("[data-section]")).toBeNull();
  });

  it("draws its sections while its read is out and once it answers", async () => {
    answers = { "admission.get": admission() };
    const { container } = render(
      <ComputerGate host={hostOf("env_box", "The box")}>
        <div data-section="" />
      </ComputerGate>,
    );
    expect(container.querySelector("[data-section]")).not.toBeNull();
    await flush();
    expect(container.querySelector("[data-section]")).not.toBeNull();
  });
});

describe("Agent apps", () => {
  it("says each app's version, opens the rest's install commands in a sheet, and offers Update only in the computer's own window", async () => {
    answers = { "doctor.get": { claude: { found: true, version: "2.1.263 (Claude Code)" }, codex: { found: true, version: "codex-cli 0.162.1" } } };
    const { container } = render(<AgentApps host={hostOf("env_box", "The box")} rows="pc" />);
    await flush();
    expect(screen.getByText("2.1.263")).toBeTruthy();
    expect(screen.getByText("0.162.1")).toBeTruthy();
    expect(screen.queryByText("Update")).toBeNull();
    // The apps it lacks are one row; their commands are in its sheet, each behind Copy.
    expect(container.querySelector("[data-agent-app=muse]")).toBeNull();
    expect(container.querySelector("[data-setting='pc.install']")?.textContent).toContain("7 more you can install");
    fireEvent.click(screen.getByRole("button", { name: "Agent apps you can install" }));
    await flush();
    expect(document.querySelector("[data-install-sheet] [aria-label='Copy the command that installs Muse Code']")).not.toBeNull();
    expect(document.querySelector("[data-install-sheet]")?.textContent).not.toContain("curl");
    cleanup();
    render(<AgentApps host={hostOf("local", "MacBook Pro")} rows="here" />);
    await flush();
    expect(screen.getAllByText("Update")).toHaveLength(2);
  });

  it("words a version without the app's own name", () => {
    expect(versionWords("2.1.263 (Claude Code)")).toBe("2.1.263");
    expect(versionWords("codex-cli 0.153.4")).toBe("0.153.4");
  });
});

describe("Who can sign in", () => {
  it("lists keys, browsers and links in one list, and Remove… asks first, naming the last that can manage it", async () => {
    answers = {
      "remote.keys.list": [
        key({ id: "k1", name: "MacBook Pro", caps: ["read", "operate", "approve", "admin"], lastUsedAt: Date.now() - 60_000 }),
        key({ id: "k2", name: "grok", audience: "mcp" }),
      ],
      "remote.sessions.list": [],
      "remote.pairings.list": [{ id: "p1", name: "Landon's iPhone", audience: "client", caps: ["read", "operate", "approve"], createdAt: 1, expiresAt: Date.now() + 9 * 60_000, consumedAt: null, consumedBy: null }],
      "remote.keys.revoke": { ok: true },
      "remote.pairings.revoke": { ok: true },
    };
    render(<SignIns host={hostOf("env_box", "The box")} rows="pc" />);
    await flush();
    expect(screen.getByText("Who can sign in to the box")).toBeTruthy();
    expect(screen.getByText("App, manages the box, used 1m ago")).toBeTruthy();
    expect(screen.getByText("Bot, runs threads, never used")).toBeTruthy();
    expect(screen.getByText(/Sign-in link, runs threads and approves, ends in 9:0\d|Sign-in link, runs threads and approves, ends in 8:5\d/)).toBeTruthy();
    fireEvent.click(document.querySelector("[data-sign-in=k1] button")!);
    await flush();
    expect(confirms[0]).toEqual(expect.objectContaining({ title: "Remove MacBook Pro?", body: "It must sign in again to come back. It is the last device that can manage the box." }));
    expect(requests.filter((r) => r.method.endsWith("revoke"))).toEqual([{ env: "env_box", method: "remote.keys.revoke", params: { id: "k1" } }]);
    fireEvent.click(screen.getByText("Cancel the link"));
    await flush();
    expect(requests.filter((r) => r.method === "remote.pairings.revoke")).toEqual([{ env: "env_box", method: "remote.pairings.revoke", params: { id: "p1" } }]);
    fireEvent.click(screen.getByText("Add…"));
    expect(opened).toEqual([{ way: "device", computer: "env_box" }]);
  });

  it("marks this window's own key, and says this window loses the computer when it is removed", async () => {
    const { registry } = await import("../../../lib/connection");
    const { IDLE_STATUS } = await import("../../../lib/connection/types");
    const was = registry.statusOf;
    const mine = { ...IDLE_STATUS, transport: "open" as const, lastHello: { environmentId: "env_box", contract: 1, caps: ["admin" as const], key: { id: "k1", name: "MacBook Pro" } } };
    Object.assign(registry, { statusOf: (id: string) => (id === "env_box" ? mine : was.call(registry, id)) });
    answers = {
      "remote.keys.list": [key({ id: "k1", name: "MacBook Pro", caps: ["read", "operate", "approve", "admin"] }), key({ id: "k2", name: "iPhone", caps: ["read", "operate", "approve", "admin"] })],
      "remote.sessions.list": [],
      "remote.pairings.list": [],
      "remote.keys.revoke": { ok: true },
    };
    try {
      render(<SignIns host={hostOf("env_box", "The box")} rows="pc" />);
      await flush();
      expect(document.querySelector("[data-sign-in=k1]")?.hasAttribute("data-own")).toBe(true);
      expect(document.querySelector("[data-sign-in=k1]")?.textContent).toContain("MacBook Pro this Mac");
      expect(document.querySelector("[data-sign-in=k2]")?.hasAttribute("data-own")).toBe(false);
      fireEvent.click(document.querySelector("[data-sign-in=k1] button")!);
      await flush();
      expect(confirms.at(-1)).toEqual(expect.objectContaining({ title: "Remove MacBook Pro?", body: "This Mac loses the box until it signs in again." }));
    } finally {
      Object.assign(registry, { statusOf: was });
    }
  });

  it("keeps a device he chose to keep", async () => {
    confirmAnswer = false;
    answers = { "remote.keys.list": [key({ id: "k1", name: "iPhone" })], "remote.sessions.list": [], "remote.pairings.list": [] };
    render(<SignIns host={hostOf("env_box", "The box")} rows="pc" />);
    await flush();
    fireEvent.click(screen.getByText("Remove…"));
    await flush();
    expect(requests.some((r) => r.method.endsWith("revoke"))).toBe(false);
  });

  it("tells a key that may not manage the computer who can, and asks for no list", async () => {
    render(<SignIns host={hostOf("env_box", "The box", false)} rows="pc" />);
    await flush();
    expect(screen.getByText("Changed from a computer that manages the box.")).toBeTruthy();
    expect(screen.queryByText("Add…")).toBeNull();
    expect(requests).toEqual([]);
  });
});

describe("Advanced", () => {
  it("asks first before turning off the listener a page reaches the computer by", async () => {
    answers = { "remote.status": status(), "remote.settings.set": (patch: Partial<RemoteStatus>) => status(patch) };
    render(<Advanced host={hostOf("env_box", "The box")} rows="pc" />);
    await flush();
    fireEvent.click(screen.getByLabelText("Let other devices reach the box"));
    await flush();
    expect(confirms[0]).toEqual(expect.objectContaining({ title: "Stop other devices reaching the box?", body: "This page loses the computer until it can be reached again." }));
    expect(requests.filter((r) => r.method === "remote.settings.set")).toEqual([{ env: "env_box", method: "remote.settings.set", params: { enabled: false } }]);
  });

  it("moves no port he chose to keep", async () => {
    confirmAnswer = false;
    answers = { "remote.status": status() };
    render(<Advanced host={hostOf("env_box", "The box")} rows="pc" />);
    await flush();
    const field = screen.getByLabelText("Port") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "8000" } });
    fireEvent.blur(field);
    await flush();
    expect(confirms).toHaveLength(1);
    expect(field.value).toBe("7677");
    expect(requests.some((r) => r.method === "remote.settings.set")).toBe(false);
  });

  it("changes this Mac's own listener without asking: its page does not go through it", async () => {
    answers = { "remote.status": status({ environmentId: "env_mac" }), "remote.settings.set": (patch: Partial<RemoteStatus>) => status(patch) };
    render(<Advanced host={hostOf("local", "MacBook Pro")} rows="sharing" />);
    await flush();
    fireEvent.click(screen.getByLabelText("Let other devices reach this Mac"));
    await flush();
    expect(confirms).toEqual([]);
    expect(requests.filter((r) => r.method === "remote.settings.set")).toHaveLength(1);
  });
});

describe("this window's own sign-in", () => {
  it("is the key it signed in with, or for a browser the newest session on that key", async () => {
    const { signInsOf } = await import("./words");
    const session = (id: string, lastSeenAt: number) => ({ id, keyId: "kb", keyName: "PURDUE-LT", caps: ["read" as const], userAgent: "Chrome/131.0", createdAt: 1, lastSeenAt, expiresAt: 9e12 });
    const rows = signInsOf({ keys: [key({ id: "k1", name: "MacBook Pro" })], sessions: [session("s1", 10), session("s2", 20)], pairings: [] }, "the box", 100, "kb");
    expect(rows.filter((r) => r.kind !== "link" && r.own).map((r) => r.id)).toEqual(["s2"]);
    expect(signInsOf({ keys: [key({ id: "k1", name: "MacBook Pro" })], sessions: [], pairings: [] }, "the box", 100, "k1")[0]).toEqual(expect.objectContaining({ own: true }));
  });
});
