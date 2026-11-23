// A preview page for `bun run ui:preview src/renderer/src/work/files/Dock.preview.tsx#DockDraft` (and #DockThread, #FilesSide):
// a file open in its Files tab with a chat docked at its right, on a draft and on a thread with a few messages.
// Rendered by nothing in the app.
import type { FileTab } from "@shared/contract-work-files";
import type { CanvasItem } from "@shared/work";
import { defineChunk } from "../../lib/lazyChunk";
import { newSession, type Block, type Session } from "../../lib/session";
import { sessionStore } from "../../lib/tcserver/store";
import type { SessionMeta } from "../../lib/tcserver/types";
import { workCanvasChunk } from "../../surfaces/chunks";
import { SessionActionsContext, type SessionActions } from "../../surfaces/threadChat";
import { addContextChip, resetContextChips } from "../canvas/chips";
import { CANVAS } from "../canvas/registry";
import { fileChip } from "./dockThread";
import { FileTabView } from "./FileTabView";
import { filesPanelId } from "./TabRow";

const workspace = { id: "w", environmentId: "local", path: "/w" };
const tab: FileTab = { id: "t1", kind: "file", name: "Spring LAN budget request.docx", itemId: "pi1" };
const item: CanvasItem = {
  id: "pi1",
  sessionId: "filespane_w",
  workspaceId: "w",
  kind: "document",
  title: "Spring LAN budget request.docx",
  source: { at: "file", host: "env_local", path: "/w/Events/Spring LAN budget request.docx" },
  state: "open",
  position: 0,
  rev: 0,
  createdAt: 0,
  updatedAt: 0,
};

/** The file's body: a stand-in document, so the shot is the frame and the dock, never a kind's bytes. */
function Body({ item: shown }: { item?: CanvasItem }) {
  if (shown?.id === "pi2")
    return (
      <div className="min-h-0 flex-1 overflow-auto px-12 py-10 text-[15px] leading-7 text-foreground">
        <h1 className="mb-4 text-2xl font-semibold">Run of show</h1>
        <p className="mb-2 max-w-[65ch] tabular-nums">9:00 Doors, check-in at the north desk</p>
        <p className="mb-2 max-w-[65ch] tabular-nums">10:00 Pools start, stations 1 to 12</p>
        <p className="mb-2 max-w-[65ch] tabular-nums">13:00 Lunch; the stage resets for brackets</p>
        <p className="max-w-[65ch] tabular-nums">18:30 Finals on the main stage</p>
      </div>
    );
  return (
    <div className="min-h-0 flex-1 overflow-auto px-12 py-10 text-[15px] leading-7 text-foreground">
      <h1 className="mb-4 text-2xl font-semibold">Spring LAN budget request</h1>
      <p className="mb-4 max-w-[65ch]">The spring LAN runs two days in the ballroom, with 24 stations for pools and a stage for the finals.</p>
      <p className="mb-4 max-w-[65ch]">We ask for $18,400: the room and its power ($9,200), equipment rental ($5,600), staff meals ($2,100) and prizes ($1,500).</p>
      <p className="max-w-[65ch]">Sponsors have pledged $6,000, which the request does not count.</p>
    </div>
  );
}
const chunk = defineChunk("preview-files-dock", () => Promise.resolve({ Body }));
void chunk.load();
// The composer's chip row is lazy: landed before the first render, so a static page draws it.
void workCanvasChunk.load();
const kinds = { ...CANVAS, document: { ...CANVAS.document, chunk } };

// The transcript mounts the rows that meet its viewport, and the preview's document lays nothing out: here every
// element says it is a screen tall, so the static page draws the thread's rows.
if (typeof document !== "undefined" && !navigator.userAgent.includes("Chrome")) Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 560 });

/** The window kept this tab's dock open, at its width. */
function keepDock(width = 360): void {
  localStorage.setItem("work.files.view.v1", JSON.stringify({ wpreview: { at: Date.now(), docks: { "w/t1": true }, dock: width } }));
}

const actions = new Proxy({}, { get: () => () => undefined }) as SessionActions;
const now = Date.now();
const turn = (id: string, role: Block["role"], text: string, ago: number): Block => ({ id, role, text, ts: now - ago }) as Block;

function seed(id: string, meta: Partial<SessionMeta> | null, blocks: Block[]): void {
  const session: Session = { ...newSession("local", "claude", "/w", undefined, undefined, undefined, { projectId: null, workspaceId: "w" }), id, status: "idle", blocks, ...(meta?.title ? { title: meta.title } : {}) };
  sessionStore.mutate((prev) => [...prev.filter((s) => s.id !== id), session]);
  if (meta) sessionStore.adopt({ id, environmentId: "local", status: "idle", archived: false, workspaceId: "w", projectId: null, scope: "work", createdAt: now, updatedAt: now, ...meta } as SessionMeta, { created: true });
}

function Frame({ width, preset }: { width: number; preset: { id: string; draft: boolean } }) {
  return (
    <SessionActionsContext.Provider value={actions}>
      <div className="flex h-[620px] overflow-hidden border border-border" style={{ width }}>
        <FileTabView tab={tab} item={item} panelId={filesPanelId(tab.id)} workspace={workspace} where="Events" copy={null} onClose={() => undefined} kinds={kinds} dockPreset={preset} />
      </div>
    </SessionActionsContext.Provider>
  );
}

/** Ask on a file no thread holds: a draft, the file's chip in its composer. */
export function DockDraft() {
  keepDock();
  resetContextChips();
  seed("draft-1", null, []);
  addContextChip("draft-1", fileChip(tab, item)!);
  return <Frame width={1200} preset={{ id: "draft-1", draft: true }} />;
}

/** The thread that holds the file, a few messages in. */
export function DockThread() {
  keepDock(400);
  resetContextChips();
  seed("s1", { title: "Budget request questions" }, [
    turn("u1", "user", "Does the total match the four lines?", 300_000),
    turn("a1", "assistant", "Yes. $9,200 + $5,600 + $2,100 + $1,500 is $18,400, the total the request asks for.", 290_000),
    turn("u2", "user", "Add a line that says the sponsor money is not counted.", 120_000),
    turn("a2", "assistant", "Added under the total: “Sponsor pledges ($6,000) are not counted in this request.”", 110_000),
  ]);
  return <Frame width={1200} preset={{ id: "s1", draft: false }} />;
}

const sideItem: CanvasItem = { ...item, id: "pi2", title: "Run of show.md", source: { at: "file", host: "env_local", path: "/w/Events/Run of show.md" } };

/** Two files in one tab: the second at the side of the first, each under its own head, a sash between. */
export function FilesSide() {
  localStorage.removeItem("work.files.view.v1");
  return (
    <SessionActionsContext.Provider value={actions}>
      <div className="flex h-[620px] overflow-hidden border border-border" style={{ width: 1200 }}>
        <FileTabView
          tab={{ ...tab, side: { itemId: "pi2", key: "k2", name: "Run of show.md" } }}
          item={item}
          sideItem={sideItem}
          onCloseSide={() => undefined}
          panelId={filesPanelId(tab.id)}
          workspace={workspace}
          where="Events"
          copy={null}
          onClose={() => undefined}
          kinds={kinds}
        />
      </div>
    </SessionActionsContext.Provider>
  );
}

