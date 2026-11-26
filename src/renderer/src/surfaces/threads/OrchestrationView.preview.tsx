// bun run ui:preview src/renderer/src/surfaces/threads/OrchestrationView.preview.tsx#OrchestrationPreview --shot --fresh
// Export OrchestrationPreview. Real header, transcript and message list for a seeded fleet;
// the static page cannot jump between messages or open a subagent.
import { AgentTranscript } from "../AgentTranscript";
import { TranscriptOutline } from "../TranscriptOutline";
import { messageListChunk } from "../chunks";
import { sessionFromMeta } from "../../lib/tcserver/store";
import type { Block } from "../../lib/session";
import { OrchestrationView } from "./OrchestrationView";
import { fixtureMeta } from "./fleet/fleetFixture";
import { previewCwd, previewNow, seedPreviewThreads } from "./previewThreads";

await messageListChunk.load();
const noop = () => {};
const id = "guide-team";
const root = fixtureMeta(id, { id, parentId: null, cwd: previewCwd, environmentId: "local", title: "Prepare the spring field guide", threadType: "orchestration", status: "running" });
const turns: Block[][] = [
  [{ id: "u1", role: "user", text: "Check the old map", startedAt: previewNow - 120_000 }, { id: "a1", role: "assistant", text: "The old map still shows the bridge as open." }],
  [{ id: "u2", role: "user", text: "Prepare the spring field guide", startedAt: previewNow }, { id: "a2", role: "assistant", text: "I’ve asked one agent to check access and another to review the route notes." }],
];
const session = { ...sessionFromMeta(root), blocks: turns.flat(), loaded: true };
seedPreviewThreads([root,
  fixtureMeta("map-agent", { parentId: id, environmentId: "local", title: "Check bridge access", status: "running" }),
  fixtureMeta("notes-agent", { parentId: id, environmentId: "local", title: "Review route notes", status: "idle" }),
], { [id]: session });

/** One frame: the message list beside the column (as the transcript seats it: 16px in, 208px, 24px
 *  before the column; 8px here and the transcript's own 16px), or no list. */
function Fleet({ list }: { list: boolean }) {
  return (
    <div className="flex h-[480px] w-full border border-border">
      <OrchestrationView session={session} composing={false} onArmNewPass={noop} onOpenFile={noop} onOpenDiff={noop} renderChat={() => null} renderSlots={() => ({
        transcript: (
          <div className="flex min-h-0 min-w-0 flex-1">
            {list ? <div className="w-52 shrink-0 pt-3 ml-4 mr-2"><TranscriptOutline turns={turns} now={previewNow} onJump={noop} /></div> : null}
            <div className="min-w-0 flex-1"><AgentTranscript sessionId={id} blocks={session.blocks} cwd={previewCwd} harness="claude" visible /></div>
          </div>
        ),
        strip: null,
        composer: null,
        placement: list ? "beside" : "hidden",
      })} />
    </div>
  );
}

/** The list beside the column from 640px (the transcript reports its own placement; a static page cannot measure), the column alone under it. */
export function OrchestrationPreview() {
  return (
    <div className="flex flex-col gap-4">
      <section className="hidden flex-col gap-2 sm:flex">
        <h2 className="text-xs text-muted-foreground">Message list beside</h2>
        <Fleet list />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-xs text-muted-foreground">No message list</h2>
        <Fleet list={false} />
      </section>
    </div>
  );
}
