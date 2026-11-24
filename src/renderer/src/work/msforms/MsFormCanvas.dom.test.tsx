// @vitest-environment jsdom
/**
 * The Microsoft form kind's bar and Responses half on a stand-in host: each
 * face of the bar (Collect responses, the link with Copy and Close form, the
 * closed line with Reopen), the presses it makes, and the answers drawn from
 * `work.msforms.responses` as our forms' Responses are.
 */
import { beginRevealNavigation } from "../../lib/revealRead";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MsFormResponses, MsFormView } from "@shared/contract-work-msforms";
import type { CanvasItem } from "@shared/work";
import type { CanvasBodyProps, CanvasShell } from "../canvas/kind";
import type { MsFormHost } from "./host";
import { answerBarsOf, chartOf, timeColumnOf } from "./model";
import { Bar, Body, type MsFormState } from "./MsFormCanvas";

// No workspace with a sector stands in: Who hasn't answered offers pasting alone, and never opens a LifeOS session.
vi.mock("../../lib/tcserver/workspaces", async (original) => ({ ...(await original<object>()), useWorkspaces: () => [] }));

const FORM = "Ob0wQVN8nEGx5YdY1tY_IQaWFXVrVqJAiq2zrvrFVrNURDVET1gyWlpLNkJXOUsyWEJXNFlKMzMxVC4u";
const BASE: MsFormView = {
  workspaceId: "w1",
  formId: FORM,
  tenant: "purdue0",
  title: "Spring intramural sign-up",
  folder: { libraryId: "lib", path: "Esports", siteUrl: "https://purdue0.sharepoint.com/sites/RecWell" },
  workbook: null,
  state: "draft",
  mode: "suggests",
  settings: { accepting: false, orgOnly: true, recordName: true, onePerPerson: true },
  questions: [{ title: "Which night works?", type: "choice", options: ["Monday", "Tuesday"], required: true }],
  rev: 1,
  readAt: null,
  answersReadAt: null,
  count: 0,
  lastAnswerAt: null,
  check: "hour",
  suggestions: [],
  held: null,
  link: null,
  madeBy: "owner",
  signedInAs: null,
  updatedAt: 0,
  unseen: 0,
  stopped: null,
  closedAt: null,
};
const LINK = `https://forms.cloud.microsoft/Pages/ResponsePage.aspx?id=${FORM}`;
const RESPONSES: MsFormResponses = {
  rev: 1,
  columns: [
    { id: "name", label: "Name" },
    { id: "q1", label: "Which night works?" },
    { id: "done", label: "Completion time" },
  ],
  rows: [
    ["Ava Thompson", "Tuesday", "2026-11-24 14:02"],
    ["Marcus Lee", "Monday", "2026-11-24 13:40"],
    ["Jordan Kim", "Tuesday", "2026-11-24 12:18"],
  ],
  count: 3,
  cut: false,
  at: Date.now(),
  stale: false,
  none: false,
};

function hostOf(view: MsFormView, over: Partial<MsFormHost> = {}): MsFormHost {
  const same = () => vi.fn(async () => view);
  return { get: same(), collect: same(), close: same(), mode: same(), check: same(), review: same(), responses: vi.fn(async () => RESPONSES), refresh: same(), seen: same(), watch: () => () => undefined, ...over };
}
const shell = (): CanvasShell => ({ review: vi.fn(), selection: vi.fn(), presence: vi.fn(), mode: vi.fn(), statusLine: vi.fn(), written: vi.fn(), detail: vi.fn(), openHistory: vi.fn(), held: vi.fn(), more: vi.fn(), ready: vi.fn() });
let n = 0;
function props(host: MsFormHost, half: MsFormState["half"] = "form"): CanvasBodyProps<MsFormState> & { host: MsFormHost } {
  const item = { id: `msform-${++n}`, sessionId: "t1", workspaceId: "w1", kind: "msform", title: "Spring intramural sign-up", source: { at: "msform", host: "env", workspaceId: "w1", formId: FORM, tenant: "purdue0" }, state: "open", position: 0, rev: 0, createdAt: 0, updatedAt: 0 } as CanvasItem;
  return { item, source: item.source, env: "local", state: { half }, setState: () => undefined, shell: shell(), host };
}

afterEach(cleanup);

/** The bar, once the body has read the form (the two share the item's store). */
async function bar(view: MsFormView, host = hostOf(view), half: MsFormState["half"] = "form") {
  const p = props(host, half);
  render(
    <>
      <Bar {...p} />
      <Body {...p} />
    </>,
  );
  await waitFor(() => expect(host.get).toHaveBeenCalled());
  return { host, p };
}

describe("the bar", () => {
  it("a draft offers Collect responses, his press", async () => {
    const { host } = await bar(BASE);
    const button = await screen.findByRole("button", { name: "Collect responses" });
    await act(async () => void fireEvent.click(button));
    expect(host.collect).toHaveBeenCalledOnce();
  });

  it("while collecting: the link, Copy link and Close form", async () => {
    const view = { ...BASE, state: "collecting" as const, link: LINK, unseen: 2 };
    const { host } = await bar(view);
    expect(await screen.findByRole("link", { name: LINK.replace("https://", "") })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Copy link" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Collect responses" })).toBeNull();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Close form" })));
    expect(host.close).toHaveBeenCalledWith(false);
  });

  it("closed: when, and Reopen", async () => {
    const view = { ...BASE, state: "closed" as const, link: LINK, closedAt: new Date(2026, 10, 24, 12, 0).getTime() };
    const { host } = await bar(view);
    expect((await screen.findByText(/^Closed /)).textContent).toContain("12:00");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Reopen" })));
    expect(host.close).toHaveBeenCalledWith(true);
  });
});

