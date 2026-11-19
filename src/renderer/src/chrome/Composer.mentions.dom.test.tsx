// @vitest-environment jsdom
/**
 * The composer's `@` for Work (docs/agents/work-canvas.md "Mentions"): in a
 * Work thread the host's answer leads the list, grouped by kind with each
 * kind's glyph; a pick takes the typed `@words` out and puts the thing in the
 * composer as a chip; a code thread outside every linked workspace never asks.
 * The host is a fake: no mail or task here is anyone's.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { MentionAnswer } from "@shared/work";
import type { SessionMeta } from "../lib/tcserver/types";

const search = vi.hoisted(() => vi.fn());
vi.mock("./ComposerBar", async (importOriginal) => ({ ...(await importOriginal<typeof import("./ComposerBar")>()), useDraftRow: () => false }));
vi.mock("../lib/contextCache", () => ({ useContextReading: () => null }));
vi.mock("../lib/tcserver/slashCommands", () => ({ useSlashCommands: () => ({ commands: [], loaded: true, failed: false }) }));
vi.mock("../work/canvas/mentions", async (importOriginal) => {
  const real = await importOriginal<typeof import("../work/canvas/mentions")>();
  // The host is the fake; where the thread is and the rows are the chunk's own.
  const askWorkMentions = async (env: string, sessionId: string, text: string) => {
    const draft = real.mentionPlace(sessionId);
    return draft ? real.resultOf(await search(env, sessionId, text, draft), !!draft.work) : null;
  };
  return { ...real, askWorkMentions };
});

import { Composer } from "./Composer";
import { commandMenuChunk, workCanvasChunk } from "../surfaces/chunks";
import { contextChipsOf, resetContextChips } from "../work/canvas/chips";
import { sessionStore } from "../lib/tcserver/store";
import { setWorkOn, workSwitch } from "../lib/workSwitch";

const answer: MentionAnswer = {
  hits: [
    { chip: { kind: "task", label: "Book the ballroom", ref: { at: "lifeos", table: "tasks", id: "k1" }, excerpt: "For April 10" } },
    { chip: { kind: "mail", label: "Re: Ballroom", ref: { at: "lifeos", table: "mailThreads", id: "m1" } }, detail: "Sam" },
    { chip: { kind: "held", label: "Reply to Dana", ref: { at: "work", pillar: "outbox", id: "h1" } }, detail: "Send" },
  ],
  failed: [],
};

beforeAll(async () => {
  Element.prototype.scrollIntoView = () => {};
  await commandMenuChunk.load();
  await workCanvasChunk.load();
});
beforeEach(() => {
  resetContextChips();
  search.mockReset();
  workSwitch.reset();
});
afterEach(cleanup);

const meta = (id: string, over: Partial<SessionMeta>): SessionMeta => ({ id, title: id, status: "idle", environmentId: "env_a", projectId: null, workspaceId: null, updatedAt: 1, ...over }) as SessionMeta;
const noop = () => {};
const props = (sessionId: string): ComponentProps<typeof Composer> => ({
  focused: false,
  harness: "claude",
  model: "claude:opus-5.5",
  runtimeMode: "supervised",
  executionCwd: "/w/Chats",
  sessionId,
  onFocus: noop,
  onCwdChange: noop,
  onModelChange: noop,
  onRuntimeModeChange: noop,
  onSubmit: noop,
});

function type(field: HTMLElement, text: string) {
  act(() => {
    field.append(document.createTextNode(text));
    const range = document.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("@ in a Work thread", () => {
  it("asks the thread's host, draws its things grouped by kind, and a pick becomes a chip", async () => {
    sessionStore.adopt(meta("w1", { scope: "work" }));
    setWorkOn("env_a", true);
    search.mockResolvedValue(answer);
    const { container } = render(<Composer {...props("w1")} />);
    const field = container.querySelector<HTMLElement>("[data-composer-input]")!;
    field.focus();
    type(field, "@ball");
    // Until the host answers, one muted row says the list is still coming.
    expect(container.querySelector("[data-command-empty]")?.textContent).toBe("Loading…");
    await waitFor(() => expect(container.querySelectorAll("[data-mention]")).toHaveLength(3));
    expect(search).toHaveBeenLastCalledWith("env_a", "w1", "ball", { projectId: null, workspaceId: null, work: true });
    const rows = [...container.querySelectorAll<HTMLElement>("[data-mention]")];
    expect(rows.map((r) => r.dataset.mention)).toEqual(["task", "mail", "held"]);
    for (const r of rows) expect(r.querySelector("svg")).not.toBeNull();
    expect(rows[1].textContent).toBe("Re: BallroomSam");
    // Each kind under its group's name, and the leading kind too, since files may follow.
    const labels = [...container.querySelectorAll("[data-command-popover] [role=listbox] > div > div:first-child")].map((d) => d.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Tasks", "Mail", "Outbox"]));
    // Keyboard first: down, Enter.
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(contextChipsOf("w1")).toEqual([answer.hits[1].chip]));
    expect(field.textContent).toBe("");
  });

  it("keeps an earlier answer's rows that still match while the next is on its way", async () => {
    sessionStore.adopt(meta("w4", { scope: "work" }));
    setWorkOn("env_a", true);
    search.mockResolvedValueOnce(answer).mockReturnValue(new Promise(() => {}));
    const { container } = render(<Composer {...props("w4")} />);
    const field = container.querySelector<HTMLElement>("[data-composer-input]")!;
    field.focus();
    type(field, "@ball");
    await waitFor(() => expect(container.querySelectorAll("[data-mention]")).toHaveLength(3));
    type(field, "r");
    // "Reply to Dana" does not hold "ballr"; the two that do stay until the host answers "ballr".
    expect([...container.querySelectorAll("[data-mention]")].map((r) => r.getAttribute("data-mention"))).toEqual(["task", "mail"]);
  });

  it("says so in one muted row when LifeOS could not be searched", async () => {
    sessionStore.adopt(meta("w2", { scope: "work" }));
    setWorkOn("env_a", true);
    search.mockResolvedValue({ hits: [answer.hits[2]], failed: ["task", "mail"] });
    const { container } = render(<Composer {...props("w2")} />);
    const field = container.querySelector<HTMLElement>("[data-composer-input]")!;
    field.focus();
    type(field, "@");
    await waitFor(() => expect(container.querySelector("[data-command-note]")?.textContent).toBe("Couldn't reach LifeOS"));
  });
});

describe("@ in a code thread", () => {
  it("never asks for Work's things outside a workspace linked to a sector, nor while Work is off", async () => {
    sessionStore.adopt(meta("c1", {}));
    sessionStore.adopt(meta("w3", { scope: "work" }));
    const view = render(<Composer {...props("c1")} />);
    let field = view.container.querySelector<HTMLElement>("[data-composer-input]")!;
    field.focus();
    setWorkOn("env_a", true);
    type(field, "@ball");
    await act(async () => {});
    cleanup();
    // A Work thread on a host with Work off asks nothing either.
    setWorkOn("env_a", false);
    const work = render(<Composer {...props("w3")} />);
    field = work.container.querySelector<HTMLElement>("[data-composer-input]")!;
    field.focus();
    type(field, "@ball");
    await act(async () => {});
    expect(search).not.toHaveBeenCalled();
  });
});
