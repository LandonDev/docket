// A preview frame for `bun run ui:preview src/renderer/src/work/slides/show/Show.preview.tsx#ShowPreview --shot`:
// the two surfaces of a show on the canvas preview's sponsor deck, drawn in place of pdf.js.
import { SPONSOR, sponsorDoc } from "../SlidesCanvas.preview.fixtures";
import { Audience } from "./Audience";
import { Presenter } from "./Presenter";
import { StageContext, type ShowStage } from "./stage";
import { NOTES_DEFAULT, startShowState, type ShowState, type Slide } from "./state";
import { startTimer } from "./timer";

export type ShowMoment = "first" | "build" | "end" | "gone" | "loading" | "narrow" | "bar" | "picker" | "over" | "video";

const NOW = new Date(2026, 10, 23, 14, 2, 0).getTime();
const NOTES: Record<number, string> = {
  1: "Welcome everyone. Thank the sponsors who came back from last year before anything else.",
  4: "Open with the turnout: 480 players and 6,200 on stream. Say the stream figure is from Twitch's own count, then go through the three packages one at a time.",
};
const CLIP = { shape: 9, kind: "video" as const, quad: [[0.55, 0.3], [0.92, 0.3], [0.92, 0.75], [0.55, 0.75]] as NonNullable<Slide["media"]>[number]["quad"], file: { rev: "0123456789abcdef", size: 1, type: "video/mp4" } };
const slides: Slide[] = SPONSOR.map((s, i) => ({ id: 256 + i, number: i + 1, page: i + 1, title: s.title, notes: NOTES[i + 1] ?? "", hidden: i === 5, ...(i === 3 ? { builds: 4 } : {}), ...(i === 2 ? { media: [CLIP] } : {}) }));
/** A stage whose one clip is read and paused 12 s in: the transport as he finds it after pausing. */
/** How long the preview's clip runs, in seconds: a length of film, not a motion value. */
const CLIP_SECONDS = 64;
const stage: ShowStage = {
  pictureOf: (slide) => ({ doc, page: slide.page, waiting: false }),
  motion: null,
  motionKey: "",
  media: { url: () => "about:blank", playing: () => ({ playing: false, started: false, time: 12, duration: CLIP_SECONDS, seek: null }), act: () => undefined, heard: "audience" },
};
const doc = sponsorDoc(SPONSOR.map((_, i) => i + 1));

function stateOf(moment: ShowMoment): ShowState {
  const base = startShowState(slides, "start");
  if (moment === "build" || moment === "picker" || moment === "bar") return { ...base, at: 3, step: 1, picker: moment === "picker" };
  if (moment === "end") return { ...base, at: slides.length - 1 };
  if (moment === "over") return { ...base, at: slides.length - 1, ended: true };
  if (moment === "gone") return { ...base, at: 2, blank: true };
  if (moment === "video") return { ...base, at: 2 };
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
    <StageContext.Provider value={stage}>
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
    </StageContext.Provider>
  );
}
