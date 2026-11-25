// A preview frame for `bun run ui:preview src/renderer/src/work/composer/WorkComposer.preview.tsx#WorkComposerPreview`:
// the composer of a Work draft started from a task (its chip leads, it asks what it should do, it files in Purdue
// Esports › Spring LAN) and of a Work thread (it asks for a reply or a steer), each with its row under the box: the
// filing control and one settings glyph. The code composer's own pages are chrome/Composer.preview.tsx and
// chrome/Composer.tsx's.
import type { ContextChip } from "@shared/work";
import { Composer } from "../../chrome/Composer";
import { newSession, type Block, type Session } from "../../lib/session";
import { sessionStore } from "../../lib/tcserver/store";
import { workspaceStore } from "../../lib/tcserver/workspaces";
import { setLifeosProjects } from "../../lib/workSwitch";
import { workCanvasChunk, workComposerChunk } from "../../surfaces/chunks";
import { EmptySession } from "../../surfaces/EmptySession";
import { ChatFooter } from "../../surfaces/threads/chatSlots";
import { addContextChip } from "../canvas/chips";

// The row and the chip row are lazy chunks: the page draws them as a window does once they land.
await Promise.all([workComposerChunk.load(), workCanvasChunk.load()]);

workspaceStore.hydrate([
  {
    environmentId: "local",
    workspaces: [
      { id: "w-purdue", name: "Purdue Esports", path: "/jobs/purdue", kind: "work", sector: "purdue" },
      { id: "w-hypixel", name: "Hypixel", path: "/jobs/hypixel", kind: "work", sector: "hypixel" },
    ],
    projects: [{ id: "p-lan", workspaceId: "w-purdue", name: "Spring LAN", mode: "local", branch: null, cwd: "/jobs/purdue", archived: false, createdAt: 1, lifeosProjectId: "lp-lan" }],
  },
]);
setLifeosProjects("w-purdue", [
  { id: "lp-lan", name: "Spring LAN" },
  { id: "lp-budget", name: "FY27 budget" },
]);

const task: ContextChip = { kind: "task", label: "Count the patch cables", ref: { at: "lifeos", table: "tasks", id: "t1" } };
const noop = () => {};

export function WorkComposerPreview({ id, thread = false, draft }: { id: string; thread?: boolean; draft?: string }) {
  const session: Session = {
    ...newSession("local", "claude", "/jobs/purdue", "claude:opus-5.5"),
    id,
    workspaceId: "w-purdue",
    projectId: "p-lan",
    scope: "work",
    threadType: "chat",
    blocks: thread ? [{ id: `${id}-u`, role: "user", text: "Ask ITaP for two switches" } as Block] : [],
    context: { used: 84_000, window: 200_000 },
  };
  if (!sessionStore.get(id)) {
    sessionStore.mutate((prev) => [...prev, session]);
    if (!thread) addContextChip(id, task);
  }
  const composer = (
    <Composer
      focused={false}
      shell={!thread}
      harness="claude"
      model={session.model}
      runtimeMode="supervised"
      cwd={session.cwd}
      executionCwd={session.cwd}
      sessionId={id}
      work
      threadType="chat"
      onThreadTypeChange={noop}
      context={session.context}
      initialDraft={draft}
      onFocus={noop}
      onCwdChange={noop}
      onModelChange={noop}
      onRuntimeModeChange={noop}
      onDraftFile={noop}
      onSubmit={noop}
    />
  );
  return <div className="w-full">{thread ? <ChatFooter slots={{ transcript: null, strip: null, composer }} /> : <EmptySession composer={composer} />}</div>;
}
