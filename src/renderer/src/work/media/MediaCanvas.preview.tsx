// A preview frame for `bun run ui:preview src/renderer/src/work/media/MediaCanvas.preview.tsx#MediaPreview --width 864`:
// the media kind in the canvas pane beside a thread, as the approved prototype draws it
// (.temp-code/prototypes/work-workspaces-2/media.html, "Player over its comments"): reviewing,
// the agent's notes waiting, a long stream with chapters, an image, loading, a proxy being made.
// A static page has no decoder, so a video's frame is black here.
import type { FrameTable, MediaNote, MediaVersion, MediaView } from "@shared/contract-work-media";
import type { CanvasItem, CanvasSource } from "@shared/work";
import { Composer } from "../../chrome/Composer";
import { composerFixtureBase } from "../../chrome/Composer.fixtures";
import { ChatFooter } from "../../surfaces/threads/chatSlots";
import { workCanvasChunk } from "../../surfaces/chunks";
import { CanvasSeat } from "../canvas/CanvasSeat";
import { CANVAS } from "../canvas/registry";
import { applyCanvasPush } from "../canvas/store";
import { mediaCanvas } from "./canvas";
import { applyMediaView, markMediaAsked } from "./store";

export type MediaMoment = "reviewing" | "notes" | "long" | "image" | "loading" | "preparing";

// Landed before the first render, so a static page draws the body.
void workCanvasChunk.load();
void mediaCanvas.chunk.load();

const at = (s: number): number => s * 24;
const table = (seconds: number): FrameTable => ({ kind: "cfr", start: 0, rate: { num: 24, den: 1 }, count: at(seconds) });
const file = (path: string): CanvasSource => ({ at: "file", host: "local", path });

function version(id: string, n: number, name: string, seconds: number, day: number): MediaVersion {
  return {
    id,
    n,
    name,
    source: file(`/work/trailer/${name}`),
    addedAt: Date.UTC(2026, 10, day, 15),
    addedBy: "owner",
    state: "ready",
    probe: { kind: "video", container: "mov,mp4", size: 412_000_000, mtimeMs: 0, width: 1920, height: 1080, rotation: 0, codec: "h264", rate: { num: 24, den: 1 }, durationS: seconds, frames: at(seconds) },
    play: { via: "original", url: "", mime: "video/mp4", table: table(seconds) },
  };
}

let seq = 0;
const note = (versionId: string, seconds: number, body: string, by: MediaNote["by"], over: Partial<MediaNote> = {}): MediaNote => ({
  id: `n${++seq}`,
  itemId: "",
  kind: "comment",
  anchor: { versionId, frame: at(seconds) },
  body,
  by,
  state: "kept",
  resolved: false,
  createdAt: seq,
  updatedAt: seq,
  ...over,
});
const jess = { service: "file", id: "", author: "Jess Park" };
const tom = { service: "file", id: "", author: "Tom Reyes" };
const AGENT = "agent:local:t1" as const;

