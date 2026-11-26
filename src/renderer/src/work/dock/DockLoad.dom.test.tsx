// @vitest-environment jsdom
/**
 * A docked chat whose first transcript read failed (Dock.tsx `DockChat`): its Retry line stands alone, with no
 * bones under it that say "Loading chat"; while a read is under way, the bones are back. Either way its composer is
 * there: a known thread takes his words before its rows come.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../lib/session";
import type { SessionMeta } from "../../lib/tcserver/types";

const h = vi.hoisted(() => ({ meta: null as SessionMeta | null, session: undefined as Session | undefined }));
vi.mock("../../lib/threads/agents", () => ({ useMetaById: () => h.meta, useSessionById: () => h.session }));
vi.mock("../../surfaces/threadChat", () => ({
  useSessionActions: () => ({}),
  useThreadChat: () => ({ renderChat: () => null, renderSlots: () => null, composerOf: () => <div data-composer-input contentEditable />, newPassArmed: false, armNewPass: () => undefined }),
}));
vi.mock("../../surfaces/threads/ThreadView", () => ({ ThreadView: () => <div data-testid="thread-view" /> }));
const retryLoad = vi.hoisted(() => vi.fn());
vi.mock("../../lib/tcserver/store", async (original) => ({ ...(await original<typeof import("../../lib/tcserver/store")>()), sessionStore: { retryLoad } }));
vi.mock("../../chrome/ConnectionLine", () => ({ useEnvironmentBlock: () => ({ name: "the box", degraded: null }) }));
vi.mock("../../surfaces/SessionPane", () => ({
  LoadLine: ({ load, onRetry }: { load: { phase: string }; onRetry: () => void }) => (load.phase === "failed" ? <button onClick={onRetry}>Retry now</button> : null),
}));
vi.mock("./dockThread", () => ({
  dockThreadNow: () => ({ id: "c1", draft: false }),
  findThread: async () => null,
  draftIsEmpty: () => true,
  showFound: () => undefined,
  plannedDraft: () => undefined,
  enterDock: () => undefined,
  leaveDock: () => undefined,
}));

const { Dock } = await import("./Dock");
const { seatedSession } = await import("../../lib/toastAnchor");

afterEach(() => {
  cleanup();
  h.meta = null;
  h.session = undefined;
});

const draw = () =>
  render(<Dock name="files" workspace={{ id: "w1", environmentId: "box" } as never} subject={null} chip={null} focus={false} preset={{ id: "c1", draft: false }} head={() => null} onChipTaken={() => undefined} onClose={() => undefined} />);
const bones = () => document.querySelector('[data-surface-skeleton="transcript"]');

describe("a docked chat's first read", () => {
  it("draws its Retry line alone once the read failed", () => {
    h.meta = { id: "c1", environmentId: "box", title: "Budget" } as SessionMeta;
    h.session = { id: "c1", blocks: [], load: { phase: "failed", since: 0, attempt: 2 } } as unknown as Session;
    draw();
    expect(bones()).toBeNull();
    expect(document.querySelector("[data-composer-input]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(retryLoad).toHaveBeenCalledWith("c1");
  });

  it("keeps the bones while a read is under way", () => {
    h.meta = { id: "c1", environmentId: "box", title: "Budget" } as SessionMeta;
    h.session = { id: "c1", blocks: [], load: { phase: "loading", since: 0, attempt: 3 } } as unknown as Session;
    draw();
    expect(bones()).not.toBeNull();
    expect(document.querySelector("[data-composer-input]")).not.toBeNull();
  });

  it("seats the toast stack over its composer while the rows come, so the thread on screen gets no toast of its own", () => {
    h.meta = { id: "c1", environmentId: "box", title: "Budget" } as SessionMeta;
    h.session = { id: "c1", blocks: [], load: { phase: "loading", since: 0, attempt: 1 } } as unknown as Session;
    draw();
    expect(document.querySelector("[data-toast-anchor]")?.getAttribute("data-toast-anchor")).toBe("c1");
    expect(seatedSession()).toBe("c1");
    cleanup();
    expect(seatedSession()).toBeNull();
  });
});
