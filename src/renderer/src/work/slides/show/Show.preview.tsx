// A preview frame for `bun run ui:preview src/renderer/src/work/slides/show/Show.preview.tsx#ShowPreview --shot`:
// the two surfaces of a show on the canvas preview's sponsor deck, drawn in place of pdf.js.
import { SPONSOR, sponsorDoc } from "../SlidesCanvas.preview.fixtures";
import { Audience } from "./Audience";
import { Presenter } from "./Presenter";
import { NOTES_DEFAULT, startShowState, type ShowState, type Slide } from "./state";
import { startTimer } from "./timer";

export type ShowMoment = "first" | "build" | "end" | "gone" | "loading" | "narrow" | "bar" | "picker" | "over";

const NOW = new Date(2026, 10, 23, 14, 2, 0).getTime();
const NOTES: Record<number, string> = {
  1: "Welcome everyone. Thank the sponsors who came back from last year before anything else.",
  4: "Open with the turnout: 480 players and 6,200 on stream. Say the stream figure is from Twitch's own count, then go through the three packages one at a time.",
};
const slides: Slide[] = SPONSOR.map((s, i) => ({ id: 256 + i, number: i + 1, page: i + 1, title: s.title, notes: NOTES[i + 1] ?? "", hidden: i === 5, ...(i === 3 ? { builds: 4 } : {}) }));
const doc = sponsorDoc(SPONSOR.map((_, i) => i + 1));

function stateOf(moment: ShowMoment): ShowState {
  const base = startShowState(slides, "start");
  if (moment === "build" || moment === "picker" || moment === "bar") return { ...base, at: 3, step: 1, picker: moment === "picker" };
  if (moment === "end") return { ...base, at: slides.length - 1 };
  if (moment === "over") return { ...base, at: slides.length - 1, ended: true };
  if (moment === "gone") return { ...base, at: 2, blank: true };
  if (moment === "loading") return startShowState([], "start");
  return base;
}

export function ShowPreview({ moment = "first" }: { moment?: ShowMoment }) {
  const state = stateOf(moment);
  const none = (): void => undefined;
  if (moment === "bar" || moment === "picker" || moment === "over") {
    return (
      <div className="h-[360px] w-[640px] overflow-hidden rounded-sm">
        <Audience state={state} dispatch={none} doc={doc} room={{ width: 640, height: 360 }} barOn={moment !== "over"} />
      </div>
    );
  }
  const room = moment === "narrow" ? { width: 400, height: 700 } : { width: 864, height: 540 };
  return (
    <div className="overflow-hidden rounded-xl border border-border" style={room}>
      <Presenter
        state={state}
        dispatch={none}
        doc={moment === "loading" ? null : doc}
        loading={moment === "loading"}
        notice={moment === "gone" ? "The slideshow's display was disconnected" : null}
        timer={startTimer(NOW - (moment === "build" ? 21 * 60_000 + 12_000 : 247_000))}
        target={moment === "first" ? null : 20}
        onTimer={none}
        onTarget={none}
        notesSize={NOTES_DEFAULT}
        onNotesSize={none}
        now={() => NOW}
        room={room}
      />
    </div>
  );
}
