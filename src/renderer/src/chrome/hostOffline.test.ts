import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "../lib/connection/registry";
import { IDLE_STATUS, type EnvironmentStatus } from "../lib/connection/types";
import { heldRows, hostsHeld } from "./hostOffline";
import { projectMenuExtraItems } from "./ProjectRail";

const statuses: Record<string, EnvironmentStatus> = {};
vi.spyOn(registry, "statusOf").mockImplementation((id) => statuses[id] ?? IDLE_STATUS);
vi.spyOn(registry, "environment").mockImplementation((id) => ({ id, name: id === "env_box" ? "The box" : "MacBook", routes: [], credentialRef: null }));

afterEach(() => {
  for (const key of Object.keys(statuses)) delete statuses[key];
});

describe("a workspace row's verbs while its host is away (rail-05)", () => {
  it("holds them only while every host of the row is away, in the link's own words", () => {
    statuses.env_box = { ...IDLE_STATUS, transport: "reconnecting" };
    statuses.env_mac = { ...IDLE_STATUS, transport: "open" };
    expect(hostsHeld(["env_box"])).toBe("Reconnecting to the box…");
    expect(hostsHeld(["env_box", "env_mac"])).toBeNull();
    expect(hostsHeld([])).toBeNull();
    statuses.env_box = { ...IDLE_STATUS, transport: "offline", lastError: "connect ECONNREFUSED" };
    expect(hostsHeld(["env_box"])).toBe("The box is offline");
  });

  it("keeps pin, reveal and the order live and holds the host's verbs", () => {
    const rows = heldRows(projectMenuExtraItems(false, true, { pause: 1, resume: 0, stop: 1, archiveDone: 0 }, true), "The box is offline", new Set(["pin", "unpin", "reveal", "move-up", "move-down"]));
    const items = rows.flatMap((row) => (row.kind === "item" ? [row] : []));
    const live = items.filter((row) => !row.disabled).map((row) => row.id);
    expect(live).toEqual(["pin", "reveal"]);
    for (const row of items.filter((r) => r.disabled)) expect(row.reason).toBe("The box is offline");
    expect(items.find((row) => row.id === "archive")?.disabled).toBe(true);
    expect(heldRows(rows, null)).toBe(rows);
  });
});

describe("an approval toast for a key or a host that would refuse it", () => {
  it("says who can for a key that may not approve, the host's state while it is away, else nothing", async () => {
    const { approvalHeldFor } = await import("./ApprovalToasts");
    statuses.env_box = { ...IDLE_STATUS, transport: "open", lastHello: { environmentId: "env_box", contract: 3, caps: ["read", "operate"], key: { id: "k", name: "Laptop" } } as never };
    expect(approvalHeldFor("env_box")).toBe("Answer from a computer that manages the box");
    statuses.env_box = { ...IDLE_STATUS, transport: "reconnecting" };
    expect(approvalHeldFor("env_box")).toBe("Reconnecting to the box…");
    statuses.env_box = { ...IDLE_STATUS, transport: "open" };
    expect(approvalHeldFor("env_box")).toBeNull();
    expect(approvalHeldFor(undefined)).toBeNull();
  });
});
