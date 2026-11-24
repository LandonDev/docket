// @vitest-environment jsdom
/**
 * The host out of reach, said once (docs/DESIGN.md "Work: a thread's chat"): in a Work thread the connection line
 * over the box says it and the field keeps its own placeholder; a code thread's composer is unchanged, its field
 * still saying it too. Send waits in both.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ props: null as null | { blocked?: string | null; blockedSaid?: boolean }, work: false }));
vi.mock("../lib/tcserver/store", () => ({
  sessionStore: { isDraft: () => false, metaOf: () => null },
  useQueue: () => [],
  useSessionMetasWhen: () => [],
}));
vi.mock("../lib/workRow", async (original) => ({ ...(await original<typeof import("../lib/workRow")>()), useWorkSession: () => h.work }));
vi.mock("../chrome/ConnectionLine", () => ({ useEnvironmentBlock: () => ({ degraded: { kind: "offline" }, name: "the box", text: "The box is offline" }), ConnectionLine: () => <div data-testid="line" /> }));
vi.mock("../chrome/Composer", () => ({
  Composer: (props: { blocked?: string | null; blockedSaid?: boolean }) => {
    h.props = props;
    return <div data-testid="composer" />;
  },
}));
vi.mock("../chrome/MacBridgeCards", () => ({ MacBridgeThreadCards: () => null }));
vi.mock("../lib/macBridge", () => ({ useMacBridgeRequests: () => [] }));
vi.mock("../chrome/MessageQueue", () => ({ MessageQueue: () => null, visibleQueue: (items: unknown[]) => items }));
vi.mock("../chrome/SessionReview", () => ({ SessionReview: () => null }));
vi.mock("../lib/tcserver/commands", () => ({ startNow: () => Promise.resolve(), resume: () => Promise.resolve(), killBackground: () => Promise.resolve(), preconnect: () => Promise.resolve(), preconnectDraft: () => Promise.resolve() }));
import { newSession, type Session } from "../lib/session";
import { ThreadComposer, type SessionActions } from "./threadChat";

const noop = () => {};
const actions = { onSubmit: noop, onStop: noop, onApproval: noop } as unknown as SessionActions;
const session = { ...newSession("/repo"), id: "s1", environmentId: "box" } as Session;
const draw = () => render(<ThreadComposer session={session} actions={actions} visible focused={false} hotkeys={false} onFocus={noop} onOpenDiff={noop} />);

afterEach(() => {
  cleanup();
  h.props = null;
});

describe("a host out of reach in the composer", () => {
  it("leaves a code thread's composer as it was: the field says it, send waits", () => {
    h.work = false;
    draw();
    expect(h.props).toMatchObject({ blocked: "The box is offline", blockedSaid: false });
  });

  it("says it once in a Work thread: the line over the box, the field its own placeholder, send waits", () => {
    h.work = true;
    draw();
    expect(h.props).toMatchObject({ blocked: "The box is offline", blockedSaid: true });
  });
});
