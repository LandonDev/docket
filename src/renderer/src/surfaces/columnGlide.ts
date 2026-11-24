import { useLayoutEffect, useRef, type RefObject } from "react";
import { useReducedMotion } from "../lib/motion";
import { DUR, EASE_OUT_CSS } from "../lib/ease";
import { columnShift, type OutlinePlacement } from "./transcriptOutlineModel";

/**
 * The column's glide when the message list folds or opens beside it. The
 * layout moves the column once (its width too, under 1032px, so the rows
 * measure once and the reading place holds); then a transform carries it
 * from where it stood, on the list's own timing (out in --dur-fast, back in
 * --dur-base, both --ease-out), so the column and the sliding list never
 * meet. The distance comes from the model (`columnShift`) at the pane's
 * width, which the caller reads (`paneWidth`), never from a measure of the
 * column. A glide caught mid-way starts from where the column is. Nothing glides
 * under reduced motion, without the Web Animations API, or when the
 * placement itself changed: a resize across a threshold snaps.
 */
export function useColumnGlide(
  ref: RefObject<HTMLElement | null>,
  placement: OutlinePlacement,
  beside: boolean,
  paneWidth: () => number,
): void {
  const reduce = useReducedMotion();
  const last = useRef({ placement, beside });
  const running = useRef<{ animation: Animation; from: number } | null>(null);
  const width = useRef(paneWidth);
  width.current = paneWidth;
  useLayoutEffect(() => {
    const prev = last.current;
    last.current = { placement, beside };
    if (prev.beside === beside) return;
    const el = ref.current;
    const was = running.current;
    running.current = null;
    // Where a glide caught mid-way has the column now: its eased progress
    // of the way from its start to none.
    const left = was ? was.from * (1 - (was.animation.effect?.getComputedTiming().progress ?? 1)) : 0;
    was?.animation.cancel();
    if (!el || typeof el.animate !== "function" || reduce || prev.placement !== "beside" || placement !== "beside") return;
    const from = columnShift(width.current(), prev.beside, beside) + left;
    const animation = el.animate([{ transform: `translateX(${from}px)` }, { transform: "none" }], {
      duration: (beside ? DUR.base : DUR.fast) * 1000,
      easing: EASE_OUT_CSS,
    });
    running.current = { animation, from };
    animation.onfinish = () => {
      if (running.current?.animation === animation) running.current = null;
    };
  }, [ref, placement, beside, reduce]);
}
