// A preview frame for `bun run ui:preview src/renderer/src/work/slides/show/Clicker.preview.tsx#ClickerPreview --width 390 --shot`:
// the phone's clicker for a running show, at 390 by 844, in the moments it has.
import type { ShowLive } from "@shared/contract-work-slides";
import { Clicker } from "./Clicker";
import type { ShowRemote } from "./remote";

export type ClickerMoment = "slide" | "build" | "blank" | "end" | "over";

const NOTES =
  "Open with the turnout: 480 players and 6,200 on stream. Say the stream figure is from Twitch's own count.\n\nThen go through the three packages one at a time: Gold first, then Silver, then the community tier. Leave the price for last and pause before it.";

const base: ShowLive = {
  showId: "show-preview01",
  itemId: "deck1",
  title: "Sponsor deck",
  rev: 1,
  slide: 4,
  count: 12,
  step: 0,
  steps: 0,
  next: { kind: "slide", number: 5, title: "Packages and what each one includes" },
  notes: NOTES,
  timer: { elapsed: 12 * 60_000 + 40_000, paused: false, target: 20 },
  blank: false,
  ended: false,
};

const MOMENTS: Record<ClickerMoment, Partial<ShowLive>> = {
  slide: {},
  build: { step: 1, steps: 4, next: { kind: "build", step: 2, of: 4 }, timer: { elapsed: 21 * 60_000 + 12_000, paused: true, target: 20 } },
  blank: { blank: true },
  end: { slide: 12, next: { kind: "end" }, notes: "", timer: { elapsed: 18 * 60_000, paused: false, target: null } },
  over: { slide: 12, ended: true, next: { kind: "close" }, notes: "" },
};

const remote: ShowRemote = { itemId: "deck1", run: async () => ({ press: null }), state: async () => [], press: async () => ({ applied: true, live: null }), onLive: () => () => undefined };

export function ClickerPreview({ moment = "slide" }: { moment?: ClickerMoment }) {
  return (
    <div className="relative h-[844px] w-[390px] overflow-hidden">
      <Clicker live={{ ...base, ...MOMENTS[moment] }} remote={remote} contained />
    </div>
  );
}
