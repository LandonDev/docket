// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { registry, type Link } from "../../../lib/connection";
import { IDLE_STATUS, type EnvironmentStatus } from "../../../lib/connection/types";

/**
 * Another computer's page (docs/agents/settings.md "The pages: computers"): its rows ask that computer over its own
 * link and write nowhere else; a key that may only read sees words; its line says how this window reaches it; Work
 * leads to the Work page's switch; Forget… asks first and drops only this Mac's record.
 */

const confirms: { title: string; body?: string }[] = [];
vi.mock("../../../chrome/ConfirmDialog", async (original) => ({
  ...(await original<typeof import("../../../chrome/ConfirmDialog")>()),
  confirmAction: async (request: { title: string; body?: string }) => {
    confirms.push(request);
    return true;
  },
}));
const asked: unknown[][] = [];
vi.mock("../../../lib/monaco/debugTab", async (original) => ({
  ...(await original<typeof import("../../../lib/monaco/debugTab")>()),
  requestSettings: (...args: unknown[]) => asked.push(args),
}));
vi.mock("../../../lib/devicesClient", () => ({ readComputers: async () => ({ giver: null, box: null, computers: [] }), onDevicesPush: () => () => {}, actOnComputer: async () => ({ ok: true }) }));
vi.mock("../../../lib/tcserver/link", async (original) => ({ ...(await original<typeof import("../../../lib/tcserver/link")>()), loadSavedEnvironments: async () => {} }));

const { ComputerLine, OtherComputerPage, behindWords, computerLineWords } = await import("./ComputerPage");

const admission = { cap: 120, pinned: null, default: 120, running: 118, queued: 7, memory: { budgetMB: 1, reserveMB: 1, perProcessMB: 1, freeMB: 1, floorMB: 1 } };
const status = { environmentId: "env_box", name: "box", enabled: true, port: 7677, configuredPort: 7677, running: true, error: null, origin: "https://d.example", publicOrigin: "", learnedOrigin: null, contract: 1, stuckMinutes: 10 };
const ANSWERS: Record<string, Record<string, unknown>> = {
  env_box: {
    "admission.get": admission,
    "admission.set": { ...admission, pinned: 90, cap: 90 },
    "remote.status": status,
    "attachment.settings": { maxBytes: 200 * 1024 * 1024 },
    "doctor.get": { claude: { found: true, version: "2.4.1" } },
    "remote.keys.list": [],
    "remote.sessions.list": [],
    "remote.pairings.list": [],
    "host.deployStatus": { phase: "idle", installed: true, installHint: "", version: "1.0.397" },
  },
  local: {
    "remote.environments.list": [{ id: "env_box", name: "The box", routes: [{ url: "wss://d.example/ws", kind: "tunnel" }], addedAt: 1, caps: ["admin"], keyName: "Mac" }],
    "remote.environments.remove": { ok: true },
    "remote.environments.update": { ok: true },
    "macBridge.policy.get": [],
  },
};
const requests: { env: string; method: string; params: unknown }[] = [];
let hello: { caps: string[]; key?: unknown } | null = null;
let transport: EnvironmentStatus["transport"] = "open";

function linkFor(env: string): Link {
  return {
    environmentId: env,
    connected: true,
    onOpen: () => () => {},
    onPush: () => () => {},
    request: (method: string, params: unknown) => {
      requests.push({ env, method, params });
      const answer = ANSWERS[env]?.[method];
      return answer === undefined ? Promise.reject(new Error(`no ${method}`)) : Promise.resolve(answer);
    },
  } as unknown as Link;
}
const links = { local: linkFor("local"), env_box: linkFor("env_box"), env_pc: linkFor("env_pc") } as Record<string, Link>;

beforeEach(() => {
  Object.assign(registry, {
    primary: () => links.local,
    link: (id: string) => links[id],
    linkOf: (id: string) => links[id],
    environment: () => undefined,
    environmentsSnapshot: () => ENVIRONMENTS,
    statusOf: (id: string) => (id === "env_box" ? boxStatus() : OPEN),
  });
});
const ENVIRONMENTS = [
  { id: "local", name: "This Mac", routes: [] },
  { id: "env_box", name: "The box", routes: [] },
  { id: "env_pc", name: "PURDUE-LT", routes: [] },
];
const OPEN: EnvironmentStatus = { ...IDLE_STATUS, transport: "open" };
let cached: EnvironmentStatus | null = null;
const boxStatus = (): EnvironmentStatus => (cached ??= { ...IDLE_STATUS, transport, lastHello: hello as EnvironmentStatus["lastHello"] });

