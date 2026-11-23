import { memo, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { CSS_PER_POINT, type PdfDoc } from "../pdf/engine";

/** Whether an element is in its scroller's view, or near it; true where nothing lays out (a test, a static page). */
function useInView(ref: { current: Element | null }, margin = "200px"): boolean {
  const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => setSeen(entries.some((e) => e.isIntersecting)), { rootMargin: margin });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, margin]);
  return seen;
}

/**
 * Lets pdf.js free a page it drew. A render that was replaced (the deck changed) is destroyed before the pictures
 * that drew from it are let go, and pdf.js throws when a destroyed document is asked for a page: there is nothing
 * left to free, and the throw, from an effect's clean-up, took the whole canvas down ("It could not be shown").
 */
export function freePage(doc: PdfDoc | null, page: number): void {
  try {
    doc?.release(page);
  } catch {
    /* destroyed: nothing to free */
  }
}

/**
 * A slide at a width: the render's page, or while it comes (or with no
 * render) its title on a blank. A thumbnail paints only near the view, after
 * the stage, and lets pdf.js free the page when it leaves. A paint pdf.js
 * refuses on the stage says so in the slide's place, with Retry, as a PDF's
 * page does; a thumbnail stays a blank.
 */
export const Picture = memo(function Picture({
  doc,
  page,
  width,
  ghost = false,
  title,
  thumb = false,
  first = false,
  onPainted,
  onFailed,
}: {
  doc: PdfDoc | null;
  page: number;
  width: number;
  ghost?: boolean;
  title: string;
  thumb?: boolean;
  /** a thumbnail with no stage to wait for (the Sorter's): it paints as soon as it is near the view */
  first?: boolean;
  onPainted?(host: HTMLElement): void;
  onFailed?(): void;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [painted, setPainted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  const near = useInView(host);
  const size = doc?.size(page);
  const aspect = size ? size.width / size.height : 16 / 9;
  useEffect(() => {
    const el = host.current;
    if (!el || !doc || (thumb && !near)) return;
    const job = new AbortController();
    const scale = width / (doc.size(page).width * CSS_PER_POINT);
    const paint = (): void => {
      setFailed(false);
      doc.paint(page, el, scale, null, job.signal).then(
        () => {
          if (job.signal.aborted) return;
          setPainted(true);
          onPainted?.(el);
        },
        () => {
          if (job.signal.aborted || thumb) return;
          setFailed(true);
          onFailed?.();
        },
      );
    };
    // The stage asks first: a thumbnail waits a beat, so the one worker draws the big slide before the strip.
    const wait = thumb && !first ? setTimeout(paint, 60) : (paint(), undefined);
    return () => {
      clearTimeout(wait);
      job.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, width, thumb && near, tries]);
  useEffect(() => (doc && thumb && !near ? freePage(doc, page) : undefined), [doc, page, thumb, near]);
  useEffect(() => () => freePage(doc, page), [doc, page]);
  return (
    <span className={`relative block overflow-hidden rounded-[3px] bg-muted outline-1 -outline-offset-1 outline-(--image-outline) ${ghost ? "opacity-45" : ""}`} style={{ width, height: Math.round(width / aspect) }}>
      <span ref={host} data-slide-picture aria-hidden="true" className="absolute inset-0" />
      {!painted && !failed ? <span className="absolute inset-0 grid place-items-center overflow-hidden p-2 text-center text-xs leading-4 text-muted-foreground">{doc ? "" : title}</span> : null}
      {failed ? (
        <span data-slide-failed className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 text-[13px] leading-5 text-muted-foreground">
          Couldn't draw this slide
          <Button variant="ghost" size="xs" className="text-foreground" onClick={() => setTries((n) => n + 1)}>
            Retry
          </Button>
        </span>
      ) : null}
    </span>
  );
});
