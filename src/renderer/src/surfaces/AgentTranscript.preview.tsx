// bun run ui:preview src/renderer/src/surfaces/AgentTranscript.preview.tsx#AgentTranscriptPreview --shot --fresh
// For the wide gutter, pass --props '{"paneWidth":1320}' --shot-widths 1320.
// AgentTranscriptPreview draws real turns and an offline thread. Scroll anchoring, live reveal and hover need a DOM test.
import { useLayoutEffect, useRef, useState } from "react";
import { ConnectionLineView } from "../chrome/ConnectionLine";
import { newSession, type Block } from "../lib/session";
import { previewSession } from "../lib/previewHost.preview";
import type { EventRow } from "../lib/tcserver/types";
import { sessionStore, useSession, type Link } from "../lib/tcserver/store";
import { AgentTranscript } from "./AgentTranscript";
import { messageListChunk, questionChunk } from "./chunks";

await Promise.all([messageListChunk.load(), questionChunk.load()]);

const now = Date.UTC(2026, 10, 12, 16);
const cwd = "/projects/field-notes";
const noop = () => {};
const complete: Block[] = [
  { id: "u1", role: "user", text: "Find out why the notes list opens slowly.", startedAt: now, durationMs: 124_000 },
  { id: "a1", role: "assistant", text: "I’ll trace the first load, then check whether switching folders asks for the same data again." },
  { id: "t1", role: "tool", text: "Read", tool: { callId: "t1", name: "Read", status: "completed", title: "Read", input: { file_path: cwd + "/src/notes.ts" } } },
  { id: "t2", role: "tool", text: "Grep", tool: { callId: "t2", name: "Grep", status: "completed", title: "Grep", input: { pattern: "listNotes", path: "src" } } },
  { id: "n1", role: "system", text: "", planHandoff: { id: "preview-notes-build", title: "Keep the notes cache", how: "manual" } },
  { id: "n2", role: "system", text: "Context compacted", compaction: { phase: "done", preTokens: 185_000, postTokens: 21_000, durationMs: 3300, startedAt: now } },
  { id: "a2", role: "assistant", text: "The list requests the same page twice on first open. The second request can share the first result." },
  { id: "u2", role: "user", text: "Keep the last page visible while the next one loads.", startedAt: now + 180_000, durationMs: 47_000 },
  { id: "a3", role: "assistant", text: "The last page stays in view. The list replaces it when the next page arrives." },
];

const offline: Block[] = [
  ...complete,
  { id: "u3", role: "user", text: "Which empty state should we ship?", startedAt: now + 300_000 },
  {
    id: "q3",
    role: "tool",
    text: "Empty folders",
    tool: { callId: "q3", title: "Empty folders", kind: "question", status: "running" },
    question: {
      sessionId: "preview-transcript-away",
      requestId: "empty",
      questions: [{ question: "What should an empty folder show?", options: [{ label: "Add a note" }, { label: "Import notes" }] }],
    },
  },
];

/** jsdom has no layout. Give the window a viewport, then let Chrome lay
 *  out the captured rows in flow so their heights follow the text at each width. */
function usePreviewViewport(paneWidth: number) {
  const frame = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const proto = window.Element.prototype;
    const descriptors = {
      clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight")!,
      clientWidth: Object.getOwnPropertyDescriptor(proto, "clientWidth")!,
    };
    for (const key of ["clientHeight", "clientWidth"] as const) {
      Object.defineProperty(proto, key, {
        configurable: true,
        get(this: Element) {
          return this.classList.contains("agent-transcript") && el.contains(this)
            ? key === "clientHeight" ? 1000 : paneWidth
            : descriptors[key].get?.call(this);
        },
      });
    }
    setReady(true);
    return () => { Object.defineProperties(proto, descriptors); };
  }, [paneWidth]);
  return { frame, ready };
}

const historyId = "preview-transcript-history";
async function seedHistory() {
  const environmentId = "preview-history-host";
  const meta = previewSession({ id: historyId, title: "Notes history", environmentId });
  const tail: EventRow[] = [
    { sessionId: historyId, seq: 31, ts: now, event: { type: "user-text", text: "Keep the notes cache warm." } },
    { sessionId: historyId, seq: 32, ts: now, event: { type: "assistant-text", text: "The last page stays in view until the next one arrives.", delta: false } },
    { sessionId: historyId, seq: 33, ts: now + 180_000, event: { type: "user-text", text: "Check the offline case, too." } },
    { sessionId: historyId, seq: 34, ts: now + 180_000, event: { type: "assistant-text", text: "The old page stays visible while the studio reconnects.", delta: false } },
  ];
  const { environmentId: _host, ...wire } = meta;
  const link: Link = {
    environmentId, profile: "remote", connected: true,
    async request<T>(method: string, params?: unknown): Promise<T> {
      if (method === "session.list") return { sessions: [wire], next: null } as T;
      if (method === "session.events") {
        if ((params as { beforeSeq?: number })?.beforeSeq) return new Promise<T>(() => {});
        return { rows: tail, moreBefore: true, moreAfter: false, reset: false, subscribed: true } as T;
      }
      return undefined as T;
    },
    onOpen: () => noop, onClose: () => noop, onPush: () => noop,
  };
  sessionStore.attach(link);
  sessionStore.adopt(meta);
  await sessionStore.ensureLoaded(historyId);
}

export function AgentTranscriptPreview({ away = false, history = false, paneWidth = 864 }: { away?: boolean; history?: boolean; paneWidth?: number }) {
  const id = history ? historyId : away ? "preview-transcript-away" : "preview-transcript";
  const { frame, ready } = usePreviewViewport(paneWidth);
  useLayoutEffect(() => {
    if (history) {
      void seedHistory();
      return () => sessionStore.reset();
    }
    const base = newSession(away ? "preview-studio" : "local", "claude", cwd);
    const session = { ...base, id, status: away ? "waiting" as const : "idle" as const, title: "Notes list", createdAt: now, blocks: away ? offline : complete };
    sessionStore.mutate((sessions) => [...sessions.filter((entry) => entry.id !== id), session]);
    return () => sessionStore.mutate((sessions) => sessions.filter((entry) => entry.id !== id));
  }, [away, history, id]);
  const session = useSession(id);

  return (
    <div ref={frame} data-transcript-preview className="min-w-0">
      <style>{`
        [data-transcript-preview] .agent-transcript [data-row] { position: relative; top: auto !important; }
        [data-transcript-preview] .agent-transcript div:has(> [data-row]) { height: auto !important; }
        @media (max-width: 620px) {
          [data-transcript-preview] [data-transcript-outline] { display: none; }
          [data-transcript-preview] .agent-transcript > .px-4 { padding-left: 1rem !important; }
        }
      `}</style>
      {ready && session ? <AgentTranscript blocks={session.blocks} sessionId={id} cwd={cwd} harness={session.harness} turn={session} onSaveNote={noop} /> : null}
      {away ? <ConnectionLineView kind="offline" text="Studio is offline" onPair={noop} onRetry={noop} /> : null}
    </div>
  );
}