afterEach(() => {
  cleanup();
  requests.length = 0;
  confirms.length = 0;
  asked.length = 0;
  hello = null;
  transport = "open";
  cached = null;
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};

describe("another computer's page", () => {
  it("writes a change to that computer's link and to no other", async () => {
    render(<OtherComputerPage environmentId="env_box" />);
    await flush();
    const field = screen.getByLabelText("Threads at once") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "90" } });
    fireEvent.blur(field);
    await flush();
    const writes = requests.filter((r) => r.method.endsWith(".set"));
    expect(writes).toEqual([{ env: "env_box", method: "admission.set", params: { cap: 90 } }]);
    // This Mac is asked only for its own record of the box; PURDUE-LT is never asked.
    expect(requests.filter((r) => r.env === "local").map((r) => r.method).sort()).toEqual(expect.arrayContaining(["remote.environments.list"]));
    expect(requests.some((r) => r.env === "env_pc")).toBe(false);
    expect(requests.filter((r) => r.env === "local").every((r) => !r.method.startsWith("admission") && !r.method.startsWith("remote.keys"))).toBe(true);
  });

  it("shows a key that may only read its values as words, and asks for nothing that needs more", async () => {
    hello = { caps: ["read", "operate"], key: { id: "k" } };
    const { container } = render(<OtherComputerPage environmentId="env_box" />);
    await flush();
    expect(container.querySelector("[data-setting='pc.atOnce'] input")).toBeNull();
    // Who can is said once, under the title; the sign-in list it may not read is not drawn.
    render(<ComputerLine environmentId="env_box" />);
    expect(document.querySelectorAll("[data-managed]")).toHaveLength(1);
    expect(document.querySelector("[data-managed]")?.textContent).toBe(" Its settings are changed from a computer that manages the box.");
    // The list it may not read stands as its heading and one line, never as nothing.
    expect(container.querySelector("[data-setting='pc.signIns']")?.textContent).toContain("Listed on a computer that manages the box");
    expect(screen.queryByText("Add…")).toBeNull();
    expect(requests.filter((r) => r.env === "env_box").map((r) => r.method).sort()).toEqual(["admission.get", "admission.get", "admission.get", "attachment.settings", "doctor.get"].sort());
  });

  it("leads to the Work page's switch, and forgets the box after asking, on this Mac alone", async () => {
    render(<OtherComputerPage environmentId="env_box" />);
    await flush();
    expect(document.querySelector("[data-setting='pc.work']")?.textContent).toContain("Off");
    fireEvent.click(screen.getByRole("button", { name: "Work on the box" }));
    expect(asked).toEqual([["work", "work.on"]]);
    fireEvent.click(screen.getByText("Forget…"));
    await flush();
    expect(confirms[0]).toEqual(expect.objectContaining({ title: "Forget the box?", body: "This Mac drops its link. The box still lets this Mac in until you remove it there." }));
    expect(requests.filter((r) => r.method === "remote.environments.remove")).toEqual([{ env: "local", method: "remote.environments.remove", params: { id: "env_box" } }]);
  });
});

describe("a computer that did not answer", () => {
  it("says so once with one Retry, claims no connection, and keeps this Mac's own record", async () => {
    const was = ANSWERS.env_box["admission.get"];
    delete ANSWERS.env_box["admission.get"];
    try {
      const { container } = render(
        <>
          <ComputerLine environmentId="env_box" />
          <OtherComputerPage environmentId="env_box" />
        </>,
      );
      await flush();
      await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
      expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
      expect(container.textContent).not.toContain("Connected");
      expect(container.querySelector("[data-setting='pc.atOnce']")).toBeNull();
      expect(container.querySelector("[data-setting='pc.work']")).toBeNull();
      expect(container.querySelector("[data-setting='pc.forget']")).not.toBeNull();
    } finally {
      ANSWERS.env_box["admission.get"] = was;
    }
  });
});

describe("On this Mac's record", () => {
  it("says a failed read of this Mac's record once with Retry, keeping What it may do and Forget…", async () => {
    const was = ANSWERS.local["remote.environments.list"];
    delete ANSWERS.local["remote.environments.list"];
    try {
      const { container } = render(<OtherComputerPage environmentId="env_box" />);
      await flush();
      const section = container.querySelector("[data-setting='pc.may']")!.closest("section")!;
      expect(section.querySelector("[data-setting='pc.name']")).toBeNull();
      expect(section.querySelectorAll("button")).not.toHaveLength(0);
      expect(section.textContent).toContain("Retry");
      expect(section.querySelector("[data-setting='pc.forget']")).not.toBeNull();
    } finally {
      ANSWERS.local["remote.environments.list"] = was;
    }
  });
});

describe("out of reach", () => {
  it("shows what this Mac knows of it and asks it nothing", async () => {
    transport = "offline";
    const { container } = render(<OtherComputerPage environmentId="env_box" />);
    await flush();
    expect(requests.some((r) => r.env === "env_box")).toBe(false);
    expect(container.querySelector("[data-setting='pc.atOnce']")).toBeNull();
    expect(container.querySelector("[data-setting='pc.work']")).not.toBeNull();
    expect(container.querySelector("[data-setting='pc.forget']")).not.toBeNull();
  });
});

describe("On this Mac", () => {
  it("renames the box on this Mac alone, from the Name field", async () => {
    render(<OtherComputerPage environmentId="env_box" />);
    await flush();
    const field = screen.getByLabelText("The box's name on this Mac") as HTMLInputElement;
    expect(field.value).toBe("The box");
    fireEvent.change(field, { target: { value: "studio" } });
    fireEvent.blur(field);
    await flush();
    expect(requests.filter((r) => r.method === "remote.environments.update")).toEqual([{ env: "local", method: "remote.environments.update", params: { id: "env_box", name: "studio" } }]);
    expect(document.querySelector("[data-setting='pc.addresses']")?.textContent).toContain("d.example");
  });
});

describe("its words", () => {
  it("says how this window reaches it", () => {
    expect(computerLineWords({ transport: "open", url: "wss://docket.landonhale.com/ws", lastSeen: null, name: "The box", web: false })).toBe("Connected at docket.landonhale.com.");
    expect(computerLineWords({ transport: "offline", url: undefined, lastSeen: 1_000, name: "The box", web: false, now: 121_000 })).toBe("Offline, last seen 2m ago");
    expect(computerLineWords({ transport: "unauthorized", url: undefined, lastSeen: null, name: "The box", web: false })).toBe("The box no longer lets this Mac in.");
  });

  it("says how far behind it is", () => {
    expect(behindWords(2)).toBe("Two releases behind");
    expect(behindWords(1)).toBe("One release behind");
    expect(behindWords(0)).toBe("Up to date");
    expect(behindWords(null)).toBeUndefined();
  });
});