/** A poster drawn as the prototype's, standing in for the picture a static page cannot decode. */
const POSTER = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1350"><rect width="1080" height="1350" fill="#2a2724"/><text x="86" y="170" fill="#d9b76a" font-family="Inter,sans-serif" font-size="34" font-weight="600" letter-spacing="5">PURDUE ESPORTS</text><text x="80" y="420" fill="#d9b76a" font-family="Inter,sans-serif" font-size="220" font-weight="800">SPRING</text><text x="80" y="620" fill="#d9b76a" font-family="Inter,sans-serif" font-size="220" font-weight="800">LAN</text><text x="86" y="1110" fill="#f3efe6" font-family="Inter,sans-serif" font-size="64" font-weight="700">Saturday, April 11</text><text x="86" y="1180" fill="#f3efe6" font-family="Inter,sans-serif" font-size="48">Memorial Union ballroom</text></svg>`,
)}`;

function viewFor(moment: MediaMoment, itemId: string): MediaView | null {
  if (moment === "loading") return null;
  const v3 = version("v3", 3, "Skyblock trailer v3.mp4", 134, 16);
  const base = { itemId, kind: "video" as const, mode: "suggests" as const, shared: false, rev: 1 };
  const comments = [note("v3", 7, "The cold open runs long", "external:jess", { external: jess }), note("v3", 41, "Title card is still the old logo", "external:jess", { external: jess }), note("v3", 92, "Music ducks too early", "external:tom", { external: tom })];
  if (moment === "reviewing") return { ...base, versions: [version("v2", 2, "Skyblock trailer v2.mp4", 136, 9), v3], notes: comments };
  if (moment === "notes")
    return {
      ...base,
      shared: true,
      versions: [v3],
      notes: [
        ...comments,
        note("v3", 18, "Two frames of black between the island shots", AGENT, { state: "suggested" }),
        note("v3", 65, "The voice line sits under the music for 3 s", AGENT, { state: "suggested" }),
        note("v3", 92, "The music ducks at 1:31.2, the line starts at 1:33.0", AGENT, { state: "suggested" }),
        note("v3", 126, "The end card holds 4 s; the brief asks for 6", AGENT, { state: "suggested" }),
      ],
    };
  if (moment === "long") {
    const stream = { ...version("s1", 1, "December update dev stream.mp4", 2892, 12) };
    const chapters: Array<[number, string]> = [
      [0, "Intro"],
      [220, "The new island biome"],
      [665, "Fishing changes"],
      [1170, "Minions and the bazaar"],
      [1575, "Dungeon floor 8"],
      [2090, "Questions from chat"],
      [2660, "What comes in January"],
    ];
    return { ...base, mode: "writes", versions: [stream], notes: chapters.map(([s, t]) => note("s1", s, t, AGENT, { kind: "chapter" })), lastWrite: { id: "w1", text: "Added 7 chapters", at: Date.UTC(2026, 10, 18, 19, 4) } };
  }
  if (moment === "image")
    return {
      ...base,
      kind: "image",
      shared: true,
      versions: [{ id: "p1", n: 1, name: "LAN poster draft.png", source: file("/work/LAN poster draft.png"), addedAt: 0, addedBy: "owner", state: "ready", probe: { kind: "image", container: "png_pipe", size: 2_400_000, mtimeMs: 0, width: 1080, height: 1350, rotation: 0, codec: "png" }, play: { via: "image", url: POSTER, width: 1080, height: 1350 } }],
      notes: [],
    };
  // preparing: a ProRes master the viewer cannot decode, its proxy under way.
  return {
    ...base,
    versions: [{ ...version("m1", 1, "Trailer master.mov", 134, 16), state: "preparing", progress: 0.34, probe: { ...v3.probe!, codec: "prores", pixFmt: "yuv422p10le", width: 3840, height: 2160 }, play: undefined }],
    notes: [],
  };
}

const TITLES: Record<MediaMoment, string> = {
  reviewing: "Skyblock trailer v3",
  notes: "Skyblock trailer v3",
  long: "December update dev stream",
  image: "LAN poster draft",
  loading: "Skyblock trailer v3",
  preparing: "Trailer master",
};

export function MediaPreview({ moment = "reviewing", folded = false }: { moment?: MediaMoment; folded?: boolean }) {
  const sessionId = `media-preview-${moment}`;
  const itemId = `${sessionId}-item`;
  const item: CanvasItem = { id: itemId, sessionId, workspaceId: "ws", kind: "media", title: TITLES[moment], source: file(moment === "image" ? "/work/LAN poster draft.png" : "/work/trailer.mp4"), state: "open", position: 0, rev: 0, createdAt: 0, updatedAt: 0 };
  applyCanvasPush({ sessionId, items: [item], opened: itemId });
  const view = viewFor(moment, itemId);
  if (view) applyMediaView({ ...view, notes: view.notes.map((n) => ({ ...n, itemId })) });
  else markMediaAsked(itemId);
  return (
    <div className="flex h-[720px] w-full overflow-hidden rounded-xl border border-border">
      <CanvasSeat session={{ id: sessionId, environmentId: "local" }} kinds={CANVAS}>
        {folded ? null : (
          <div className="flex min-h-0 flex-1 flex-col justify-end">
            <ChatFooter slots={{ transcript: null, strip: null, composer: <Composer {...composerFixtureBase} sessionId={sessionId} /> }} />
          </div>
        )}
      </CanvasSeat>
    </div>
  );
}
