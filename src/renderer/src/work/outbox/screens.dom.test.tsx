// @vitest-environment jsdom
/**
 * Results in a Work thread's panel, and the return from Away
 * (docs/agents/work-outbox.md, "The screens"), over one host that answers
 * from memory.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxItem, WorkResult } from "@shared/contract-work-outbox";

const world = vi.hoisted(() => ({ calls: [] as { method: string; params: Record<string, unknown> }[], items: [] as OutboxItem[], results: [] as WorkResult[], writesDown: false }));

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
      if (method === "work.outbox.results" && params.since !== undefined && world.writesDown) throw new Error("socket closed");
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
import { AwayReturnWork, gatherAway, UNREAD_LINE } from "./AwayList";
import { ResultsSection } from "./ResultsSection";
import { resultsListed } from "./results";
import { tooltipChunk, warmTooltips } from "../../components/ui/tooltip";
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
  world.writesDown = false;
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

describe("Results in the panel", () => {
  it("is listed while a read failed with no rows, so its error and Retry show", () => {
    expect(resultsListed({ rows: [], error: null })).toBe(0);
    expect(resultsListed({ rows: [], error: "The host did not answer" })).toBe(1);
    expect(resultsListed({ rows: [{} as never, {} as never], error: null })).toBe(2);
  });
});

describe("the return from Away", () => {
  it("gathers held, failed, decided and the writes since Away began, sends left out", async () => {
    const found = await gatherAway([{ environmentId: "box", decided: { since: 1_500, threads: [{ sessionId: "t1", count: 2 }] } }], 3_000);
    expect(found!.line).toBe("Held 1, decided 2 without you, 1 failed");
    expect(found!.report.written.map((r) => r.summary)).toEqual(["Added Dietary needs"]);
  });

  it("lists them in the order he must act, leaving the held acts themselves to the Outbox", async () => {
    const found = await gatherAway([{ environmentId: "box", decided: { since: 1_500, threads: [{ sessionId: "t1", count: 2 }] } }], 3_000);
    const onOpenSession = vi.fn();
    const onOpenOutbox = vi.fn();
    // Every line measures as cut, so each takes its tooltip.
    const width = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(400);
    const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
    await act(async () => {
      warmTooltips();
      await tooltipChunk.load();
    });
    render(<AwayReturnWork report={found!.report} onClose={() => undefined} onOpenSession={onOpenSession} onOpenOutbox={onOpenOutbox} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Held", "Failed", "Decided without you", "Written on your files"]);
    expect(within(within(dialog).getByRole("region", { name: "Held" })).getByText("1 waiting")).toBeTruthy();
    expect(within(within(dialog).getByRole("region", { name: "Failed" })).getByText("Slack did not answer")).toBeTruthy();
    // No send from here: a send that may have gone keeps the Outbox's guard.
    expect(within(dialog).queryByRole("button", { name: /^Send/ })).toBeNull();
    const outboxButton = within(dialog).getByRole("button", { name: "Open the Outbox" });
    expect(outboxButton.closest("[data-footer-start]")).toBeTruthy();
    fireEvent.click(outboxButton);
    expect(onOpenOutbox).toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
    expect(onOpenSession).toHaveBeenCalledWith("t1", "box");
    // A failed act's reason that is cut short says the rest on hover.
    await waitFor(() => expect(within(within(dialog).getByRole("region", { name: "Failed" })).getByText("Slack did not answer").getAttribute("data-slot")).toBe("tooltip-trigger"));
    width.mockRestore();
    client.mockRestore();
    // Held is never amber
    expect(dialog.querySelector('[data-state="waiting"]')).toBeNull();
  });

  it("keeps a failed read of the writes as a partial read with one Retry, never an empty list", async () => {
    world.writesDown = true;
    const found = await gatherAway([{ environmentId: "box", decided: { since: 1_500, threads: [] } }], 3_000);
    expect(found!.report.unread).toEqual(["box"]);
    render(<AwayReturnWork report={found!.report} onClose={() => undefined} onOpenSession={() => undefined} onOpenOutbox={() => undefined} />);
    const dialog = await screen.findByRole("dialog");
    const written = within(dialog).getByRole("region", { name: "Written on your files" });
    expect(within(written).getByRole("alert").textContent).toContain("did not answer");
    world.writesDown = false;
    await act(async () => fireEvent.click(within(written).getByRole("button", { name: "Retry" })));
    await waitFor(() => expect(within(written).getByText("Added Dietary needs")).toBeTruthy());
    expect(within(written).queryByRole("alert")).toBeNull();
  });

  it("lists only the writes made while he was away: Retry after his return leaves later ones out", async () => {
    world.writesDown = true;
    const found = await gatherAway([{ environmentId: "box", decided: { since: 1_500, threads: [] } }], 3_000);
    render(<AwayReturnWork report={found!.report} onClose={() => undefined} onOpenSession={() => undefined} onOpenOutbox={() => undefined} />);
    const dialog = await screen.findByRole("dialog");
    const written = within(dialog).getByRole("region", { name: "Written on your files" });
    world.writesDown = false;
    // Written after he came back (until 3,000): not his Away's.
    world.results = [...world.results, result("r9", "Added After hours", true, { createdAt: 4_000 })];
    await act(async () => fireEvent.click(within(written).getByRole("button", { name: "Retry" })));
    await waitFor(() => expect(within(written).getByText("Added Dietary needs")).toBeTruthy());
    expect(within(written).queryByText("Added After hours")).toBeNull();
  });

  it("still toasts when a failed read of the writes was all there was to say", async () => {
    world.items = [];
    world.writesDown = true;
    const found = await gatherAway([{ environmentId: "box", decided: { since: 1_500, threads: [] } }], 3_000);
    expect(found!.line).toBe(UNREAD_LINE);
  });
});
