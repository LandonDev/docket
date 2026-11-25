// @vitest-environment jsdom
/**
 * The title bar with a Work thread in front: its ⋯ menu has no terminal row
 * and no project plan chip shows, and it is the thread's crumb with no strip
 * of chips. A code thread in front keeps all three.
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const scope = vi.hoisted(() => ({ work: false }));
vi.mock("../lib/workRow", () => ({ useWorkSessionId: () => scope.work }));
vi.mock("./useThreadMenu", () => ({ useThreadMenu: () => ({ rowsFor: () => [], onPick: () => {}, onOpenChange: () => {}, dialogs: null }) }));
vi.mock("./ThreadHostChip", () => ({ useThreadHost: () => ({ host: null }) }));
vi.mock("../lib/masterThread", () => ({ useMasterIds: () => new Set<string>() }));
vi.mock("./AgentsCue", () => ({ AgentsCue: () => null }));
vi.mock("./ComputerCue", () => ({ ComputerCue: () => null }));
vi.mock("./NewThreadChooser", () => ({ NewThreadChooser: () => null }));
vi.mock("./ProjectPlanChip", () => ({ ProjectPlanChip: () => <span data-testid="plan-chip" /> }));
vi.mock("./ThreadHeaderStrip", () => ({
  ThreadHeaderStrip: ({ end, crumb, model }: { end: ReactNode; crumb?: ReactNode; model: { live: unknown[]; dormant: unknown[]; heading?: { id: string } | null } }) => (
    <div data-testid="strip" data-chips={model.live.length + model.dormant.length} data-heading={model.heading?.id ?? ""}>
      {crumb}
      {end}
    </div>
  ),
}));
vi.mock("./WorkCrumb", () => ({
  WorkCrumb: ({ last, thread }: { last?: boolean; thread: { projectId?: string | null } }) => <span data-testid="crumb" data-last={String(!!last)} data-project={thread.projectId ?? ""} />,
}));
vi.mock("./ThreadMenu", () => ({
  ThreadMenu: ({ terminal }: { terminal: { onShow?: () => void; onNew?: () => void } }) => (
    <span data-testid="thread-menu" data-terminal={String(!!(terminal.onShow || terminal.onNew))} />
  ),
}));

import { ThreadHeader } from "./ThreadHeader";
import { sessionStore } from "../lib/tcserver/store";

afterEach(cleanup);

const chip = (id: string) => ({ id, thread: { id, title: id, threadType: "chat", projectId: "p1", workspaceId: null }, tabId: null, live: true, status: "idle", unread: false, updatedAt: 0 });

const mount = (over: { activeId?: string | null; onScreenId?: string } = {}) =>
  render(
    <ThreadHeader
      model={{ activeId: over.activeId === undefined ? "t1" : over.activeId, live: [chip("t1"), chip("t2")], dormant: [chip("t3")] } as never}
      onScreenId={over.onScreenId}
      planReady={new Map() as never}
      archived={[]}
      workspaceId="w1"
      cost={null}
      running={0}
      railOpen={false}
      onSelect={() => {}}
      onRename={() => {}}
      onArchive={() => {}}
      onDelete={() => {}}
      onSetRules={() => {}}
      onRestore={() => {}}
      onNew={() => {}}
      onPauseAll={async () => {}}
      onToggleRail={() => {}}
      onSetType={() => {}}
      onShowTerminal={() => {}}
      onNewTerminal={() => {}}
      stripRef={() => {}}
      activeRef={() => {}}
    />,
  );

describe("ThreadHeader", () => {
  it("a Work thread in front: no terminal row, no project plan chip", () => {
    scope.work = true;
    mount();
    expect(screen.getByTestId("thread-menu").dataset.terminal).toBe("false");
    expect(screen.queryByTestId("plan-chip")).toBeNull();
    scope.work = false;
  });

  it("a Work thread in front is its crumb: no strip of chips, its own title as the bar's heading", () => {
    scope.work = true;
    mount();
    const strip = screen.getByTestId("strip");
    expect(strip.dataset.chips).toBe("0");
    expect(strip.dataset.heading).toBe("t1");
    expect(screen.getByTestId("crumb")).toBeTruthy();
    scope.work = false;
  });

  it("a code thread in front keeps both", () => {
    mount();
    expect(screen.getByTestId("thread-menu").dataset.terminal).toBe("true");
    expect(screen.getByTestId("plan-chip")).toBeTruthy();
    expect(screen.getByTestId("strip").dataset.chips).toBe("3");
    expect(screen.queryByTestId("crumb")).toBeNull();
  });

  it("an unsent Work draft in front is its crumb alone: the job's dot and its project, no chips, no title", () => {
    scope.work = true;
    sessionStore.mutate((prev) => [...prev, { id: "d1", environmentId: "local", workspaceId: "w1", projectId: "p-lan", blocks: [] } as never]);
    mount({ activeId: null, onScreenId: "d1" });
    const strip = screen.getByTestId("strip");
    expect(strip.dataset.chips).toBe("0");
    expect(strip.dataset.heading).toBe("");
    expect(screen.getByTestId("crumb").dataset.last).toBe("true");
    expect(screen.getByTestId("crumb").dataset.project).toBe("p-lan");
    scope.work = false;
  });

  it("a code draft in front keeps the strip", () => {
    sessionStore.mutate((prev) => [...prev, { id: "d2", environmentId: "local", workspaceId: "w-code", projectId: null, blocks: [] } as never]);
    mount({ activeId: null, onScreenId: "d2" });
    expect(screen.getByTestId("strip").dataset.chips).toBe("3");
    expect(screen.queryByTestId("crumb")).toBeNull();
  });
});
