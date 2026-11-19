// @vitest-environment jsdom
/**
 * A sent message's chips (docs/agents/work-canvas.md "Mentions"): the lines
 * the model read are drawn as chips over his words, and
 * a chip that names something this window can show opens it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { Block } from "../../lib/session";
import type { SessionMeta } from "../../lib/tcserver/types";

const opened = vi.hoisted(() => ({ items: [] as unknown[], held: [] as unknown[] }));
vi.mock("../../work/canvas/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../work/canvas/store")>()),
  openItem: async (...args: unknown[]) => void opened.items.push(args),
}));
vi.mock("../../work/canvas/held", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../work/canvas/held")>()),
  openHeld: (...args: unknown[]) => void opened.held.push(args),
}));

import { UserMessageBlock } from "./UserMessage";
import { TranscriptSessionContext } from "../transcriptSession";
import { sessionStore } from "../../lib/tcserver/store";
import { useWorkView, workSwitch } from "../../lib/workSwitch";

const text = [
  "About this task: Book the ballroom (LifeOS tasks k1)",
  "> For April 10",
  "About this held act: Reply to Dana (Work outbox h1)",
  "About this item: Budget (canvas item i1)",
  "About this person: Dana Ruiz (LifeOS people u1)",
  "",
  "Say what the insurance must cover.",
].join("\n");
const user: Block = { id: "u", role: "user", text, ts: 1 };

let view: ReturnType<typeof useWorkView> = null;
function Watch() {
  view = useWorkView();
  return null;
}
const mount = () =>
  render(
    <TranscriptSessionContext.Provider value="w1">
      <UserMessageBlock block={user} stickyIndex={1} environmentId="env_a" />
      <Watch />
    </TranscriptSessionContext.Provider>,
  );

beforeEach(() => {
  opened.items.length = 0;
  opened.held.length = 0;
  workSwitch.reset();
  sessionStore.adopt({ id: "w1", title: "w1", status: "idle", environmentId: "env_a", scope: "work", projectId: null, workspaceId: "ws-purdue", updatedAt: 1 } as SessionMeta);
});
afterEach(cleanup);

describe("a sent message's chips", () => {
  it("are drawn over his words, the lines and their quotes gone from the text, the copy still whole", async () => {
    const { container } = mount();
    const bubble = container.querySelector<HTMLElement>("[data-user-bubble]")!;
    // Read back by the work-canvas chunk, asked for only because the message may hold chip lines.
    await waitFor(() => expect(bubble.querySelector("[data-sent-chips]")).not.toBeNull());
    const labels = [...bubble.querySelectorAll("[data-sent-chips] li")].map((li) => li.textContent);
    expect(labels).toEqual(["Book the ballroom", "Reply to Dana", "Budget", "Dana Ruiz"]);
    expect(bubble.querySelector("pre")?.textContent).toBe("Say what the insurance must cover.");
    for (const li of bubble.querySelectorAll("[data-sent-chips] li")) expect(li.querySelector("svg")).not.toBeNull();
  });

  it("open the task's view, the held act, the item; a person is a label", async () => {
    const { container } = mount();
    await waitFor(() => expect(container.querySelector("[data-sent-chips]")).not.toBeNull());
    const chip = (kind: string) => container.querySelector<HTMLElement>(`[data-sent-chips] [data-chip="${kind}"]`)!;
    expect(chip("person").querySelector("button")).toBeNull();
    await act(async () => fireEvent.click(chip("task").querySelector("button")!));
    expect(view).toEqual({ workspaceId: "ws-purdue", view: "tasks" });
    await act(async () => fireEvent.click(chip("held").querySelector("button")!));
    expect(opened.held).toEqual([[{ at: "host", id: "h1" }, "env_a"]]);
    await act(async () => fireEvent.click(chip("item").querySelector("button")!));
    expect(opened.items).toEqual([["env_a", "w1", { itemId: "i1" }]]);
  });
});
