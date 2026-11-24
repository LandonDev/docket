import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type Ref } from "react";
import type { ContextChip } from "@shared/work";
import type { SessionMeta } from "../../lib/tcserver/types";
import { useEnvironmentBlock } from "../../chrome/ConnectionLine";
import { AppWindow, X } from "../../chrome/icons";
import { Tip } from "../../components/tip";
import { Button } from "../../components/ui/button";
import { TooltipProvider } from "../../components/ui/tooltip";
import type { Session } from "../../lib/session";
import { sessionStore } from "../../lib/tcserver/store";
import { useMetaById, useSessionById } from "../../lib/threads/agents";
import { workDockPort, workOpenPort } from "../../lib/workSwitch";
import { LoadLine } from "../../surfaces/SessionPane";
import { SurfaceSkeleton } from "../../surfaces/SurfaceSkeleton";
import { useSessionActions, useThreadChat } from "../../surfaces/threadChat";
import { ThreadView } from "../../surfaces/threads/ThreadView";
import { addContextChip } from "../canvas/chips";
import { dockThread, enterDock, leaveDock, type DockThread, type DockWorkspace } from "./dockThread";
import type { DockSubject } from "./subject";

/** What a dock's head is drawn from: the chat's id once known, its thread's meta once it is one, and Close. */
export interface DockHead {
  id: string | null;
  meta: SessionMeta | null;
  onClose(): void;
}

/**
 * A chat docked beside something (docs/DESIGN.md "The Files place", "The Mail view"): a head its owner draws, and
 * under it the thread's transcript and composer, as a tab draws them, without its canvas (the subject is beside it).
 * Until the thread is known, and while its rows come, the transcript's skeleton; a chat that cannot be had says so
 * with Retry. `name` marks the section (`data-<name>-dock`) for its owner's tests and styles.
 */
