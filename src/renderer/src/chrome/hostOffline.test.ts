import { afterEach, describe, expect, it, vi } from "vitest";
import { registry } from "../lib/connection/registry";
import { IDLE_STATUS, type EnvironmentStatus } from "../lib/connection/types";
import { DEGRADED_GRACE_MS } from "../lib/connection/degraded";
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
    vi.useFakeTimers();
    statuses.env_box = { ...IDLE_STATUS, transport: "reconnecting" };
    statuses.env_mac = { ...IDLE_STATUS, transport: "open" };
    // A blip holds nothing: the verbs wait out the grace from the drop, as the composer's line does.
    expect(hostsHeld(["env_box"])).toBeNull();
    vi.advanceTimersByTime(DEGRADED_GRACE_MS - 1);
    expect(hostsHeld(["env_box"])).toBeNull();
    vi.advanceTimersByTime(1);
    expect(hostsHeld(["env_box"])).toBe("Reconnecting to the box…");
    vi.useRealTimers();
    expect(hostsHeld(["env_box", "env_mac"])).toBeNull();
    expect(hostsHeld([])).toBeNull();
    statuses.env_box = { ...IDLE_STATUS, transport: "offline", lastError: "connect ECONNREFUSED" };
    expect(hostsHeld(["env_box"])).toBe("The box is offline");
  });

  it("holds a stopped host or a refused key at once, and counts a new drop's grace afresh after the link came back", () => {
    vi.useFakeTimers();
    statuses.env_box = { ...IDLE_STATUS, transport: "unauthorized" };
    expect(hostsHeld(["env_box"])).toBe("The box no longer accepts this key");
    statuses.env_box = { ...IDLE_STATUS, transport: "open" };
    expect(hostsHeld(["env_box"])).toBeNull();
    vi.advanceTimersByTime(60_000);
    statuses.env_box = { ...IDLE_STATUS, transport: "connecting" };
    expect(hostsHeld(["env_box"])).toBeNull();
    vi.advanceTimersByTime(DEGRADED_GRACE_MS);
    expect(hostsHeld(["env_box"])).toBe("Connecting to the box…");
    statuses.env_box = { ...IDLE_STATUS, transport: "open" };
    expect(hostsHeld(["env_box"])).toBeNull();
    vi.useRealTimers();
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
  it("says who can for a key that may not approve, and nothing for a key that may, the host's state aside", async () => {
    const { approvalElsewhere } = await import("./ApprovalToasts");
    statuses.env_box = { ...IDLE_STATUS, transport: "open", lastHello: { environmentId: "env_box", contract: 3, caps: ["read", "operate"], key: { id: "k", name: "Laptop" } } as never };
    expect(approvalElsewhere("env_box")).toBe("Answer from a computer that manages the box");
    statuses.env_box = { ...IDLE_STATUS, transport: "reconnecting" };
    expect(approvalElsewhere("env_box")).toBeNull();
    statuses.env_box = { ...IDLE_STATUS, transport: "open" };
    expect(approvalElsewhere("env_box")).toBeNull();
    expect(approvalElsewhere(undefined)).toBeNull();
  });
});
