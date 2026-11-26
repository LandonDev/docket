// bun run ui:preview src/renderer/src/surfaces/threads/boardViews.preview.tsx#ImplementationPreview --shot --fresh
// Exports ImplementationPreview, PlanPreview, ResearchPreview, ImplementationStates,
// PlanStates, ResearchStates, ChildPaneLoadingPreview and ChildBoardHeaderPreview.
// Static shells show settled layout and fixture content, without drag, chat or streaming motion.
import { useEffect, useRef, type ReactNode } from "react";
import { registry } from "../../lib/connection/registry";
import type { Block, Session } from "../../lib/session";
import type { ResearchSource, TodoItem } from "../../lib/tcserver/todos";
import { ImplementationView } from "./ImplementationView";
import { PlanView } from "./PlanView";
import { ResearchView } from "./ResearchView";
import { SplitShell } from "./SplitShell";
import { ChildPane } from "./master/ChildPane";
import { ViewBackContext } from "./viewBack";
import { SessionActionsContext, type SessionActions } from "../threadChat";
import { AgentTranscript } from "../AgentTranscript";
import { previewNow, seedPreviewThreads } from "./previewThreads";
import { FIXTURE_ROWS } from "./master/boardFixture";
import type { ThreadViewProps } from "./ThreadView";

/**
 * The board views drawn from plain sessions, for `bun run ui:preview
 * src/renderer/src/surfaces/threads/boardViews.preview.tsx#<Export>`.
 * Rendered by nothing in the app. A plan or report file is read through the
 * host; here a stand-in link answers `file.read` with the fixture's text.
 */

const docs = new Map<string, string>();
const linkOf = registry.linkOf.bind(registry);
registry.linkOf = ((id: string) => {
  const real = linkOf(id);
  return new Proxy(real, {
    get: (target, key, receiver) =>
      key === "request"
        ? async (method: string, params?: { path?: string }) =>
            method === "file.read" && params?.path ? (docs.get(params.path) ?? null) : target.request(method, params)
        : Reflect.get(target, key, receiver),
  });
}) as typeof registry.linkOf;

export const previewClock = previewNow;
const noop = () => {};
const sampleBlocks: Block[] = [
  { id: "guide-ask", role: "user", text: "Update the field guide for the spring opening." },
  { id: "guide-reply", role: "assistant", text: "I’ll start with the west trail and check the notes on access." },
];

function Chat() {
  return <AgentTranscript sessionId="board-chat" turn={null} blocks={sampleBlocks} busy={false} cwd="/projects/field-guide" harness="claude" onApproval={noop} visible />;
}
const chat = <Chat />;
const viewProps = (session: Session): ThreadViewProps => ({
  session,
  renderChat: () => chat,
  composing: false,
  onArmNewPass: noop,
  onOpenFile: noop,
  onOpenDiff: noop,
  onOpenSession: noop,
});

function Frame({ children, width }: { children: ReactNode; width?: number }) {
  return <div className="flex h-[560px] max-w-full border border-border bg-background" style={{ width: width ?? "100%" }}>{children}</div>;
}

