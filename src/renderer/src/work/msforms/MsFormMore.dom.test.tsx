// @vitest-environment jsdom
/**
 * The Microsoft form kind's More: Open the Workbook, once Forms made it, opens it in a Files tab of the job by the
 * file the host names (the host has remembered it as Live in Excel); Question History lists each change of the
 * questions in words with when and who.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MsFormHistoryRow, MsFormView } from "@shared/contract-work-msforms";
import type { CanvasItem } from "@shared/work";
import type { CanvasShell, MoreEntry } from "../canvas/kind";
import type { MsFormHost } from "./host";

const opened = vi.hoisted(() => [] as unknown[]);
vi.mock("../files/openFrom", () => ({ openInFiles: async (ws: unknown, what: unknown) => void opened.push({ ws, what }) }));
const { Bar, Body } = await import("./MsFormCanvas");
const { byWords } = await import("./History");

const FORM = "Ob0wQVN8nEGx5YdY1tY_IQaWFXVrVqJAiq2zrvrFVrNURDVET1gyWlpLNkJXOUsyWEJXNFlKMzMxVC4u";
const VIEW = {
  workspaceId: "w1",
  formId: FORM,
  tenant: "purdue0",
  title: "Spring intramural sign-up",
  folder: { libraryId: "lib", path: "Esports", siteUrl: "https://purdue0.sharepoint.com/sites/RecWell" },
  workbook: null,
  state: "collecting",
  mode: "suggests",
  settings: { accepting: true, orgOnly: true, recordName: true, onePerPerson: true },
  questions: [{ title: "Which night works?", type: "choice", options: ["Monday", "Tuesday"], required: true }],
  rev: 2,
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
} as unknown as MsFormView;
const BOOK = { libraryId: "lib", path: "Esports/Spring intramural sign-up.xlsx", siteUrl: "https://purdue0.sharepoint.com/sites/RecWell", uniqueId: "u1", parentId: "p1", name: "Spring intramural sign-up.xlsx" };
const FILE = { ref: { at: "file" as const, host: "env", path: "C:\\Users\\tcuser\\RecWell\\Esports\\Spring intramural sign-up.xlsx" }, name: "Spring intramural sign-up.xlsx" };
const HISTORY: MsFormHistoryRow[] = [
  { rev: 2, at: new Date(2026, 10, 24, 13, 5).getTime(), by: "agent:env:t1", words: ['Add a Date "When?", required'] },
  { rev: 1, at: new Date(2026, 10, 24, 12, 0).getTime(), by: "owner", words: ["Made with a Choice question"] },
];

function hostOf(view: MsFormView): MsFormHost {
  const same = () => vi.fn(async () => view);
  return { get: same(), collect: same(), close: same(), mode: same(), check: same(), review: same(), responses: vi.fn(), refresh: same(), seen: same(), prefill: vi.fn(), history: vi.fn(async () => HISTORY), workbook: vi.fn(async () => FILE), watch: () => () => undefined } as unknown as MsFormHost;
}
let n = 0;
function draw(view: MsFormView) {
  const host = hostOf(view);
  const shell = { review: vi.fn(), selection: vi.fn(), presence: vi.fn(), mode: vi.fn(), statusLine: vi.fn(), written: vi.fn(), detail: vi.fn(), openHistory: vi.fn(), held: vi.fn(), more: vi.fn(), ready: vi.fn() } as unknown as CanvasShell;
  const item = { id: `more-${++n}`, sessionId: "t1", workspaceId: "w1", kind: "msform", title: view.title, source: { at: "msform", host: "env", workspaceId: "w1", formId: FORM, tenant: "purdue0" }, state: "open", position: 0, rev: 0, createdAt: 0, updatedAt: 0 } as CanvasItem;
  const p = { item, source: item.source, env: "env", state: { half: "form" as const }, setState: () => undefined, shell, host };
  render(
    <>
      <Bar {...p} />
      <Body {...p} />
    </>,
  );
  const more = (): MoreEntry[] => ((shell.more as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).filter(Boolean).at(-1) ?? []) as MoreEntry[];
  return { host, more };
}

afterEach(cleanup);

describe("More on a Microsoft form", () => {
  it("offers Open the Workbook only once Forms made it, and opens it in Files by the file the host names", async () => {
    const before = draw(VIEW);
    await waitFor(() => expect(before.more().length).toBeGreaterThan(0));
    expect(before.more().map((e) => e.label)).not.toContain("Open the Workbook");
    cleanup();

    const { host, more } = draw({ ...VIEW, workbook: BOOK });
    await waitFor(() => expect(more().map((e) => e.label)).toContain("Open the Workbook"));
    await act(async () => void more().find((e) => e.id === "workbook")!.run());
    await waitFor(() => expect(opened).toEqual([{ ws: { id: "w1", environmentId: "env" }, what: FILE }]));
    expect(host.workbook).toHaveBeenCalledOnce();
  });

  it("opens Question History: each change in words, with who and when", async () => {
    const { host, more } = draw(VIEW);
    await waitFor(() => expect(more().map((e) => e.label)).toContain("Question History…"));
    await act(async () => void more().find((e) => e.id === "history")!.run());
    expect(await screen.findByText('Add a Date "When?", required')).toBeTruthy();
    expect(screen.getByText(/^An agent · /).textContent).toContain("1:05");
    expect(screen.getByText(/^You · /)).toBeTruthy();
    expect(screen.getByText("Made with a Choice question")).toBeTruthy();
    expect(host.history).toHaveBeenCalledOnce();
  });

  it("names who made a change", () => {
    expect(byWords("owner")).toBe("You");
    expect(byWords("page")).toBe("Seen in the page");
    expect(byWords("agent:env:t1")).toBe("An agent");
  });
});