describe("Responses", () => {
  it("keeps a revealed form's answers unseen until local input", async () => {
    const target = new EventTarget();
    const listen = vi.spyOn(target, "addEventListener");
    beginRevealNavigation(target, "form")();
    const host = hostOf({ ...BASE, count: 2, unseen: 2 });
    try {
      await bar(BASE, host, "responses");
      await waitFor(() => expect(host.responses).toHaveBeenCalled());
      expect(host.seen).not.toHaveBeenCalled();
    } finally {
      const keydown = listen.mock.calls.find(([kind]) => kind === "keydown")?.[1] as EventListener;
      act(() => keydown({ isTrusted: true } as Event));
    }
    expect(host.seen).toHaveBeenCalledOnce();
  });

  it("draws the answers from work.msforms.responses, with the choice question's bars, and marks them seen", async () => {
    const view = { ...BASE, state: "collecting" as const, link: LINK, count: 3 };
    const { host } = await bar(view, hostOf(view), "responses");
    expect(await screen.findByText("Marcus Lee")).toBeTruthy();
    expect(host.responses).toHaveBeenCalled();
    expect(host.seen).toHaveBeenCalled();
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Which night works?: Monday 1, Tuesday 2");
    expect(screen.getByText(/^3 responses/)).toBeTruthy();
  });

  it("is quiet about who hasn't answered where the answers carry no address", async () => {
    const view = { ...BASE, state: "collecting" as const, link: LINK, count: 3 };
    await bar(view, hostOf(view), "responses");
    await screen.findByText("Marcus Lee");
    expect(screen.queryByRole("button", { name: "Who hasn't answered" })).toBeNull();
  });

  it("says who on a pasted list hasn't answered, matched by address whatever its case, and copies their addresses", async () => {
    const withEmail: MsFormResponses = {
      ...RESPONSES,
      columns: [{ id: "email", label: "Email" }, ...RESPONSES.columns],
      rows: RESPONSES.rows.map((r, i) => [["ava@purdue.example", "marcus@purdue.example", "jordan@purdue.example"][i]!, ...r]),
    };
    const view = { ...BASE, state: "collecting" as const, link: LINK, count: 3 };
    await bar(view, hostOf(view, { responses: vi.fn(async () => withEmail) }), "responses");
    fireEvent.click(await screen.findByRole("button", { name: "Who hasn't answered" }));
    const check = await screen.findByRole("button", { name: "Check" });
    expect((check as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Paste addresses"), { target: { value: "Ava <AVA@purdue.example>, sam@purdue.example\nriley@purdue.example" } });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Check" })));
    expect(screen.getByText("2 of 3 haven't answered")).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((r) => r.textContent).slice(-2)).toEqual(["sam@purdue.example", "riley@purdue.example"]);
    const wrote: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void wrote.push(t) } });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Copy addresses" })));
    expect(wrote).toEqual(["sam@purdue.example, riley@purdue.example"]);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("says as of when the read is old", async () => {
    const view = { ...BASE, state: "collecting" as const, link: LINK, count: 3 };
    await bar(view, hostOf(view, { responses: vi.fn(async () => ({ ...RESPONSES, stale: true, at: Date.now() - 3_600_000 })) }), "responses");
    expect((await screen.findByText(/^3 responses/)).textContent).toMatch(/as of /);
  });
});

describe("the sums", () => {
  it("finds the time column and the choice question by title, and counts its options", () => {
    expect(timeColumnOf(RESPONSES)).toBe(2);
    const chart = chartOf(BASE.questions, RESPONSES)!;
    expect(chart.column).toBe(1);
    expect(answerBarsOf(RESPONSES, chart)).toEqual([
      { label: "Monday", count: 1 },
      { label: "Tuesday", count: 2 },
    ]);
  });
});

describe("an agent's waiting changes", () => {
  it("are stepped from the bar's stepper, said in words above the page, and Accept runs exactly that change", async () => {
    const view: MsFormView = {
      ...BASE,
      suggestions: [
        { id: "s1", change: { op: "add", question: { title: "When?", type: "date", required: true } }, words: 'Add a Date "When?", required', reason: "Dana asked for a date", by: "agent:env:t1", at: 0 },
        { id: "s2", change: { op: "remove", at: 0 }, words: 'Remove "Which night works?"', by: "agent:env:t1", at: 0 },
      ],
    };
    const host = hostOf(view);
    const p = props(host);
    render(<Body {...p} />);
    expect(await screen.findByText('Add a Date "When?", required')).toBeTruthy();
    expect(screen.getByText("Dana asked for a date")).toBeTruthy();
    const review = (p.shell.review as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).filter(Boolean).at(-1);
    expect(review).toMatchObject({ count: 2, index: 0 });
    await act(async () => void (await review.accept(0)));
    expect(host.review).toHaveBeenCalledWith(["s1"], []);
    await act(async () => void (await review.reject("all")));
    expect(host.review).toHaveBeenLastCalledWith([], ["s1", "s2"]);
  });
});
