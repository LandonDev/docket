// @vitest-environment jsdom
/**
 * House rules' screens (docs/agents/work-rules.md): the workspace's rules with
 * a switch each, the proposals with their edits, Add and Undo, Dismiss, the
 * find field past twelve rules, the voice row, and the line under a sent
 * mail with Not now and its added state.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftEdit, HouseRule, RuleProposal } from "@shared/contract-work-rules";

const calls: { method: string; params: Record<string, unknown> }[] = [];
const state: { rules: HouseRule[]; proposals: RuleProposal[]; line: RuleProposal[]; fail: Set<string>; gate: Promise<void> | null; voice: unknown } = { rules: [], proposals: [], line: [], fail: new Set(), gate: null, voice: null };

vi.mock("../../lib/settings/computerName", async (original) => {
  const real = await original<typeof import("../../lib/settings/computerName")>();
  return { ...real, useReadFailWords: () => (error: string) => real.readFailWords(error, { name: "The box", own: false }) };
});
vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    environment: (id: string) => ({ id, name: "The box" }),
    linkOf: () => ({
      onPush: () => () => {},
      request: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (state.gate) await state.gate;
        if (state.fail.has(method)) throw new Error("The box did not answer");
        if (method === "work.rules.list") return { rules: state.rules, proposals: state.proposals };
        if (method === "work.rules.forDraft") return { workspaceId: "ws", proposals: state.line };
        if (method === "work.rules.voice") return state.voice ?? { on: true, count: 2, since: Date.UTC(2026, 9, 19, 12), from: ["landon@purdue.edu"] };
        if (method === "work.rules.add") return rule("r-new", String(params.text));
        return method === "work.rules.remove" ? { removed: true } : null;
      },
    }),
  },
}));
vi.mock("../../lib/tcserver/workspaces", async (original) => ({
  ...(await original<object>()),
  useWorkspaces: () => [WORKSPACE],
}));
const toasts: { text: string; undo?: () => void }[] = [];
vi.mock("../../components/ui/toaster", async (original) => {
  const toast = Object.assign((text: string, options?: { action?: { onClick: () => void } }) => void toasts.push({ text, undo: options?.action?.onClick }), {
    error: (text: string) => void toasts.push({ text }),
  });
  return { ...(await original<object>()), loadToast: async () => toast };
});

vi.mock("../../lib/linkMay", async (original) => (await import("../../lib/linkMay.testkit")).linkMayMock(await original()));
const { GIVEN_KEY, resetTestKey, testKey } = await import("../../lib/linkMay.testkit");

const WORKSPACE = { id: "ws", name: "Purdue Esports", environmentId: "box", sector: "purdue", kind: "work", path: "/w" } as never;
const { HouseRules, VoiceRow } = await import("./HouseRules");
const { useLinkMay } = await import("../../lib/linkMay");

/** The rules and the voice row as a job's page draws them: the voice only where the job has a sector and the key may write it. */
function RulesPage({ workspace }: { workspace: typeof WORKSPACE }) {
  const may = useLinkMay((workspace as { environmentId: string }).environmentId, "work.workspace.set");
  return (
    <>
      <HouseRules workspace={workspace} />
      {(workspace as { sector?: string | null }).sector && may ? <VoiceRow workspace={workspace} /> : null}
    </>
  );
}
const { RuleLine } = await import("./RuleLine");

function rule(id: string, text: string, on = true): HouseRule {
  return { id, workspaceId: "ws", text, on, proposalId: null, createdAt: 1, updatedAt: 1 };
}
const edit = (n: number): DraftEdit => ({
  draftId: `d${n}`,
  to: "Sam Ortiz",
  subject: `Scrim ${n}`,
  sentAt: Date.UTC(2026, 10, 17, 14),
  ops: [
    { op: "=", text: "Hi Sam, " },
    { op: "-", text: "I hope this email finds you well. " },
    { op: "=", text: "Thursday at 7 works." },
  ],
});
const proposal = (over: Partial<RuleProposal> = {}): RuleProposal => ({
  id: "p1",
  workspaceId: "ws",
  text: "Leave out “I hope this email finds you well”",
  line: "You took out “I hope this email finds you well” again.",
  state: "open",
  ruleId: null,
  edits: [edit(1), edit(2), edit(3)],
  updatedAt: 1,
  ...over,
});
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => {
  calls.length = 0;
  toasts.length = 0;
  state.rules = [rule("r1", "Sign Purdue mail as Landon Hale"), rule("r2", "Copy Sam Ortiz on anything about scrims", false)];
  state.proposals = [proposal()];
  state.line = [proposal()];
  state.fail = new Set();
  state.gate = null;
});
afterEach(() => {
  cleanup();
  resetTestKey();
});