function Widths({ children, width }: { children: (id: string) => ReactNode; width?: number }) {
  return (
    <div className="flex flex-col gap-4">
      {(width ? [width] : [560, 352]).map((size) => (
        <section key={size} className="flex flex-col gap-2">
          <h2 className="text-xs text-muted-foreground">{size}px shell, conversation open</h2>
          <Frame width={size}><ChatMode open>{children(`${size}-open`)}</ChatMode></Frame>
          {size === 352 ? (
            <>
              <h2 className="text-xs text-muted-foreground">{size}px shell, conversation folded</h2>
              <Frame width={size}><ChatMode open={false}>{children(`${size}-folded`)}</ChatMode></Frame>
            </>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function ChatMode({ open, children }: { open: boolean; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sync = () => frame.current?.querySelector<HTMLButtonElement>(`[aria-label="Conversation"][aria-pressed="${!open}"]`)?.click();
    const observer = new MutationObserver(sync);
    if (!frame.current) return;
    observer.observe(frame.current, { subtree: true, attributes: true, childList: true });
    sync();
    return () => observer.disconnect();
  }, [open]);
  return <div ref={frame} className="flex min-w-0 flex-1">{children}</div>;
}

const todo = (content: string, status: TodoItem["status"]): TodoItem => ({ content, status });
const edit = (id: string, path: string, todoIx: number, adds: number, dels: number): Block =>
  ({
    id,
    role: "tool",
    text: "",
    round: 0,
    todo: todoIx,
    ts: previewNow - 120_000,
    doneTs: previewNow - 119_000,
    tool: { kind: "edit", name: "Edit", preview: { path, additions: adds, deletions: dels, lines: [] } },
  }) as unknown as Block;

/** An implementation thread mid-pass: its tasks and the changes under them. */
function implementationSession(): Session {
  return {
    id: "impl",
    environmentId: "local",
    harness: "claude",
    model: "claude-opus-5-5",
    title: "Ship the raid timer",
    cwd: "/srv/agents/work/plugin",
    status: "running",
    threadType: "implementation",
    loaded: true,
    blocks: [
      { id: "u0", role: "user", text: "Ship the raid timer", round: 0 } as Block,
      edit("e0", "src/main/java/raids/RaidTimer.java", 0, 84, 2),
      edit("e1", "src/main/java/raids/RaidListener.java", 1, 12, 5),
    ],
    thread: {
      todos: [todo("Write the timer", "completed"), todo("Hook it into the listener", "in_progress"), todo("Cover it with a test", "pending")],
      rounds: [],
      costs: [],
      usage: [],
      stopped: false,
      activeTodo: 1,
      round: 0,
    },
  } as unknown as Session;
}
export function ImplementationPreview({ width }: { width?: number }) {
  const session = implementationSession();
  return <Widths width={width}>{(size) => <ImplementationView {...viewProps({ ...session, id: `impl-${size}` })} />}</Widths>;
}

const PLAN_PATH = "/srv/agents/work/plugin/.temp-code/plan-raid.md";
docs.set(
  PLAN_PATH,
  "# Ship the raid timer\n\nRaids end on a timer the whole server sees.\n\n## Tasks\n\n- [ ] Write the timer\n- [ ] Hook it into the listener\n- [ ] Cover it with a test\n\n## Risks\n\nA restart mid-raid loses the clock.\n",
);

/** A written, settled plan waiting for its build: titled by its own heading. */
function planSession(): Session {
  return {
    id: "plan",
    environmentId: "local",
    harness: "claude",
    model: "claude-opus-5-5",
    modelSettings: {},
    runtimeMode: "ask",
    title: "Plan the raid timer",
    cwd: "/srv/agents/work/plugin",
    projectId: "p1",
    planPath: PLAN_PATH,
    threadType: "planning",
    status: "idle",
    planCompletedAt: previewNow - 60_000,
    blocks: [],
  } as unknown as Session;
}
export function PlanPreview({ width }: { width?: number }) {
  const session = planSession();
  return <Widths width={width}>{(size) => <PlanView {...viewProps({ ...session, id: `plan-${size}` })} />}</Widths>;
}

const PROJECT_PLAN_PATH = "/projects/field-guide/.temp-code/project-plan.md";
docs.set(PROJECT_PLAN_PATH, "# Field guide\n\n## Goal\n\nPublish a spring guide to the park.\n\n## Milestones\n\n### 1. Map the trail\n\n- [x] Walk the west trail\n- [ ] Check bridge access\n\n### 2. Publish\n\n- [ ] Review directions\n");
export function PlanStates() {
  const plan = planSession();
  const child = { ...FIXTURE_ROWS[0].meta, id: "plan-child", masterId: null, title: "Build the raid timer" };
  useEffect(() => {
    // The mirror supplies the handed-off thread's title to HandoffButton.
    seedPreviewThreads([child], {}, (method, params) => method === "file.read" ? docs.get(String(params.path)) ?? null : null);
  }, []);
  return (
    <div className="flex flex-col gap-4">
      <Frame><PlanView {...viewProps({ ...plan, id: "drafting-plan", status: "running" })} /></Frame>
      <Frame><PlanView {...viewProps({ ...plan, id: "handed-off-plan", implementationId: child.id })} /></Frame>
      <Frame width={1120}><PlanView {...viewProps({ ...plan, id: "wide-plan" })} /></Frame>
      <Frame><PlanView {...viewProps({ ...plan, id: "project-plan", threadType: "project-plan", planPath: PROJECT_PLAN_PATH })} /></Frame>
    </div>
  );
}

export function ImplementationStates() {
  const session = implementationSession();
  const thread = session.thread!;
  const first = [{ content: "Map the west trail", status: "completed" as const }];
  const second = [{ content: "Check the bridge", status: "in_progress" as const }];
  const previous = [{ id: "first", role: "user", text: "Map the west trail", round: 0 }, { id: "first-answer", role: "assistant", text: "The west trail is mapped.", round: 0 }] as const;
  const newAsk: Block = { id: "second", role: "user", text: "Check the bridge", round: 1 };
  const history = { ...thread, rounds: [first], todos: second, round: 1 };
  return (
    <div className="flex flex-col gap-4">
      <Frame><ImplementationView {...viewProps({ ...session, id: "impl-waiting", status: "waiting", thread: history, blocks: [...previous, newAsk, { id: "approval", role: "approval", text: "Check access to the bridge?", approval: { requestId: "bridge-check" }, round: 1 }] })} /></Frame>
      <Frame><ImplementationView {...viewProps({ ...session, id: "impl-failed", status: "error", thread: history, blocks: [...previous, newAsk, { id: "err:bridge", role: "system", text: "The check could not finish.", round: 1 }] })} /></Frame>
      <Frame><ImplementationView {...viewProps({ ...session, id: "impl-next", status: "idle", thread: { ...history, todos: first }, blocks: [...previous, newAsk] })} /></Frame>
      <Frame><ImplementationView {...viewProps({ ...session, id: "impl-breaking-down", thread: { ...history, todos: [] }, blocks: [...previous, newAsk] })} /></Frame>
    </div>
  );
}

const source = (callId: string, agentId: string, agentLabel: string, over: Partial<ResearchSource>): ResearchSource => ({ callId, agentId, agentLabel, ts: previewNow, ...over });

/** A research thread with two angles out and its sources landing. */
function researchSession(): Session {
  return {
    id: "r1",
    environmentId: "local",
    harness: "claude",
    title: "Why is the build slow?",
    cwd: "/srv/agents/work/plugin",
    planPath: "/srv/agents/work/plugin/.temp-code/reports/r1.md",
    threadType: "research",
    status: "running",
    blocks: [],
    thread: {
      agents: ["a1", "a2"],
      sources: [
        source("q1", "a1", "Bundler", { query: "vite cold start" }),
        source("c1", "a1", "Bundler", { url: "https://vitejs.dev/guide/dep-pre-bundling", title: "Dependency pre-bundling", claim: "Pre-bundling is cached between runs" }),
        source("q2", "a2", "Cache", { query: "gradle build cache remote" }),
        source("c2", "a2", "Cache", { url: "https://docs.gradle.org/current/userguide/build_cache.html", title: "Build cache" }),
      ],
    },
  } as unknown as Session;
}
export function ResearchPreview({ width }: { width?: number }) {
  const session = researchSession();
  return <Widths width={width}>{(size) => <ResearchView {...viewProps({ ...session, id: `research-${size}` })} />}</Widths>;
}

const reportPath = "/projects/field-guide/.temp-code/report.md";
const completedReportPath = "/projects/field-guide/.temp-code/report-complete.md";
docs.set(reportPath, "---\ntitle: West trail access\nstatus: writing\nsummary: The park opens the main trail in spring.\n---\n");
docs.set(completedReportPath, "---\ntitle: West trail access\nstatus: complete\n---\nThe bridge stays closed while the deck is repaired.\n\n## Detour\n\nUse the marked path along the field.");
export function ResearchStates() {
  const session = researchSession();
  useEffect(() => {
    const template = FIXTURE_ROWS[0].meta;
    seedPreviewThreads([
      { ...template, id: "a1", parentId: "report-complete", masterId: null, status: "running", title: "Bundler" },
      { ...template, id: "a2", parentId: "report-complete", masterId: null, status: "idle", title: "Cache" },
    ], {}, (method, params) => method === "file.read" ? docs.get(String(params.path)) ?? null : null);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <Frame><ResearchView {...viewProps({ ...session, id: "report-writing", planPath: reportPath })} /></Frame>
      <Frame><ResearchView {...viewProps({ ...session, id: "report-complete", status: "idle", planPath: completedReportPath })} /></Frame>
    </div>
  );
}

/** A batch child opened from the master board while its rows load: the pane's own bar, Back and the title. */
export function ChildPaneLoadingPreview() {
  return (
    <Frame>
      <SessionActionsContext.Provider value={{} as SessionActions}>
        <ChildPane sessionId="c1" environmentId="local" title="Ship the raid timer" focusComposer={false} onBack={() => {}} onOpenFile={() => {}} onOpenDiff={() => {}} />
      </SessionActionsContext.Provider>
    </Frame>
  );
}

/** A board-type child opened from the master board: one header, its view's, with Back leading it. */
export function ChildBoardHeaderPreview() {
  return (
    <Frame>
      <ViewBackContext.Provider value={{ onBack: () => {}, claim: () => {} }}>
        <SplitShell
          hasBoard
          title="Ship the raid timer"
          detail="2 of 3 tasks"
          board={<div className="flex-1 p-6 text-sm text-muted-foreground">The implementation board</div>}
          chat={chat}
          collapsed={false}
          onToggleChat={() => {}}
        />
      </ViewBackContext.Provider>
    </Frame>
  );
}
