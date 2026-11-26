// A preview frame for `bun run ui:preview src/renderer/src/chrome/Composer.preview.tsx#DockedComposerPreview`:
// the docked footer as a thread draws it (the slot above the composer, the
// queue, the box with its attachments and the row under it).
// ComposerMenus opens the real add, permission and type controls. Focus restoration needs a DOM test.
import { newSession, type Attachment, type Block, type Session } from "../lib/session";
import type { QueuedMessage } from "../lib/tcserver/types";
import { sessionStore } from "../lib/tcserver/store";
import { saveComposerDraft } from "../lib/composerDrafts";
import type { ComponentProps } from "react";
import { addPreviewHost, previewCwd, previewNow, previewProject, previewSession, previewWorkspace } from "../lib/previewHost.preview";
import { IDLE_STATUS, degradedText, type Degraded } from "../lib/connection";
import { workspaceStore } from "../lib/tcserver/workspaces";
import { ThreadTypeSelect, AccessPickerSelect } from "./composerSelects";
import { AddMenu } from "./ComposerBar";
import { menuChunk, selectChunk } from "../surfaces/chunks";
import { ConnectionLineView } from "./ConnectionLine";
import { ChatFooter } from "../surfaces/threads/chatSlots";
import { WorkingStrip } from "../surfaces/threads/WorkingStrip";
import { Composer } from "./Composer";
import { MessageQueue } from "./MessageQueue";

const noop = () => {};
await Promise.all([menuChunk.load(), selectChunk.load()]);

const answers = {
  "git.branches": (params: unknown) => (params as { cwd: string })?.cwd === "/projects/field-notes-next"
    ? new Promise(() => {})
    : { current: "main", detached: false, branches: [{ name: "main", current: true, remote: null }] },
  "workspace.list": () => [previewWorkspace],
  "project.list": () => [previewProject],
  "session.events": () => ({ rows: [], moreBefore: false, moreAfter: false, reset: false, subscribed: true }),
};
const box = await addPreviewHost({ id: "local", name: "This computer", answers });
await addPreviewHost({ id: "studio", name: "Studio", caps: ["read"], answers: {
  "project.ensureLinked": () => ({ cwd: "/projects/field-notes" }),
} });
workspaceStore.attach(box);
await workspaceStore.refresh(box);

export function DockedComposerPreview({
  id,
  status = "idle",
  elapsedMs = 0,
  draft,
  attachments = [],
  queue = [],
  degraded,
  readKey = false,
  draftThread = false,
  waiting = false,
  composerProps,
}: {
  /** One thread per fixture: the store and the draft cache are shared. */
  id: string;
  status?: Session["status"];
  elapsedMs?: number;
  draft?: string;
  attachments?: Attachment[];
  queue?: QueuedMessage[];
  degraded?: Degraded["kind"];
  readKey?: boolean;
  draftThread?: boolean;
  waiting?: boolean;
  composerProps?: Partial<ComponentProps<typeof Composer>>;
}) {
  const now = Date.now();
  const session: Session = {
    ...newSession(readKey ? "studio" : "local", "claude", previewCwd, "claude:opus-5.5"),
    id,
    status,
    ...(status === "running" ? { busy: true, busySince: now - elapsedMs } : {}),
    ...(status === "paused" ? { pausedAt: now, frozenActiveElapsed: elapsedMs } : {}),
    projectId: previewProject.id,
    blocks: draftThread ? [] : [{ id: `${id}-u`, role: "user", text: "Rework the login flow" } as Block],
    context: { used: 84_000, window: 200_000 },
  };
  if (!sessionStore.get(id)) {
    if (waiting) sessionStore.adopt(previewSession({ id, title: "Wait for the cache check", status: "running", awaiting: ["preview-worker"] }), { created: true });
    if (readKey) sessionStore.adopt(previewSession({ id, title: "Read the cache notes", environmentId: "studio" }), { created: true });
    sessionStore.mutate((prev) => [...prev.filter((entry) => entry.id !== id), session]);
  }
  if (draft || attachments.length > 0) saveComposerDraft(id, { segments: draft ? [{ text: draft }] : [], attachments });
  const connection = degraded ? degradedText("Studio", {
    kind: degraded,
    status: { ...IDLE_STATUS, transport: degraded, nextRetryAt: previewNow + 5_000 },
  }, previewNow) : null;
  return (
    <div className="w-full" data-session-drop>
      <ChatFooter
        slots={{
          transcript: null,
          strip: status === "idle" ? null : <WorkingStrip session={session} onStop={noop} onResume={noop} />,
          composer: (
            <Composer
              focused={false}
              harness="claude"
              model={session.model}
              runtimeMode="supervised"
              cwd={session.cwd}
              executionCwd={session.cwd}
              sessionId={id}
              recents={[]}
              context={session.context}
              busy={status === "running"}
              paused={status === "paused"}
              onFocus={noop}
              onCwdChange={noop}
              onModelChange={noop}
              onRuntimeModeChange={noop}
              onSubmit={noop}
              blocked={connection}
              {...composerProps}
              topSlot={
                queue.length > 0 ? (
                  <MessageQueue sessionId={id} items={queue} paused={status === "paused"} onSteer={noop} onRemove={noop} onUpdate={noop} onReorder={noop} />
                ) : undefined
              }
            >
              {degraded && connection ? <ConnectionLineView kind={degraded} text={connection} onPair={noop} onRetry={noop} /> : null}
            </Composer>
          ),
        }}
      />
    </div>
  );
}


/** The actual select and menu bodies, opened for capture. */
export function ComposerMenus({ menu }: { menu: "add" | "access" | "type" }) {
  if (menu === "access") return <AccessPickerSelect value="supervised" onChange={noop} quiet defaultOpen />;
  if (menu === "type") return <ThreadTypeSelect value="chat" onChange={noop} defaultOpen />;
  return <AddMenu attachable onAttach={noop} onInsert={noop} fieldOf={() => null} />;
}
