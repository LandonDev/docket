// bun run ui:preview src/renderer/src/surfaces/threads/master/board.preview.tsx#MasterPreview --shot --fresh
// Exports BoardPreview, TaskBarPreview, TaskBarWidthPreview, MasterPreview,
// MasterReadOnly, MasterOffline, MasterRowFailed, MasterRevealed, MasterAtCap and MasterFolded.
// A data-popup-open marker holds the row's reveal. Drag, hover timing and Retry need a live page.
import { useEffect, useRef } from "react";
import { setHarnessModels } from "../../../lib/models";
import { RowBoundary } from "./RowBoundary";
import { nameInLine } from "../../../lib/hostWords";
import type { BatchState } from "@server/shared/contract-batch";
import { HostGlyph } from "../../../chrome/HostGlyph";
import { MoreHorizontal, Plus } from "../../../chrome/icons";
import { Button } from "../../../components/ui/button";
import { HeldTip } from "../../../components/heldTip";
import { SplitShell } from "../SplitShell";
import { BatchFoot } from "./BatchFoot";
import { BOARD_FIXTURE_CLOCK, FIXTURE_BATCH, FIXTURE_ROWS, fixtureGroups, TASK_BAR_ROWS, TASK_BAR_WIDTH_ROWS, type FixtureRow } from "./boardFixture";
import { MasterRowView } from "./MasterRow";

/**
 * The board drawn from boardFixture.ts with no store, for `bun run
 * ui:preview` and the dom test that keeps the fixture honest. Rendered by
 * nothing in the app.
 */

const noop = () => {};
setHarnessModels("codex", [{ id: "codex:gpt-6.1-sol", nativeId: "gpt-6.1-sol", harness: "codex", name: "GPT-6.1 Sol" }]);
function BrokenRow(): never { throw new Error("Preview row read failed"); }

/** The far row's host glyph (drawn once the window knows two hosts). */
const hostGlyph = (environmentId: string) => (environmentId === "local" ? null : <HostGlyph environmentId={environmentId} className="shrink-0" />);
const tally = `${FIXTURE_ROWS.filter((r) => r.meta.status === "idle").length}/${FIXTURE_ROWS.length}`;

export function BoardPreview({
  rows = FIXTURE_ROWS, foot = true, offline = false, failed = false, reveal = false, batch = FIXTURE_BATCH, access = "owner",
}: { rows?: readonly FixtureRow[]; foot?: boolean; offline?: boolean; failed?: boolean; reveal?: boolean; batch?: BatchState; access?: "owner" | "read" | "held" }) {
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reveal) frame.current?.querySelector("[data-actions] button")?.setAttribute("data-popup-open", "");
  }, [reveal]);
  return (
    <div ref={frame} className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1 pt-1 pb-2">
      <div className="@container" data-board-pane>
        {fixtureGroups(rows).map((group, i) => (
          <div key={group.id} data-group={group.id}>
            <h3 className={`flex ${i === 0 ? "h-6" : "h-8"} items-end px-2 pb-1 text-xs leading-4 font-medium text-muted-foreground`} data-group-header={group.id}>
              {group.label}
            </h3>
            {group.rows.map((row, index) => failed && i === 0 && index === 0 ? (
              <div key={row.meta.id} data-preview-expected-error>
                <RowBoundary threadId="guide-batch" rowId={row.meta.id} titleOf={() => row.meta.title}><BrokenRow /></RowBoundary>
              </div>
            ) : (
              <MasterRowView
                key={row.meta.id}
                meta={row.meta}
                digest={row.digest}
                agents={row.agents}
                landed={row.landed}
                host={offline && row.meta.environmentId !== "local" ? { id: row.meta.environmentId, name: "This Mac", offline: true } : null}
                hostGlyph={hostGlyph}
                onOpen={noop}
                menu={{ rowsFor: () => [], onPick: noop, onOpenChange: noop }}
                tasksChoice={row.tasksChoice}
                onTasksChoice={noop}
              />
            ))}
          </div>
        ))}
      </div>
      </div>
      {foot ? <BatchFoot batch={batch} clock={BOARD_FIXTURE_CLOCK} titleOf={(id) => rows.find((row) => row.meta.id === id)?.meta.title} hostName={() => nameInLine("This Mac")} onSave={access === "read" ? undefined : async () => {}} onStop={access === "read" ? undefined : async () => {}} held={access === "held" ? "This Mac is not connected" : null} /> : null}
    </div>
  );
}

