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
const state: { rules: HouseRule[]; proposals: RuleProposal[]; line: RuleProposal[] } = { rules: [], proposals: [], line: [] };

vi.mock("../../lib/connection", async (original) => ({
  ...(await original<object>()),
  registry: {
    linkOf: () => ({
      onPush: () => () => {},
      request: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (method === "work.rules.list") return { rules: state.rules, proposals: state.proposals };
        if (method === "work.rules.forDraft") return { workspaceId: "ws", proposals: state.line };
        if (method === "work.rules.voice") return { on: true, count: 2, since: Date.UTC(2026, 9, 19, 12), from: ["landon@purdue.edu"] };
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

const WORKSPACE = { id: "ws", name: "Purdue Esports", environmentId: "box", sector: "purdue", kind: "work", path: "/w" } as never;
const { HouseRules } = await import("./HouseRules");
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
});
afterEach(cleanup);

describe("the rules page", () => {
  it("lists the rules with a switch each, and a proposal that opens to its three edits", async () => {
    render(<HouseRules workspace={WORKSPACE} />);
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
    render(<HouseRules workspace={WORKSPACE} />);
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
    render(<HouseRules workspace={WORKSPACE} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await settle();
    expect(calls.find((c) => c.method === "work.rules.decide")?.params).toEqual({ id: "p1", to: "dismissed" });
  });

  it("past twelve rules, a find field narrows the list, marks the words, and turns reordering off", async () => {
    state.rules = Array.from({ length: 14 }, (_, i) => rule(`r${i}`, i === 9 ? "Say players, not gamers" : `Rule number ${i}`));
    render(<HouseRules workspace={WORKSPACE} />);
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
    render(<HouseRules workspace={WORKSPACE} />);
    await settle();
    expect(screen.getByText("No rules yet")).toBeTruthy();
    expect(screen.queryByText("Proposed")).toBeNull();
    expect(screen.getByText(/^2 mails from landon@purdue\.edu since /)).toBeTruthy();
  });
});

describe("the line under a sent mail", () => {
  it("names the habit, opens to the edits, and Not now leaves it for the rules page", async () => {
    render(<RuleLine env="box" draftId="d3" />);
    await settle();
    expect(screen.getByText(/You took out “I hope this email finds you well” again\. Make it a rule for Purdue Esports\?/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add rule…" })).toBeTruthy();
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