describe("the rules page", () => {
  it("lists the rules with a switch each, and a proposal that opens to its three edits", async () => {
    render(<RulesPage workspace={WORKSPACE} />);
    await settle();
    expect(screen.getByRole("button", { name: "Edit rule: Sign Purdue mail as Landon Hale" })).toBeTruthy();
    expect((screen.getByRole("switch", { name: /Copy Sam Ortiz/ }) as HTMLElement).getAttribute("aria-checked")).toBe("false");
    const row = document.querySelector("[data-proposal=p1]") as HTMLElement;
    expect(row.textContent).toContain("from 3 edits");
    fireEvent.click(within(row).getByText("Leave out “I hope this email finds you well”"));
    await settle();
    expect(row.querySelectorAll(".line-through")).toHaveLength(3);
    expect(row.textContent).toContain("To Sam Ortiz, Scrim 1");
  });

  it("Add makes the rule from the proposal, and Undo puts the proposal back", async () => {
    render(<RulesPage workspace={WORKSPACE} />);
    await settle();
    fireEvent.click(within(document.querySelector("[data-proposal=p1]") as HTMLElement).getByRole("button", { name: "Add" }));
    await settle();
    expect(calls.find((c) => c.method === "work.rules.add")?.params).toEqual({ workspaceId: "ws", text: "Leave out “I hope this email finds you well”", proposalId: "p1" });
    expect(toasts.at(-1)?.text).toBe("Added to Purdue Esports's rules");
    toasts.at(-1)!.undo!();
    await settle();
    expect(calls.find((c) => c.method === "work.rules.remove")?.params).toEqual({ id: "r-new", reopen: true });
  });

  it("Dismiss asks the host never to offer it again", async () => {
    render(<RulesPage workspace={WORKSPACE} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await settle();
    expect(calls.find((c) => c.method === "work.rules.decide")?.params).toEqual({ id: "p1", to: "dismissed" });
  });

  it("past twelve rules, a find field narrows the list, marks the words, and turns reordering off", async () => {
    state.rules = Array.from({ length: 14 }, (_, i) => rule(`r${i}`, i === 9 ? "Say players, not gamers" : `Rule number ${i}`));
    render(<RulesPage workspace={WORKSPACE} />);
    await settle();
    expect(document.querySelectorAll("[data-rule-grip]")).toHaveLength(14);
    fireEvent.change(screen.getByRole("textbox", { name: "Find a rule" }), { target: { value: "players" } });
    expect(document.querySelectorAll("[data-rule]")).toHaveLength(1);
    expect(document.querySelector("mark")?.textContent).toBe("players");
    expect(document.querySelectorAll("[data-rule-grip]")).toHaveLength(0);
  });

  it("says when there are no rules, and the voice row names its mail", async () => {
    state.rules = [];
    state.proposals = [];
    render(<RulesPage workspace={WORKSPACE} />);
    await settle();
    expect(screen.getByText("No rules yet")).toBeTruthy();
    expect(screen.queryByText("Proposed")).toBeNull();
    expect(screen.getByText(/^2 mails from landon@purdue\.edu since /)).toBeTruthy();
  });
});

describe("a read that failed", () => {
  it("offers Retry on the rules' error, busy while it asks again, then lists them", async () => {
    state.fail.add("work.rules.list");
    render(<RulesPage workspace={WORKSPACE} />);
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("The box did not answer.");
    state.fail.delete("work.rules.list");
    let open: () => void = () => {};
    state.gate = new Promise((r) => (open = r));
    const retry = screen.getAllByRole("button", { name: "Retry" })[0]!;
    fireEvent.click(retry);
    expect(retry.hasAttribute("disabled")).toBe(true);
    expect(retry.querySelector("[data-busy]")).not.toBeNull();
    // The error stays said while it asks.
    expect(screen.getByText("The box did not answer.")).toBeTruthy();
    state.gate = null;
    await act(async () => open());
    await settle();
    expect(screen.getByText("Sign Purdue mail as Landon Hale")).toBeTruthy();
  });

  it("offers Retry on the voice row's error, and a retry that fails again keeps it", async () => {
    state.fail.add("work.rules.voice");
    render(<RulesPage workspace={WORKSPACE} />);
    await settle();
    const retry = () => screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry());
    await settle();
    expect(screen.getByText("The box did not answer.")).toBeTruthy();
    expect(retry().hasAttribute("disabled")).toBe(false);
    state.fail.delete("work.rules.voice");
    fireEvent.click(retry());
    await settle();
    expect(screen.getByText(/^2 mails from landon@purdue\.edu since /)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

/** Council round 10 (Opus Settings 1): "LifeOS is not connected" in red beside Waiting on's line for the same state. */
describe("the voice row while LifeOS is down", () => {
  afterEach(async () => {
    state.voice = null;
    (await import("../shell/lifeos")).resetLifeos();
  });

  it("stays quiet while the host's LifeOS is down, keeps its switch, and reads again once it is back", async () => {
    const { setLifeosStatus } = await import("../shell/lifeos");
    setLifeosStatus("box", { lifeos: { state: "signed-out" }, keys: [] });
    state.voice = { on: true, count: null, since: null, from: [] };
    render(<RulesPage workspace={WORKSPACE} />);
    await settle();
    const row = screen.getByText("Learn how I write from my sent mail").closest("[data-slot]")!.parentElement!;
    expect(row.textContent).not.toMatch(/LifeOS|mails/);
    expect(screen.getByRole("switch", { name: "Learn how I write from my sent mail" })).toBeTruthy();
    const asks = calls.filter((c) => c.method === "work.rules.voice").length;
    state.voice = null;
    act(() => setLifeosStatus("box", { lifeos: { state: "connected", ownerId: "o", since: 1 }, keys: [] }));
    await settle();
    expect(calls.filter((c) => c.method === "work.rules.voice").length).toBe(asks + 1);
    expect(screen.getByText(/^2 mails from landon@purdue\.edu since /)).toBeTruthy();
  });

  it("says a failed read of a connected session as LifeOS's silence, the computer named", async () => {
    const { setLifeosStatus } = await import("../shell/lifeos");
    setLifeosStatus("box", { lifeos: { state: "connected", ownerId: "o", since: 1 }, keys: [] });
    state.voice = { on: true, count: null, since: null, from: [], error: "LifeOS did not answer: socket closed" };
    render(<RulesPage workspace={WORKSPACE} />);
    await settle();
    expect(screen.getByText("LifeOS did not answer the box")).toBeTruthy();
    expect(screen.queryByText(/socket closed/)).toBeNull();
  });

  /** Council round 12 (Opus, Settings 1): LifeOS's silence on the count had no Retry. */
  it("gives that line its Retry, which reads the count again, spinning in place until the answer", async () => {
    const { setLifeosStatus } = await import("../shell/lifeos");
    setLifeosStatus("box", { lifeos: { state: "connected", ownerId: "o", since: 1 }, keys: [] });
    state.voice = { on: true, count: null, since: null, from: [], error: "LifeOS did not answer: socket closed" };
    render(<RulesPage workspace={WORKSPACE} />);
    await settle();
    const line = document.querySelector<HTMLElement>("[data-voice-failed]")!;
    const asks = calls.filter((c) => c.method === "work.rules.voice").length;
    let open!: () => void;
    state.gate = new Promise<void>((r) => (open = r));
    state.voice = null;
    fireEvent.click(within(line).getByRole("button", { name: "Retry" }));
    await settle();
    expect(calls.filter((c) => c.method === "work.rules.voice").length).toBe(asks + 1);
    const pressed = document.querySelector<HTMLElement>("[data-voice-failed]")!;
    expect(pressed.textContent).toContain("LifeOS did not answer the box");
    expect(within(pressed).getByRole("button", { name: "Retry" }).hasAttribute("disabled")).toBe(true);
    state.gate = null;
    open();
    await settle();
    expect(document.querySelector("[data-voice-failed]")).toBeNull();
    expect(screen.getByText(/^2 mails from landon@purdue\.edu since /)).toBeTruthy();
  });
});

describe("the rule dialog", () => {
  it("Add rule… writes the rule though no callback waits on it", async () => {
    render(<RulesPage workspace={WORKSPACE} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Add rule…" }));
    await settle();
    fireEvent.change(screen.getByRole("textbox", { name: "Rule" }), { target: { value: "Sign as Landon" } });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await settle();
    expect(calls.find((c) => c.method === "work.rules.add")?.params).toEqual({ workspaceId: "ws", text: "Sign as Landon" });
  });

  it("a given computer's key, which may not write the workspace's settings, has no voice section and keeps the rules", async () => {
    testKey.current = GIVEN_KEY;
    render(<RulesPage workspace={WORKSPACE} />);
    await settle();
    expect(screen.getByRole("button", { name: "Edit rule: Sign Purdue mail as Landon Hale" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Learn how I write from my sent mail" })).toBeNull();
    expect(calls.some((c) => c.method === "work.rules.voice")).toBe(false);
  });

  it("a workspace with no sector has no voice section", async () => {
    render(<RulesPage workspace={{ ...(WORKSPACE as object), sector: null } as never} />);
    await settle();
    expect(screen.queryByText("Voice")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Learn how I write from my sent mail" })).toBeNull();
  });
});

describe("the order, without a pointer", () => {
  it("moves a rule in its edit dialog and writes the order with Save, through the same reorder call", async () => {
    state.rules = [rule("r1", "First"), rule("r2", "Second"), rule("r3", "Third")];
    render(<RulesPage workspace={WORKSPACE} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Edit rule: Second" }));
    await settle();
    expect(screen.getByText("2 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move up" }));
    // Moved in the dialog only: nothing written yet.
    expect(screen.getByText("1 of 3")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Move up" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((c) => c.method === "work.rules.order")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(calls.find((c) => c.method === "work.rules.order")?.params).toEqual({ workspaceId: "ws", ids: ["r2", "r1", "r3"] });
    // The text did not change, so only the order went.
    expect(calls.some((c) => c.method === "work.rules.edit")).toBe(false);
  });

  /** WORK's request (RuleDialog.tsx): Delete took a rule for good, while Add and Dismiss each gave Undo. */
  it("Delete says Deleted with Undo, which writes the words back off as they were, in the place they stood", async () => {
    state.rules = [rule("r1", "First"), rule("r2", "Second", false), rule("r3", "Third")];
    toasts.length = 0;
    render(<HouseRules workspace={WORKSPACE} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Edit rule: Second" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await settle();
    expect(calls.find((c) => c.method === "work.rules.remove")?.params).toEqual({ id: "r2" });
    const deleted = toasts.find((t) => t.text === "Deleted")!;
    expect(deleted.undo).toBeTruthy();
    const before = calls.length;
    await act(async () => deleted.undo!());
    await settle();
    expect(calls.slice(before).map((c) => [c.method, c.params])).toEqual([
      ["work.rules.add", { workspaceId: "ws", text: "Second" }],
      ["work.rules.edit", { id: "r-new", on: false }],
      ["work.rules.order", { workspaceId: "ws", ids: ["r1", "r-new", "r3"] }],
    ]);
  });

  it("Cancel leaves the order as it was", async () => {
    state.rules = [rule("r1", "First"), rule("r2", "Second")];
    render(<RulesPage workspace={WORKSPACE} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Edit rule: Second" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Move up" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    expect(calls.some((c) => c.method === "work.rules.order")).toBe(false);
    const order = [...document.querySelectorAll("[data-rule]")].map((r) => r.getAttribute("data-rule"));
    expect(order).toEqual(["r1", "r2"]);
  });
});

describe("the line under a sent mail", () => {
  it("names the habit, opens to the edits, and Not now leaves it for the rules page", async () => {
    render(<RuleLine env="box" draftId="d3" />);
    await settle();
    expect(screen.getByText(/You took out “I hope this email finds you well” again\. Make it a rule for Purdue Esports\?/)).toBeTruthy();
    // A proposal's verb is Add…, as on every proposal; Not now defers this one-line offer to the rules page.
    expect(screen.getByRole("button", { name: "Add…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await settle();
    expect(calls.find((c) => c.method === "work.rules.decide")?.params).toEqual({ id: "p1", to: "later" });
    expect(document.querySelector("[data-rule-line]")).toBeNull();
  });

  it("once added, says so with Undo", async () => {
    state.line = [proposal({ state: "added", ruleId: "r9" })];
    render(<RuleLine env="box" draftId="d3" />);
    await settle();
    expect(screen.getByText("Added to Purdue Esports's rules")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await settle();
    expect(calls.find((c) => c.method === "work.rules.remove")?.params).toEqual({ id: "r9", reopen: true });
  });

  it("draws nothing when no proposal comes from the mail", async () => {
    state.line = [];
    const { container } = render(<RuleLine env="box" draftId="d3" />);
    await settle();
    expect(container.textContent).toBe("");
  });
});
