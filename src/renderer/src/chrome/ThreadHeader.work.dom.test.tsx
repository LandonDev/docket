// @vitest-environment jsdom
/**
 * The title bar with a Work thread in front: its ⋯ menu has no terminal row
 * and no project plan chip shows. A code thread in front keeps both.
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const scope = vi.hoisted(() => ({ work: false }));
vi.mock("../lib/useWorkSession", () => ({ useWorkSessionId: () => scope.work }));
vi.mock("./useThreadMenu", () => ({ useThreadMenu: () => ({ rowsFor: () => [], onPick: () => {}, onOpenChange: () => {}, dialogs: null }) }));
vi.mock("./ThreadHostChip", () => ({ useThreadHost: () => ({ host: null }) }));
vi.mock("../lib/masterThread", () => ({ useMasterIds: () => new Set<string>() }));
vi.mock("./AgentsCue", () => ({ AgentsCue: () => null }));
vi.mock("./ComputerCue", () => ({ ComputerCue: () => null }));
vi.mock("./NewThreadChooser", () => ({ NewThreadChooser: () => null }));
vi.mock("./ProjectPlanChip", () => ({ ProjectPlanChip: () => <span data-testid="plan-chip" /> }));
vi.mock("./ThreadHeaderStrip", () => ({ ThreadHeaderStrip: ({ end }: { end: ReactNode }) => <div>{end}</div> }));
vi.mock("./ThreadMenu", () => ({
  ThreadMenu: ({ terminal }: { terminal: { onShow?: () => void; onNew?: () => void } }) => (
    <span data-testid="thread-menu" data-terminal={String(!!(terminal.onShow || terminal.onNew))} />
  ),
}));

import { ThreadHeader } from "./ThreadHeader";

afterEach(cleanup);

const mount = () =>
  render(
    <ThreadHeader
      model={{ activeId: "t1", live: [], dormant: [] } as never}
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

  it("a code thread in front keeps both", () => {
    mount();
    expect(screen.getByTestId("thread-menu").dataset.terminal).toBe("true");
    expect(screen.getByTestId("plan-chip")).toBeTruthy();
  });
});
