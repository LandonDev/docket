import type { ComponentProps } from "react";
import { useDocumentVisible, usePaneVisible } from "@renderer/hooks/paneVisibility";
import { cn } from "@renderer/lib/cn";
import { SPINNER_TURN } from "@renderer/lib/ease";

function start(box: HTMLSpanElement): Animation {
  const animation = box.animate(SPINNER_TURN.keyframes, SPINNER_TURN.timing);
  // On the document timeline from 0, as the working mark and words are: every
  // spinner of a thread turns in phase, and a remount (or a turn started again
  // when the box comes back on screen) picks the turn up where it would be
  // instead of starting again at 0°.
  animation.startTime = 0;
  return animation;
}

/** Each mounted box and its running turn (null while it is off screen). */
const turning = new WeakMap<Element, Animation | null>();
let watcher: IntersectionObserver | undefined;

/** One observer for every spinner: a box that leaves the viewport (a row past
 *  the column's end, a collapsed rail) drops its turn, and takes it up again in
 *  phase when it comes back. Where there is none (tests), every box turns. */
function onScreenWatcher(): IntersectionObserver | null {
  if (watcher) return watcher;
  if (typeof IntersectionObserver !== "function") return null;
  watcher = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const box = entry.target as HTMLSpanElement;
      if (!turning.has(box)) continue;
      const running = turning.get(box);
      if (entry.isIntersecting) {
        if (!running) turning.set(box, start(box));
      } else if (running) {
        running.cancel();
        turning.set(box, null);
      }
    }
  });
  return watcher;
}

/** Turns the box around the arc as a Web Animation. Chromium leaves that to
 *  the compositor; a turn on the svg itself, CSS or Web Animation, made Blink
 *  run a main-thread frame at every display frame on macOS while any spinner
 *  showed: on a busy board, 35 of them took 37% of a core at 144 Hz, against
 *  13% for this form and 4.5% held still. It turns under reduced motion too:
 *  a turn in place is the sign of work, not movement (lib/motion.ts). It turns
 *  from the moment it mounts, as before; the observer then stops it if it is
 *  off screen. */
function turn(box: HTMLSpanElement | null): (() => void) | undefined {
  if (!box || typeof box.animate !== "function") return undefined;
  turning.set(box, start(box));
  const seen = onScreenWatcher();
  seen?.observe(box);
  return () => {
    seen?.unobserve(box);
    turning.get(box)?.cancel();
    turning.delete(box);
  };
}

/** The one indeterminate spinner: a 16px arc on a 900ms turn, in the
 *  current colour. Pair it with a word; never spin alone in empty space.
 *  The class sizes the box; the arc fills it. A line that must not move
 *  draws working as a dot instead (StatusMark `still`). It holds no running
 *  animation where no one can see it: in a parked pane, while the document is
 *  hidden, or off screen; it turns again, in phase, when it can be seen. */
function Spinner({ className, ...props }: ComponentProps<"span">) {
  const pane = usePaneVisible();
  const page = useDocumentVisible();
  const seen = pane && page;
  return (
    <span
      ref={seen ? turn : undefined}
      data-slot="spinner"
      data-turning=""
      role="status"
      aria-label="Loading"
      className={cn("inline-grid size-4 shrink-0 place-items-center", className)}
      {...props}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden className="size-full">
        <circle cx="12" cy="12" r="9" pathLength={100} strokeDasharray="72 100" className="origin-center -rotate-[135deg]" />
      </svg>
    </span>
  );
}

export { Spinner };