/** The task bar's rows alone at a board width (`ui:preview
 *  …board.preview.tsx#TaskBarPreview --props '{"width":420}'`). */
export function TaskBarPreview({ width = 420 }: { width?: number }) {
  return (
    <div style={{ width, maxWidth: "100%" }}>
      <BoardPreview rows={TASK_BAR_ROWS} foot={false} />
    </div>
  );
}

/** Three rows whose task lists differ in width: one bar width for all, 35%
 *  of the pane (`ui:preview …board.preview.tsx#TaskBarWidthPreview --props '{"width":900}'`). */
export function TaskBarWidthPreview({ width = 560 }: { width?: number }) {
  return (
    <div style={{ width, maxWidth: "100%" }}>
      <BoardPreview rows={TASK_BAR_WIDTH_ROWS} foot={false} />
    </div>
  );
}

/** The master view's two states for `ui:preview`: an empty batch is the
 *  transcript alone; with children the board stands beside it. The chat is
 *  a stand-in for the transcript and composer. */
export function MasterPreview({ empty = false, width, collapsed = false, access = "owner" }: { empty?: boolean; width?: number; collapsed?: boolean; access?: "owner" | "read" | "held" }) {
  const chat = (
    <div className="flex flex-1 flex-col justify-end gap-3 p-6 text-sm text-foreground">
      <p className="max-w-[65ch]">The batch writes the gate, release and publish steps once its first thread lands.</p>
      <div className="h-24 rounded-lg border border-border bg-card" />
    </div>
  );
  // As MasterView draws them: none for a key that may only read, held in place while the master's host is away.
  const held = access === "held" ? "This Mac is not connected" : null;
  const actions =
    access === "read" ? null : (
      <>
        <HeldTip held={held}>
          <Button variant="ghost" size="icon-sm" aria-label="Batch actions" disabled={!!held}>
            <MoreHorizontal />
          </Button>
        </HeldTip>
        <HeldTip held={held}>
          <Button variant="ghost" size="icon-sm" aria-label="Add thread" disabled={!!held}>
            <Plus />
          </Button>
        </HeldTip>
      </>
    );
  return (
    <div className="flex h-[560px] max-w-full bg-background" style={{ width: width ?? "100%" }}>
      <SplitShell board={<BoardPreview access={access} />} chat={chat} hasBoard={!empty} collapsed={collapsed} onToggleChat={noop} title="iOS batch 2" detail={tally} actions={actions} />
    </div>
  );
}


// A key that may only read: no Batch actions, no Add thread.
export function MasterReadOnly() { return <MasterPreview access="read" />; }
// The master's host away: both held in place.
export function MasterHeld() { return <MasterPreview access="held" />; }
export function MasterOffline() {
  const remote = FIXTURE_ROWS.find((row) => row.meta.environmentId !== "local")!;
  return <BoardPreview offline batch={{ ...FIXTURE_BATCH, blocked: { sessionId: remote.meta.id, why: "unreachable", environmentId: remote.meta.environmentId } }} />;
}
export function MasterRowFailed() { return <BoardPreview failed foot={false} />; }
export function MasterRevealed() { return <BoardPreview reveal foot={false} />; }
export function MasterAtCap() {
  const template = FIXTURE_ROWS[0];
  const queued = ["Map the east trail", "Proof the route notes", "Check the print copy"].map((title, index) => ({
    ...template, meta: { ...template.meta, id: `guide-queued-${index}`, title, status: "queued" as const }, digest: {}, agents: null,
  }));
  return <BoardPreview rows={[...FIXTURE_ROWS, ...queued]} batch={FIXTURE_BATCH} />;
}

export function MasterFolded() { return <MasterPreview collapsed />; }

// A Done chat that never landed has nothing to say under its title: line one alone.
export function MasterSettledChat() {
  const template = FIXTURE_ROWS[0];
  const chat = { ...template, meta: { ...template.meta, id: "guide-quick", title: "Quick question", status: "idle" as const, threadType: "chat" as const }, digest: {}, agents: null, landed: false };
  return <BoardPreview rows={[...FIXTURE_ROWS, chat]} foot={false} />;
}
