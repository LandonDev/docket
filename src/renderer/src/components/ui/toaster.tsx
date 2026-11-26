import { lazy, Suspense, useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { toast as Toast, ToasterProps } from "sonner";
import { Info, X } from "@renderer/chrome/icons";
import { Spinner } from "./spinner";
import { StatusMark, type ThreadState } from "./status";
import { buttonVariants } from "./button";
import { cn } from "@renderer/lib/cn";
import { subscribeToastAnchor, toastAnchor, toastAnchorVersion, toastSeatOver } from "@renderer/lib/toastAnchor";

export type ToastApi = typeof Toast;

/** sonner rides its own chunk, out of the first paint: every toast goes
 *  through `loadToast().then((toast) => toast(…))`, and nothing else in
 *  src/renderer imports "sonner" for its values. */
let loading: Promise<ToastApi> | null = null;
export function loadToast(): Promise<ToastApi> {
  loading ??= import("sonner").then((m) => m.toast);
  return loading;
}

/** What a toast's raised button resets of sonner's own button (its fill, 4px
 *  radius, size and colour, which sonner writes on the element). */
const TOAST_BUTTON = "!h-6 !rounded-md !bg-transparent !px-2 !text-xs !font-medium !transition-[opacity] !duration-(--dur-fast)";
/** A toast's action and cancel, also for a toast that draws its own pair (a held approval, chrome/ApprovalToasts.tsx). */
export const TOAST_ACTION = cn(buttonVariants({ variant: "default", size: "xs" }), TOAST_BUTTON, "!text-primary-foreground");
export const TOAST_CANCEL = cn(buttonVariants({ variant: "secondary", size: "xs" }), TOAST_BUTTON, "!text-secondary-foreground");

const Sonner = lazy(() => import("sonner").then((m) => ({ default: m.Toaster })));

/** The stack's distance from the window's bottom and right edges, and a toast's width. */
export type ToastInset = { bottom: number; right: number; width: number };

/** Gap between the stack and the strip, and between the stack and the column's edge. */
const ABOVE = 8;
const INSIDE = 16;
/** A toast's width where its column has the room (sonner's `--width`). */
export const TOAST_WIDTH = 340;

/**
 * Where the stack sits so a toast never covers a control: 8px above the
 * anchor's top (the focused thread's strip, above its composer; a waiting
 * card over that strip, `seatRect`; a master board's foot while its chat is
 * folded) and 16px inside its right edge
 * (clear of the right panel), no wider than the column less 16px a side
 * (a master's chat beside its board is narrower than a toast); 16/16 from
 * the window's corner with no anchor. Never closer than 16px to either edge.
 */
export function toastInset(
  viewport: { width: number; height: number },
  anchor: { top: number; right: number; left?: number } | null,
): ToastInset {
  const corner = { bottom: INSIDE, right: INSIDE, width: TOAST_WIDTH };
  // A rect that is not a footer on screen (a side lost, a hidden or detached pane's zeros, one wholly off the
  // window) seats nothing: the stack takes the corner rather than offsets beyond the window.
  if (!anchor || !seen(viewport, anchor)) return corner;
  // The column as far as it shows: a part past the window's edge holds no toast.
  const right = Math.min(anchor.right, viewport.width);
  const room = anchor.left === undefined ? TOAST_WIDTH : Math.round(right - Math.max(anchor.left, 0) - 2 * INSIDE);
  const width = Math.max(0, Math.min(TOAST_WIDTH, room));
  return {
    bottom: clamp(Math.round(viewport.height - anchor.top + ABOVE), INSIDE, viewport.height - INSIDE),
    right: clamp(Math.round(viewport.width - right + INSIDE), INSIDE, viewport.width - width - INSIDE),
    width,
  };
}

function seen(viewport: { width: number; height: number }, anchor: { top: number; right: number; left?: number }): boolean {
  const left = anchor.left ?? 0;
  if (![anchor.top, anchor.right, left].every(Number.isFinite)) return false;
  return anchor.top > 0 && anchor.top <= viewport.height && anchor.right > 0 && left < viewport.width && anchor.right > left;
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(value, Math.max(low, high)));

function viewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

type Rect = { top: number; bottom: number; left: number; right: number };

/**
 * What the stack sits above: a waiting card while it is wholly in view in its
 * scroller (its top from the card, its sides from the anchor's column), else
 * the anchor itself. A card scrolled out of view, cut by the scroller's edge
 * or folded shut seats nothing, and the footer takes the stack back. The
 * stack (`stack` px tall) never rises above 8px under the scroller's top, so
 * over a card that fills the transcript it lies on the card's empty upper
 * edge, never over the title bar; where it cannot fit in the scroller at all
 * the footer takes it.
 */
export function seatRect(anchor: Rect, card: Rect | null, view: { top: number; bottom: number } | null, stack = 0): Rect {
  if (!card || card.bottom - card.top <= 0 || card.top >= anchor.top) return anchor;
  if (view && (card.top < view.top || card.bottom > view.bottom + 1)) return anchor;
  const top = view ? Math.max(card.top, view.top + ABOVE + stack + ABOVE) : card.top;
  if (top >= anchor.top) return anchor;
  // Named, not spread: a DOMRect's sides are getters on its prototype, and a spread of one has no right edge.
  return { top, bottom: anchor.bottom, left: anchor.left, right: anchor.right };
}

/** The resting stack's height: the front toast and the 8px edge of each one behind it. */
export function stackHeight(toaster: Element | null): number {
  const front = toaster?.querySelector<HTMLElement>('[data-sonner-toast][data-front="true"]');
  if (!front) return 0;
  const behind = toaster!.querySelectorAll('[data-sonner-toast][data-visible="true"]:not([data-removed="true"])').length - 1;
  return front.offsetHeight + Math.max(0, behind) * ABOVE;
}

/** The nearest ancestor that scrolls: the transcript a card sits in. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/** The measured inset for the current anchor, kept as it resizes or moves. */
function useToastInset(toaster: HTMLElement | null): ToastInset {
  const version = useSyncExternalStore(subscribeToastAnchor, toastAnchorVersion, () => 0);
  const [inset, setInset] = useState<ToastInset>({ bottom: INSIDE, right: INSIDE, width: TOAST_WIDTH });
  useEffect(() => {
    const anchor = toastAnchor();
    const card = anchor ? toastSeatOver(anchor) : null;
    const scroller = card ? scrollerOf(card) : null;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = anchor ? seatRect(anchor.getBoundingClientRect(), card?.getBoundingClientRect() ?? null, scroller?.getBoundingClientRect() ?? null, card ? stackHeight(toaster) : 0) : null;
        const next = toastInset(viewport(), rect);
        setInset((prev) => (prev.bottom === next.bottom && prev.right === next.right && prev.width === next.width ? prev : next));
      });
    };
    measure();
    // The footer grows with the composer; its column narrows when a panel opens; a card grows and scrolls.
    const observer = anchor && typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (anchor) {
      observer?.observe(anchor);
      if (anchor.parentElement) observer?.observe(anchor.parentElement);
    }
    if (card) observer?.observe(card);
    // Over a card the stack's own height sets its seat: measure again as toasts come, go or change.
    const toasts = card && toaster && typeof MutationObserver !== "undefined" ? new MutationObserver(measure) : null;
    if (toaster) toasts?.observe(toaster, { childList: true, subtree: true });
    // A popup seat (the composer's menu) rises 4px on a transform no observer sees: measure again where it lands.
    card?.addEventListener("transitionend", measure);
    scroller?.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      toasts?.disconnect();
      card?.removeEventListener("transitionend", measure);
      scroller?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [version, toaster]);
  return inset;
}

