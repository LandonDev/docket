// @vitest-environment jsdom
/**
 * Results in a Work thread's panel, and the return from Away
 * (docs/agents/work-outbox.md, "The screens"), over one host that answers
 * from memory.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxItem, WorkResult } from "@shared/contract-work-outbox";

const world = vi.hoisted(() => ({ calls: [] as { method: string; params: Record<string, unknown> }[], items: [] as OutboxItem[], results: [] as WorkResult[] }));

vi.mock("../../lib/connection", async (original) => {
  const link = {
    environmentId: "box",
    connected: true,
    onPush: () => () => undefined,
    onOpen: () => () => undefined,
    onClose: () => () => undefined,
    request: async (method: string, params: Record<string, unknown> = {}) => {
      world.calls.push({ method, params });
      if (method === "work.outbox.list") return params.show === "decided" ? { items: [] } : { items: world.items, waiting: world.items.length };
      if (method === "work.outbox.grants") return { grants: [] };
      if (method === "work.outbox.results") return { results: params.since !== undefined ? world.results.filter((r) => r.createdAt >= (params.since as number)) : world.results };
      if (method === "work.outbox.undo") {
        const r = world.results.find((x) => x.id === params.id)!;
        r.undoneAt = 99;
        return r;
      }
      throw new Error(method);
    },
  };
  return { ...(await original<typeof import("../../lib/connection")>()), registry: { linkOf: () => link, onLink: (l: (x: typeof link, e: string) => void) => (l(link, "added"), () => undefined) } };
});

import { setWorkOn, workSwitch } from "../../lib/workSwitch";
import { AwayReturnWork, gatherAway } from "./AwayList";
import { ResultsSection } from "./ResultsSection";
import { resetOutboxStore } from "./store";

const result = (id: string, summary: string, undo: boolean, extra: Partial<WorkResult> = {}): WorkResult => ({
  id,
  sessionId: "t1",
  workspaceId: "ws1",
  kind: "task",
  summary,
  account: "Spring LAN",
  ref: null,
  undo: undo ? { pillar: "tasks", verb: "remove", args: { id } } : null,
  undoneAt: null,
  createdAt: 2_000,
  ...extra,
});
const held = (id: string, state: OutboxItem["state"], summary: string): OutboxItem =>
  ({ ref: { at: "host", id }, kind: "addon.call", workspaceId: "ws1", sessionId: "t1", sector: "purdue", summary, verb: "Send", account: null, state, payload: {}, createdAt: 1, decidedBy: null, decidedAt: null, n: 1, why: "rule", grantId: null, error: state === "failed" ? "Slack did not answer" : null, result: null, routineRunId: null, updatedAt: 1 }) as OutboxItem;

beforeEach(() => {
  world.calls = [];
  world.items = [held("h1", "held", "Post message with Slack: “Standup at 10”"), held("h2", "failed", "Post message with Slack: “Lunch”")];
  world.results = [result("r1", "Added Dietary needs", true), result("r2", "Sent to Dana Lee", false, { ref: { held: { at: "lifeos", id: "o1" } } })];
  workSwitch.reset();
  setWorkOn("box", true);
  resetOutboxStore();
});
afterEach(cleanup);

describe("Results", () => {
  it("splits what can be taken back from what cannot, and Undo runs the way back once", async () => {
    render(<ResultsSection environmentId="box" sessionId="t1" />);
    const can = await screen.findByRole("region", { name: "Can undo" });
    expect(within(can).getByText("Added Dietary needs")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Can't undo" })).getByText("Sent to Dana Lee")).toBeTruthy();
    await act(async () => fireEvent.click(within(can).getByRole("button", { name: "Undo" })));
    expect(world.calls.filter((c) => c.method === "work.outbox.undo")).toEqual([{ method: "work.outbox.undo", params: { id: "r1" } }]);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Can't undo" })).getByText("Undone")).toBeTruthy());
  });
});

describe("the return from Away", () => {
  it("gathers held, failed, decided and the writes since Away began, sends left out", async () => {
    const found = await gatherAway([{ environmentId: "box", decided: { since: 1_500, threads: [{ sessionId: "t1", count: 2 }] } }], 3_000);
    expect(found!.line).toBe("Held 1, decided 2 without you, 1 failed");
    expect(found!.report.written.map((r) => r.summary)).toEqual(["Added Dietary needs"]);
  });

  it("lists them in the order he must act, each with its verb", async () => {
    const found = await gatherAway([{ environmentId: "box", decided: { since: 1_500, threads: [{ sessionId: "t1", count: 2 }] } }], 3_000);
    const onOpenSession = vi.fn();
    render(<AwayReturnWork report={found!.report} onClose={() => undefined} onOpenSession={onOpenSession} onOpenOutbox={() => undefined} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Held", "Failed", "Decided without you", "Written on your files"]);
    expect(within(within(dialog).getByRole("region", { name: "Failed" })).getByText("Slack did not answer")).toBeTruthy();
    expect(within(within(dialog).getByRole("region", { name: "Failed" })).getByRole("button", { name: "Send again" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
    expect(onOpenSession).toHaveBeenCalledWith("t1", "box");
    // Held is never amber
    expect(dialog.querySelector('[data-state="waiting"]')).toBeNull();
  });
});
