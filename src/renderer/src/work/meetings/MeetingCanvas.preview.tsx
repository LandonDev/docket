// A preview frame for `bun run ui:preview src/renderer/src/work/meetings/MeetingCanvas.preview.tsx#MeetingPreview --width 864`:
// the meeting kind in the canvas pane beside a thread, in each moment of the approved prototype
// (.temp-code/prototypes/work-workspaces-2/meeting.html, its pick: the transcript with the player over it).
import type { Meeting } from "@shared/contract-work-meetings";
import type { CanvasItem, CanvasSource } from "@shared/work";
import { ChatFooter } from "../../surfaces/threads/chatSlots";
import { CanvasSeat } from "../canvas/CanvasSeat";
import { CANVAS } from "../canvas/registry";
import { SelectionTools } from "../canvas/SelectionBar";
import { applyCanvasPush, keepState } from "../canvas/store";
import { KindBar } from "../canvas/KindBar";
import { NO_FEEDS } from "../canvas/frame";
import { Button } from "../../components/ui/button";
import { Copy } from "../../chrome/icons";
import { seedMeeting } from "./data";
import type { MeetingState } from "./MeetingCanvas";
import { PlainName, PlayerRow, Turns } from "./MeetingView";
import { stretchOf } from "./model";
import type { Player } from "./player";
import { SAMPLE_NOTES, SAMPLE_SEGMENTS, sampleMeeting } from "./sample";

export type PreviewMoment = "read" | "notes" | "stretch" | "tasks" | "busy" | "empty" | "long" | "error";

// The kind's chunk is lazy: landed before the first render, so a static page draws it.
void CANVAS.meeting.chunk.load();

const T = (m: number, s: number): number => m * 60 + s;
const file: CanvasSource = { at: "file", host: "local", path: "/files/Staff sync, Nov 16.m4a" };

/** The three-hour summit, for Find and the h:mm:ss times. */
function summit(): Meeting {
  const said: [number, string, string][] = [
    [T(70, 2), "S1", "Before the break we said scheduling. After it, money: the travel stipend and the venue fund."],
    [T(72, 40), "S1", "The stipend moves to $400 a team for any event over 200 miles."],
    [T(73, 5), "S2", "Is that per event or per season? Michigan drives to four of them."],
    [T(73, 31), "S1", "Per event, capped at three a season. The stipend form is on the portal from January."],
    [T(74, 12), "S3", "Does the stipend cover a bus, or only mileage? We take a charter to Columbus."],
    [T(74, 40), "S1", "Either. Send the invoice with the stipend form and it's paid in 30 days."],
    [T(75, 22), "S2", "Then the venue fund. Who's hosting the spring finals?"],
  ];
  return sampleMeeting({
    itemId: "summit",
    title: "Big Ten esports summit, Nov 7",
    durationSec: 11_058,
    speakers: [
      { id: "S1", label: "Speaker 1", name: "Marcus Bell" },
      { id: "S2", label: "Speaker 2", name: "Jordan Kim" },
      { id: "S3", label: "Speaker 3", name: "Landon" },
    ],
    segments: said.map(([start, speaker, text], i) => ({ id: `s${i + 1}`, speaker, start, end: (said[i + 1]?.[0] ?? start + 30) - 0.5, text })),
  });
}

function meetingFor(moment: PreviewMoment): Meeting | null {
  switch (moment) {
    case "empty":
      return null;
    case "notes":
    case "tasks":
      return sampleMeeting({ notes: SAMPLE_NOTES });
    case "busy":
      return sampleMeeting({ status: "transcribing", segments: SAMPLE_SEGMENTS.slice(0, 4), progress: { phase: "words", done: T(14, 0), total: T(42, 10) } });
    case "error":
      return sampleMeeting({ status: "failed", segments: [], error: "It stopped at 9 of 42 minutes when tempcode-box restarted. The recording is fine." });
    case "long":
      return summit();
    default:
      return sampleMeeting();
  }
}

const still: Player = { position: T(15, 2), playing: false, loading: false, error: null, touched: true, rate: 1, playable: true, toggle: () => undefined, seek: () => undefined, setRate: () => undefined };

/** A stretch selected: drawn from the view's parts, since a static page holds no selection. The floating bar is drawn in place. */
function Stretch() {
  const m = sampleMeeting();
  const ids = ["s7", "s8", "s9"];
  const span = stretchOf(m.segments, ids)!;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <KindBar feeds={{ ...NO_FEEDS, mode: { value: "writes" } }} tools={<Button variant="ghost" size="icon-xs" aria-label="Find" className="text-muted-foreground" />} />
      <PlayerRow meeting={m} player={{ ...still, touched: false }} span={span} />
      <div className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div className="relative">
          <Turns
            meeting={{ ...m, segments: m.segments.slice(4, 12) }}
            current={null}
            hits={[]}
            hit={null}
            selected={ids}
            tasks={new Map()}
            currentTask={null}
            onSeek={() => undefined}
            onTask={() => undefined}
            name={(speaker) => <PlainName speakers={m.speakers} speaker={speaker} />}
          />
          <span className="absolute top-[110px] left-4 z-10 flex rounded-xl bg-popover p-1 text-sm whitespace-nowrap shadow-overlay ring-1 ring-border">
            <SelectionTools
              selection={{
                chip: { kind: "selection", label: "15:02 to 16:02, Staff sync, Nov 16", ref: file },
                rect: new DOMRect(),
                tools: (
                  <Button variant="ghost" size="xs" className="rounded-lg text-[13px]">
                    <Copy />
                    Copy
                  </Button>
                ),
              }}
              onAsk={() => undefined}
            />
          </span>
        </div>
      </div>
    </div>
  );
}

export function MeetingPreview({ moment = "read" }: { moment?: PreviewMoment }) {
  const sessionId = `preview-meeting-${moment}`;
  const meeting = meetingFor(moment);
  const itemId = meeting?.itemId ?? `${sessionId}-item`;
  const item: CanvasItem = {
    id: `${sessionId}-${itemId}`,
    sessionId,
    workspaceId: "ws",
    kind: "meeting",
    title: meeting?.title ?? "Meeting",
    source: meeting ? file : { at: "thread" },
    state: "open",
    position: 0,
    rev: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  if (meeting) seedMeeting("local", { ...meeting, itemId: item.id, sessionId });
  const kept: MeetingState = { tab: moment === "notes" ? "notes" : "transcript", find: moment === "long" ? { query: "stipend", index: 1 } : null };
  keepState(item.id, kept);
  applyCanvasPush({ sessionId, items: [item], opened: item.id });
  return (
    <div className="flex h-[640px] w-full overflow-hidden rounded-xl border border-border">
      {moment === "stretch" ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <Stretch />
        </div>
      ) : (
        <CanvasSeat session={{ id: sessionId, environmentId: "local" }}>
          <div className="flex min-h-0 flex-1 flex-col justify-end">
            <ChatFooter slots={{ transcript: null, strip: null, composer: null }} />
          </div>
        </CanvasSeat>
      )}
    </div>
  );
}
