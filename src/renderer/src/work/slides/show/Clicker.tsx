import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ShowLive, ShowPressAct } from "@shared/contract-work-slides";
import { Button } from "../../../components/ui/button";
import { Toggle } from "../../../components/ui/toggle";
import { ChevronLeft, ChevronRight, Pause, Play } from "../../../chrome/icons";
import { sayError } from "../../canvas/frame";
import { isOwnShow, useLiveShows, type ShowRemote } from "./remote";
import { clockOf, overTarget } from "./timer";

/**
 * The clicker (docs/DESIGN.md "The show", "The clicker"; the approved page is
 * .temp-code/prototypes/work-editors/present.html, "The phone, as a clicker"): while a show of the deck runs on
 * another of his devices, the app's own page at phone width shows this in place of the deck. Next is the lower
 * part of the screen; Previous over it; the notes of the slide shown; the time and the place; Blank and End.
 * Every press goes to the window that runs the show, with the state it was made on (remote.ts).
 */

/** At most this wide, the page is a phone's: the deck's item there is the clicker while a show runs. */
export const CLICKER_WIDTH = 640;
const QUERY = `(max-width: ${CLICKER_WIDTH}px)`;

function usePhoneWidth(): boolean {
  return useSyncExternalStore(
    (on) => {
      const query = window.matchMedia?.(QUERY);
      query?.addEventListener("change", on);
      return () => query?.removeEventListener("change", on);
    },
    () => window.matchMedia?.(QUERY).matches ?? false,
    () => false,
  );
}

/** The show of this deck a phone-width page steps, if one runs elsewhere. */
export function useClickerShow(remote: ShowRemote | undefined): ShowLive | null {
  const phone = usePhoneWidth();
  const shows = useLiveShows(phone && remote ? remote : null);
  return phone ? (shows.find((s) => !isOwnShow(s.showId)) ?? null) : null;
}