export function Dock({
  name,
  workspace,
  subject,
  chip,
  focus,
  preset = null,
  head,
  sectionRef,
  section,
  onChipTaken,
  onClose,
  children,
  composerTop,
}: {
  name: string;
  workspace: DockWorkspace & { environmentId: string };
  /** null until what the dock is about is known (a file tab's item before the pane's list has come) */
  subject: DockSubject | null;
  /** chips to put in the composer once the thread is known (a selection's Ask, files asked about together) */
  chip: ContextChip | readonly ContextChip[] | null;
  /** the composer takes the caret when the dock opens */
  focus: boolean;
  /** a preview's thread, shown without asking which: nothing in the app passes it */
  preset?: DockThread | null;
  head(head: DockHead): ReactNode;
  sectionRef?: Ref<HTMLElement>;
  /** more of the section's own attributes (a drop target's handlers) */
  section?: HTMLAttributes<HTMLElement>;
  onChipTaken(): void;
  onClose(): void;
  /** drawn last inside the section (a drop's wash) */
  children?: ReactNode;
  /** rides the composer's top edge (Mail's starters) */
  composerTop?(sessionId: string): ReactNode;
}) {
  const [thread, setThread] = useState<DockThread | null>(preset);
  /** The subject the shown thread is for. */
  const shownFor = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const key = subject?.key ?? null;
  useEffect(() => {
    if (!subject || preset) return;
    let live = true;
    setFailed(false);
    // Another subject: its chat is not the one shown, so nothing is typed into the last one while it is found.
    setThread((was) => (was && shownFor.current === subject.key ? was : null));
    dockThread(workspace, subject).then(
      (next) => {
        if (!live) return;
        shownFor.current = subject.key;
        setThread(next);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
    // The key stands for the subject: one chat a key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, key, attempt]);
  // On screen, a draft is in the open set with its first send's step; closed (or the subject gone), one he sent nothing in goes.
  // Set in the commit that draws the composer, so no send can come before the step.
  const id = thread?.id ?? null;
  useLayoutEffect(() => {
    if (!id) return;
    enterDock(id);
    return () => leaveDock(id);
  }, [id]);

  const root = useRef<HTMLElement | null>(null);
  const caret = (): void => void requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("[data-composer-input]")?.focus());
  useEffect(() => {
    if (!id || !chip) return;
    for (const one of Array.isArray(chip) ? chip : [chip as ContextChip]) addContextChip(id, one);
    onChipTaken();
    caret();
  }, [id, chip, onChipTaken]);

  const meta = useMetaById(id);
  const setRoot = (node: HTMLElement | null): void => {
    root.current = node;
    if (typeof sectionRef === "function") sectionRef(node);
    else if (sectionRef) (sectionRef as { current: HTMLElement | null }).current = node;
  };
  return (
    <section
      ref={setRoot}
      aria-label="Chat"
      {...{ [`data-${name}-dock`]: id ?? "" }}
      data-draft={thread?.draft && !meta ? "" : undefined}
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
      {...section}
    >
      {head({ id, meta: meta ?? null, onClose })}
      {failed ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-[13px] text-muted-foreground">The chat did not open</p>
          <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Button>
        </div>
      ) : id ? (
        <DockChat key={id} sessionId={id} environmentId={workspace.environmentId} focus={focus} top={composerTop?.(id)} />
      ) : (
        <Bones />
      )}
      {children}
    </section>
  );
}

/** The head's two controls: Open in its own tab, once the chat is a thread, and Close; 24px ghost glyphs. */
export function DockHeadControls({ id, meta, onClose }: DockHead) {
  return (
    <TooltipProvider>
      <div className="flex shrink-0 items-center gap-0.5">
        {meta && id ? (
          <Tip label="Open in its own tab">
            <Button variant="ghost" size="icon-xs" aria-label="Open in its own tab" className="text-muted-foreground" onClick={() => workOpenPort.get()?.(id)}>
              <AppWindow />
            </Button>
          </Tip>
        ) : null}
        <Tip label="Close chat">
          <Button variant="ghost" size="icon-xs" aria-label="Close chat" className="text-muted-foreground" onClick={onClose}>
            <X />
          </Button>
        </Tip>
      </div>
    </TooltipProvider>
  );
}

const Bones = () => (
  <div className="min-h-0 flex-1" data-transcript-loading="loading">
    <SurfaceSkeleton kind="transcript" label="Loading chat" />
  </div>
);

/** The thread's transcript and composer, as the master board's child pane draws them (ChildPane.tsx). */
function DockChat({ sessionId, environmentId, focus, top }: { sessionId: string; environmentId: string; focus: boolean; top?: ReactNode }) {
  const meta = useMetaById(sessionId);
  const session = useSessionById(sessionId);
  const block = useEnvironmentBlock(environmentId);
  // A draft has no rows to wait for; a thread waits for its host's answer, never shown as empty.
  const answered = session?.loaded === true || session?.load?.phase === "loaded";
  const loading = !session || (!!meta && session.blocks.length === 0 && !answered);
  if (loading)
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-transcript-loading={session?.load?.phase ?? "loading"}>
        {session?.load ? <LoadLine name={block.name} load={session.load} onRetry={() => sessionStore.retryLoad(sessionId)} /> : null}
        <Bones />
      </div>
    );
  return <DockThreadView session={session} focus={focus} top={top} />;
}

function DockThreadView({ session, focus, top }: { session: Session; focus: boolean; top?: ReactNode }) {
  const actions = useSessionActions();
  const rootRef = useRef<HTMLDivElement>(null);
  const port = workDockPort.get();
  const openFile = port?.openFile ?? NOOP;
  const openDiff = port?.openDiff ?? NOOP;
  const chat = useThreadChat({
    session,
    actions,
    visible: true,
    focused: true,
    composerFocused: focus,
    // The dock's draft is this workspace's chat about this file: its folder, host, branch, type and name are not his to pick here.
    hideProjectPicker: true,
    draftRow: false,
    rootRef,
    onFocusPane: NOOP,
    onOpenFile: openFile,
    onOpenDiff: openDiff,
    onOpenSession: (id) => workOpenPort.get()?.(id),
  });
  return (
    <div ref={rootRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ThreadView
        session={session}
        renderChat={top ? (opts) => chat.renderChat({ topSlot: top, ...opts }) : chat.renderChat}
        renderSlots={top ? (opts) => chat.renderSlots({ topSlot: top, ...opts }) : chat.renderSlots}
        composing={chat.newPassArmed}
        onArmNewPass={chat.armNewPass}
        onOpenFile={openFile}
        onOpenDiff={openDiff}
        onOpenSession={(id) => workOpenPort.get()?.(id)}
        bare
        seat={false}
      />
    </div>
  );
}

const NOOP = (): void => undefined;