/** A toast's glyph in the status vocabulary (docs/DESIGN.md): a toast that
 *  needs the person is waiting's amber ring-dot, a failure failed's red
 *  ring with a bang, a success done's muted check. The title says the words,
 *  so the glyph is hidden from assistive tech. */
function ToastGlyph({ state }: { state: ThreadState }) {
  return (
    <span aria-hidden data-toast-glyph={state} className="contents">
      <StatusMark state={state} word={false} />
    </span>
  );
}

/** The one toast stack (sonner), mounted once in main.tsx. A toast is one
 *  line, an optional second line, at most one action, and leaves on its own;
 *  a held ask (an approval, a computer's Allow, a Mac bridge card) is the one
 *  kind with two presses that stays until answered (docs/DESIGN.md
 *  "Restraint"). It sits above the focused thread's strip, never over a control. */
export function Toaster(props: ToasterProps) {
  const [toaster, setToaster] = useState<HTMLElement | null>(null);
  const { width, ...offset } = useToastInset(toaster);
  return (
    <Suspense fallback={null}>
      <Sonner
        ref={setToaster}
        position="bottom-right"
        gap={8}
        offset={offset}
        mobileOffset={offset}
        visibleToasts={4}
        icons={{
          success: <ToastGlyph state="done" />,
          info: <Info className="size-3.5" />,
          warning: <ToastGlyph state="waiting" />,
          error: <ToastGlyph state="failed" />,
          loading: <Spinner className="size-3.5" />,
          // The app's own X (chrome/icons), not sonner's 12px one.
          close: <X className="size-3.5" />,
        }}
        toastOptions={{
          unstyled: false,
          classNames: {
            // The glyph sits on the title's first line, not the middle of two.
            // A closable toast keeps its words clear of the close: 8px in, 24px wide, 8px after.
            toast: "!items-start !gap-2 !rounded-xl !border-0 !bg-popover !text-popover-foreground !shadow-overlay !ring-1 !ring-border !text-[13px] has-[[data-close-button]]:!pe-10",
            title: "!font-medium !leading-5",
            description: "!text-xs !leading-4 !text-muted-foreground",
            // The glyph's own box, 8px from the title (the toast's gap), not sonner's 16px box and margins.
            // At least the 14px glyph column: sonner's loader is absolute and would leave the slot 0px wide.
            icon: "!h-5 !w-auto !min-w-3.5 !m-0",
            // A 24px ghost at the top right, centred on the title's line (sonner's 16px inset
            // plus half the 20px line, less half the 24px button: 14px): no circle, no second
            // focus band, no timing of sonner's.
            closeButton:
              "!left-auto !right-2 !top-3.5 !size-6 !transform-none !rounded-md !border-0 !bg-transparent !shadow-none !text-muted-foreground hover:!bg-foreground/7 hover:!text-foreground !transition-none",
            // Our raised buttons: sonner's own button paints a background, a 4px radius
            // and its own sizes, so those are reset for the raise's fill layer to show.
            actionButton: TOAST_ACTION,
            cancelButton: TOAST_CANCEL,
          },
        }}
        style={
          {
            "--normal-bg": "var(--popover)",
            "--normal-text": "var(--popover-foreground)",
            "--normal-border": "var(--border)",
            "--border-radius": "var(--radius-xl)",
            "--width": `${width}px`,
          } as CSSProperties
        }
        {...props}
      />
    </Suspense>
  );
}