/** The time he has talked, counted on here between the host's words. */
function useElapsed(live: ShowLive): number {
  const [since, setSince] = useState(() => ({ live, at: Date.now() }));
  if (since.live !== live) setSince({ live, at: Date.now() });
  const [, tick] = useState(0);
  useEffect(() => {
    if (live.timer.paused) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [live.timer.paused]);
  return live.timer.paused ? live.timer.elapsed : live.timer.elapsed + Math.max(0, Date.now() - since.at);
}

const PRESS = "transition-[scale] duration-(--dur-fast) ease-(--ease-out) active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100";

/** `contained`: a preview's, drawn in its own box rather than over the page. */
export function Clicker({ live, remote, contained = false }: { live: ShowLive; remote: ShowRemote; contained?: boolean }) {
  const elapsed = useElapsed(live);
  const press = (act: ShowPressAct): void => {
    // A press on a state that moved on is dropped by the host; the state as it is now arrives by the push.
    remote.press(live.showId, act, live.rev).catch((e: unknown) => sayError(e, "Couldn't reach the show"));
  };
  const { next, timer } = live;
  const over = overTarget(elapsed, timer.target);
  const first = live.slide <= 1 && live.step === 0 && !live.ended && !live.blank;
  // What the next press brings, at the top of Next: the next slide with its title, the slide's next build, the end.
  const coming =
    next.kind === "slide" ? (
      <>
        <span className="text-[15px] leading-5 text-muted-foreground tabular-nums">Slide {next.number}</span>
        <span className="line-clamp-3 text-[22px] leading-7 font-semibold tracking-[-0.01em] text-pretty">{next.title || "Untitled"}</span>
      </>
    ) : next.kind === "build" ? (
      <>
        <span className="text-[15px] leading-5 text-muted-foreground">This slide</span>
        <span data-clicker-build className="text-[22px] leading-7 font-semibold tracking-[-0.01em] tabular-nums">
          Build {next.step} of {next.of}
        </span>
      </>
    ) : next.kind === "end" ? (
      <span className="text-[22px] leading-7 font-semibold tracking-[-0.01em] text-muted-foreground">End of show</span>
    ) : null;
  const nextLabel = next.kind === "build" ? `Next: build ${next.step} of ${next.of}` : next.kind === "slide" ? `Next: slide ${next.number}${next.title ? `, ${next.title}` : ""}` : next.kind === "end" ? "Next: end of show" : "Close the show";

  const clicker = (
    <section
      data-clicker
      aria-label={`Clicker: ${live.title}`}
      className={`${contained ? "absolute" : "fixed"} inset-0 z-(--layer-dialog) flex touch-manipulation flex-col overflow-hidden overscroll-none bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] text-foreground select-none`}
    >
      <header className="grid h-11 shrink-0 grid-cols-[1fr_auto_1fr] items-center px-2">
        <Button variant="ghost" className="h-11 justify-self-start px-3 text-[17px]" onClick={() => press("end")}>
          End
        </Button>
        <h1 className="max-w-[50vw] truncate text-[17px] leading-[22px] font-semibold">{live.title}</h1>
        <Toggle className="h-11 justify-self-end rounded-lg px-3 text-[17px] text-foreground data-pressed:bg-foreground data-pressed:text-background" pressed={live.blank} disabled={live.ended} onPressedChange={() => press("blank")}>
          Blank
        </Toggle>
      </header>

      <div className="flex h-11 shrink-0 items-center gap-1 pr-4 pl-2">
        <button
          type="button"
          data-clicker-timer
          aria-label={timer.paused ? "Resume the timer" : "Pause the timer"}
          onClick={() => press(timer.paused ? "resume" : "pause")}
          className={`flex h-11 items-center gap-2 rounded-lg px-2 ${PRESS}`}
        >
          {timer.paused ? <Play className="size-[18px] fill-current" /> : <Pause className="size-[18px] fill-current" />}
          <span data-clicker-elapsed className={`text-[17px] leading-[22px] font-semibold tabular-nums ${over ? "text-warning" : ""}`}>
            {clockOf(elapsed)}
          </span>
          {timer.target !== null ? <span className="text-[15px] leading-5 text-muted-foreground tabular-nums">of {clockOf(timer.target * 60_000)}</span> : null}
        </button>
        <span data-clicker-place aria-live="polite" className="ml-auto text-[15px] leading-5 text-muted-foreground tabular-nums">
          {live.ended ? "End" : `${live.slide} / ${live.count}`}
        </span>
      </div>

      <p
        data-clicker-notes
        tabIndex={0}
        aria-label="Notes"
        className={`focus-ring min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pt-2 pb-3 text-base leading-6 text-pretty whitespace-pre-wrap select-text ${live.notes ? "" : "text-muted-foreground"}`}
      >
        {live.ended ? "" : live.notes || "No notes"}
      </p>

      <button type="button" data-clicker-prev disabled={first} onClick={() => press("prev")} className={`mx-3 mb-2 flex h-14 shrink-0 items-center justify-center gap-1.5 rounded-2xl bg-muted text-[17px] leading-[22px] font-medium disabled:text-faint-foreground ${PRESS}`}>
        <ChevronLeft className="size-[18px]" />
        Previous
      </button>
      <button
        type="button"
        data-clicker-next
        aria-label={nextLabel}
        onClick={() => press("next")}
        className={`mx-3 mb-[max(16px,env(safe-area-inset-bottom))] flex h-[42dvh] min-h-44 shrink-0 flex-col justify-between rounded-[32px] bg-card p-5 text-start ring-1 ring-border ring-inset ${PRESS}`}
      >
        <span className="flex min-h-0 flex-col gap-1">{coming}</span>
        <span className="flex items-center gap-1.5">
          <span className="text-[22px] leading-7 font-semibold tracking-[-0.01em]">{next.kind === "close" ? "Close the show" : "Next"}</span>
          {next.kind === "close" ? null : <ChevronRight className="size-5" />}
        </span>
      </button>
    </section>
  );
  return contained ? clicker : createPortal(clicker, document.body);
}
