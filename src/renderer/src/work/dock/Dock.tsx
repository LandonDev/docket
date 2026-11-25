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
import { ChatFooter } from "../../surfaces/threads/chatSlots";
import { useSessionActions, useThreadChat } from "../../surfaces/threadChat";
import { ThreadView } from "../../surfaces/threads/ThreadView";
import { addContextChip } from "../canvas/chips";
import { dockThreadNow, draftIsEmpty, enterDock, findThread, leaveDock, plannedDraft, rebindDock, showFound, type DockThread, type DockWorkspace } from "./dockThread";
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
 * Its composer is there the moment it opens (the draft, or the thread it showed before), and a thread's rows still
 * coming are the transcript's skeleton over it; a chat that cannot be had says so with Retry. `name` marks the section (`data-<name>-dock`) for its owner's tests and styles.
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
  // What the dock shows the moment it opens: the thread it showed before, else a draft, with no ask of any host
  // (dockThreadNow); drawn in the same commit, so a composer is there at once. A dock that cannot have a chat here says so.
  const now = (): { thread: DockThread | null; failed: boolean } => {
    if (!subject) return { thread: null, failed: false };
    try {
      return { thread: dockThreadNow(workspace, subject), failed: false };
    } catch {
      return { thread: null, failed: true };
    }
  };
  const key = subject?.key ?? null;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState(() => ({ key, attempt, ...(preset ? { thread: preset, failed: false } : now()) }));
  let shown = state;
  // Another subject (or a Retry): its chat, at once, in this same draw. A subject gone keeps what was shown.
  if (!preset && subject && (state.key !== key || state.attempt !== attempt)) {
    shown = { key, attempt, ...now() };
    setState(shown);
  }
  const { thread, failed } = shown;
  // On screen, a draft is in the open set with its first send's step; closed (or the subject gone), one he sent nothing in goes.
  // Set in the commit that draws the composer, so no send can come before the step.
  const id = thread?.id ?? null;
  useLayoutEffect(() => {
    if (!id) return;
    enterDock(id);
    return () => leaveDock(id);
  }, [id]);

  const root = useRef<HTMLElement | null>(null);
  const input = (): HTMLElement | null | undefined => root.current?.querySelector<HTMLElement>("[data-composer-input]");
  const caret = (): void => void requestAnimationFrame(() => input()?.focus());
  // The same key about another thing (a file tab moved to its Keep Both copy): the draft follows, his words kept.
  // Before the lookup below, so the thing's own thread is asked for, never the one the key's last thing had.
  useEffect(() => {
    if (subject) rebindDock(subject);
  }, [subject]);

  // The subject's thread from before, asked behind the draft (once a subject a run: findThread): it takes the draft's
  // place only while he has put nothing in it, in place and with no fade; the caret stays in the composer. Asked by
  // the thing it is about (its lead chip) too: a lookup for the thing before is let go.
  const draftId = thread?.draft ? thread.id : null;
  const lead = subject?.chips[0];
  const thing = lead ? JSON.stringify(lead) : "";
  useEffect(() => {
    if (!subject || preset || !draftId) return;
    let live = true;
    findThread(subject).then(
      (held) => {
        if (!live || !held || held === draftId || !draftIsEmpty(draftId, input())) return;
        const typing = !!root.current?.contains(document.activeElement);
        showFound(subject.key, held);
        setState((was) => (was.thread?.id === draftId ? { ...was, thread: { id: held, draft: false } } : was));
        if (typing) caret();
      },
      // A find that failed leaves the draft; the next open of the subject asks again.
      () => undefined,
    );
    return () => {
      live = false;
    };
    // The key stands for the subject: one chat a key, about the thing its lead chip names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id, key, draftId, thing]);

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
        <DockChat key={id} sessionId={id} environmentId={workspace.environmentId} focus={focus} top={composerTop?.(id)} planned={thread?.draft ? plannedDraft(id) : undefined} />
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

/**
 * The thread's transcript and composer, as the master board's child pane draws them (ChildPane.tsx). A draft draws its
 * composer at once (from its plan, until the store holds it); a thread whose rows are still coming draws them as the
 * transcript's skeleton over its live composer, as a tab's pane does (SessionPane.tsx), so he can type at once.
 */
function DockChat({ sessionId, environmentId, focus, top, planned }: { sessionId: string; environmentId: string; focus: boolean; top?: ReactNode; planned?: Session }) {
  const meta = useMetaById(sessionId);
  const session = useSessionById(sessionId) ?? planned;
  const block = useEnvironmentBlock(environmentId);
  if (!session) return <Bones />;
  // A draft has no rows to wait for; a thread waits for its host's answer, never shown as empty.
  const answered = session.loaded === true || session.load?.phase === "loaded";
  const waiting = !!meta && session.blocks.length === 0 && !answered;
  const quiet = waiting ? (
    <div className="flex min-h-0 flex-1 flex-col" data-transcript-loading={session.load?.phase ?? "loading"}>
      {session.load && !block.degraded ? <LoadLine name={block.name} load={session.load} onRetry={() => sessionStore.retryLoad(sessionId)} /> : null}
      {/* A failed read is its Retry line alone: the bones say a load is under way, and come back when a retry starts. */}
      {session.load?.phase === "failed" ? null : <Bones />}
    </div>
  ) : null;
  return <DockThreadView session={session} focus={focus} top={top} quiet={quiet} />;
}

function DockThreadView({ session, focus, top, quiet }: { session: Session; focus: boolean; top?: ReactNode; quiet: ReactNode }) {
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
      {quiet ? (
        <>
          {quiet}
          <ChatFooter slots={{ transcript: null, strip: null, composer: chat.composerOf(top ? { topSlot: top } : undefined) }} />
        </>
      ) : (
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
      )}
    </div>
  );
}

const NOOP = (): void => undefined;
