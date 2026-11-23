// @vitest-environment jsdom
/**
 * The view as the app mounts it (`View`), from a cold start: the LifeOS session has no client
 * yet, then gets one. The screens under it must read through the same hooks before and after,
 * or React throws as the list turns from bones into rows.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LifeosSession } from "../shell/lifeos";
import type { WorkViewProps } from "../views/registry";
import { CHATS } from "./fixtures";
import { resetPages } from "./page";

vi.mock("../shell/open", () => ({ openConnections: () => {} }));

const { registry } = await import("../../lib/connection");
const { View } = await import("./MessagesView");
// The host answers no drafts and no canvas items: the pane beside the conversation is empty.
vi.spyOn(registry, "linkOf").mockReturnValue({ request: async () => ({ drafts: [], items: [] }), onPush: () => () => {} } as never);

beforeAll(() => {
  if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  resetPages();
});

/** A Convex client that answers each watched query from a table, at once. */
function client(answers: Record<string, unknown>): NonNullable<LifeosSession["client"]> {
  const fake = {
    watchQuery: (ref: unknown) => ({ localQueryResult: () => answers[getFunctionName(ref as never)], onUpdate: () => () => {} }),
    mutation: async () => null,
  };
  return fake as unknown as NonNullable<LifeosSession["client"]>;
}

const props = (lifeos: LifeosSession): WorkViewProps => ({ env: "box", workspace: { id: "ws", environmentId: "box" } as WorkViewProps["workspace"], sector: "cosmic", lifeos, startThread: () => {} });

describe("the view from a cold start", () => {
  it("draws bones while the session opens and rows once its client lands, with no change in its hooks", () => {
    const failed = vi.spyOn(console, "error").mockImplementation(() => {});
    const opening: LifeosSession = { environmentId: "box", sector: "cosmic", client: null, state: "connecting" };
    const view = render(<View {...props(opening)} />);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(document.querySelector("[data-slot=skeleton]")).not.toBeNull();
    const live: LifeosSession = {
      ...opening,
      state: "connected",
      client: client({ "chats:list": { page: CHATS.slice(0, 3), isDone: true, continueCursor: "" }, "chats:unread": { count: 1 }, "sources:list": [{ _id: "s", kind: "slack", label: "Starboard Games", status: "ok", lastSyncAt: Date.now(), enabled: true }] }),
    };
    act(() => view.rerender(<View {...props(live)} />));
    expect(screen.getAllByRole("option")).toHaveLength(3);
    // React says so on the console when a component's hooks change between renders.
    expect(failed.mock.calls.flat().join(" ")).not.toMatch(/hooks|Rendered more/i);
    failed.mockRestore();
  });

  it("draws nothing under a session that failed: the frame says why", () => {
    const { container } = render(<View {...props({ environmentId: "box", sector: "cosmic", client: null, state: "unreachable" })} />);
    expect(container.textContent).toBe("");
  });
});
