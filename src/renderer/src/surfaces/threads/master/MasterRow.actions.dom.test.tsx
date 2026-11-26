import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A board row's Pause, Resume and Start now say a refusal, never swallow it. */

const h = vi.hoisted(() => ({ actionFailed: vi.fn(), pause: vi.fn(), resume: vi.fn(), startNow: vi.fn() }));
vi.mock("../../../lib/threadActionToast", () => ({ actionFailed: h.actionFailed }));
vi.mock("../../../lib/tcserver/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/tcserver/commands")>()),
  pause: h.pause,
  resume: h.resume,
  startNow: h.startNow,
}));

import { sessionStore } from "../../../lib/tcserver/store";
import { FakeMetaLink } from "../../../test/fakeMetaLink";
import { MasterRow } from "./MasterRow";
import { standInMeta, type BoardRowRef } from "./useMasterModel";

const menu = { rowsFor: () => null, onPick: () => {}, onOpenChange: () => {} };
const ref = (fallback: BoardRowRef["fallback"]): BoardRowRef => ({
  key: fallback!.id,
  id: fallback!.id,
  planId: null,
  group: "running",
  done: false,
  environmentId: fallback!.environmentId,
  fallback,
  override: null,
});

describe("a board row's state verb", () => {
  beforeEach(async () => {
    sessionStore.reset();
    sessionStore.attach(new FakeMetaLink());
    await sessionStore.ready();
  });
  afterEach(() => {
    cleanup();
    sessionStore.reset();
    vi.clearAllMocks();
  });

  for (const [status, label, verb, command] of [
    ["running", "Pause", "pause it", "pause"],
    ["paused", "Continue", "continue it", "resume"],
    ["stopped", "Resume", "resume it", "resume"],
    ["queued", "Start now", "start it now", "startNow"],
  ] as const) {
    it(`a refused ${label} toasts "Couldn't ${verb}" with the thread and the host's reason`, async () => {
      const refusal = new Error("this thread is moving to another host");
      h[command].mockRejectedValueOnce(refusal);
      const meta = standInMeta({ sessionId: "c1", environmentId: "local", title: "Home screen", status, provider: "claude", model: "claude-opus-5-5" }, "m");
      render(<MasterRow rowRef={ref(meta)} landed={false} host={null} onOpen={() => {}} menu={menu} />);
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(h.actionFailed).toHaveBeenCalledWith(verb, "Home screen", refusal));
    });
  }
});

// boards-03, -04 (D5): a row whose host is away, or whose key may not, keeps Message alone; it reads muted by role.
describe("a board row the host would refuse", () => {
  beforeEach(async () => {
    sessionStore.reset();
    sessionStore.attach(new FakeMetaLink());
    await sessionStore.ready();
  });
  afterEach(() => {
    cleanup();
    sessionStore.reset();
    vi.restoreAllMocks();
  });
  const meta = () => standInMeta({ sessionId: "c1", environmentId: "local", title: "Home screen", status: "running", provider: "claude", model: "claude-opus-5-5" }, "m");

  it("keeps Message alone while its host is away, and dims the title by role, never the row by opacity", () => {
    const { container } = render(<MasterRow rowRef={ref(meta())} landed={false} host={{ id: "local", name: "The box", offline: true } as never} onOpen={() => {}} menu={menu} />);
    expect(screen.getByRole("button", { name: "Message" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Thread actions" })).toBeNull();
    expect((container.firstElementChild as HTMLElement).className).not.toContain("opacity-50");
    expect(container.querySelector("[data-row-title]")!.className).toContain("text-muted-foreground");
  });

  it("keeps Message alone for a key that may only read", async () => {
    const { registry } = await import("../../../lib/connection");
    vi.spyOn(registry, "statusOf").mockReturnValue({ transport: "open", lastHello: { environmentId: "local", contract: 3, caps: ["read"], key: { id: "k", name: "Laptop" } } } as never);
    render(<MasterRow rowRef={ref(meta())} landed={false} host={null} onOpen={() => {}} menu={menu} />);
    expect(screen.getByRole("button", { name: "Message" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });
});
